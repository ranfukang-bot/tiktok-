// Codex 复查发现的四个跨流程问题的回归测试。
// 这四个都不是"节点判断算错了"，而是【判断之后到真正发布之间】那段路上的问题，
// 原来的节点测试全都覆盖不到。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertSlotStillOpen,
  creditedSlotOnConfirm,
  currentDayKey,
  slotTargetsForDay,
} from '../src/dailyQuota.js';
import { resolveTimezone } from '../src/config.js';
import { tick } from '../src/orchestrator.js';

// ===== 1. 上传跨过截止时间 =====
// 12:29 开始上传，上传和双绿检查花了几分钟，12:32 才轮到点"发布"。
// 进流程时没过点，不代表现在没过点。
test('上传跨过节点截止时间：点发布之前要拦住', () => {
  const slot = { key: '11:30', start: '11:30', end: '12:30', endMs: Date.UTC(2026, 8, 12, 5, 30) };
  // 还在窗口里：放行
  assert.doesNotThrow(() => assertSlotStillOpen(slot, slot.endMs - 1));
  // 过点了：拦住
  assert.throws(() => assertSlotStillOpen(slot, slot.endMs), /11:30-12:30/);
  assert.throws(() => assertSlotStillOpen(slot, slot.endMs + 60000), /过点不发/);
  // 时段模式下没有节点，永远放行
  assert.doesNotThrow(() => assertSlotStillOpen(null, Date.now()));
});

test('过点放弃必须带 slotExpired 标记，否则会被当成故障暂停账号', () => {
  // 这个标记决定了调用方是"安静跳过"还是"记一次失败"。攒够失败次数账号会被
  // 暂停并推送通知——可这根本不是故障，只是时间到了不发而已。
  const slot = { key: '11:30', start: '11:30', end: '12:30', endMs: 1000 };
  try {
    assertSlotStillOpen(slot, 2000);
    assert.fail('应该抛错');
  } catch (err) {
    assert.equal(err.slotExpired, true);
  }
});

test('过点检查必须排在"已尝试发布"之前', () => {
  // 顺序反了的话，在这里中断会被分类成"可能已经点过发布按钮"，账号会被暂停
  // 等人确认——可我们恰恰是还没点。这条只能靠读源码盯住。
  const src = readFileSync(new URL('../src/orchestrator.js', import.meta.url), 'utf8');
  const guard = src.indexOf('assertSlotStillOpen(slot, Date.now())');
  const attempted = src.indexOf('publishAttempted = true', guard);
  assert.ok(guard > 0, '找不到过点检查');
  assert.ok(attempted > guard, '过点检查必须在 publishAttempted 置true之前');
});

// ===== 2. 人工确认要用账号自己的时区 =====
test('人工确认按账号自己的时区算当天日期，不能回退到全局时区', () => {
  const settings = { timezone: 'Asia/Jakarta' };          // 全局印尼 UTC+7
  const account = { name: '菲律宾1号', timezone: 'Asia/Manila' }; // 账号菲律宾 UTC+8
  assert.equal(resolveTimezone(settings, account), 'Asia/Manila');
  // 之前这里传的是 { name: accountName }，账号的 timezone 被丢掉，退回全局时区。
  // 丢掉之后是什么后果：菲律宾时间刚过午夜时，两个时区算出来的"今天"差一天，
  // pendingSlot.dayKey 对不上，节点就记不上账，恢复后会在同一个节点再发一条。
  assert.equal(resolveTimezone(settings, { name: account.name }), 'Asia/Jakarta');
  const atMidnightManila = new Date(Date.UTC(2026, 8, 12, 16, 30)); // 马尼拉 9/13 00:30，雅加达 9/12 23:30
  const dayIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(atMidnightManila);
  assert.notEqual(dayIn('Asia/Manila'), dayIn('Asia/Jakarta'), '这个时刻两个时区确实不同天');
});

// ===== 3. 延迟确认要按原节点记账 =====
test('中午发的卡住，晚上才确认：占掉的是中午那个节点，不是晚上的', () => {
  const pending = { key: '11:30', dayKey: '2026-09-12', start: '11:30', end: '12:30' };
  // 同一天晚上19:45来确认 —— 记的还是中午那个节点
  assert.equal(creditedSlotOnConfirm(pending, '2026-09-12'), '11:30');
});

test('跨天之后才确认：不能占用新一天同名的节点', () => {
  const pending = { key: '11:30', dayKey: '2026-09-12' };
  assert.equal(creditedSlotOnConfirm(pending, '2026-09-13'), null);
});

test('时段模式下没有 pendingSlot，不记任何节点', () => {
  assert.equal(creditedSlotOnConfirm(null, '2026-09-12'), null);
  assert.equal(creditedSlotOnConfirm({}, '2026-09-12'), null);
});

// ===== 4. 旧的随机间隔不能挡住节点 =====
// 从时段模式升级过来的状态文件里留着一个几小时后的 nextTime，
// 会把整个节点窗口白白挡掉。
const ACCOUNT = '节点回归测试号';
const STATE_FILE = path.join(import.meta.dirname, '..', 'state', `${ACCOUNT}.json`);

test('状态里留着旧的随机间隔时，节点模式照样能发', async () => {
  const videoDir = mkdtempSync(path.join(tmpdir(), 'slot-regression-'));
  writeFileSync(path.join(videoDir, '123456.mp4'), 'fake');
  const account = { name: ACCOUNT, browser: 'fake', browserId: 'x1', videoFolder: videoDir, timezone: 'Asia/Jakarta' };
  try {
    // 造一个"此刻正好在窗口里"的节点：长度1分钟，所以抖动固定为0，目标时刻=开始时刻
    const now = new Date();
    const hhmm = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(now);
    const [h, m] = hhmm.split(':').map(Number);
    const endMin = h * 60 + m + 1;
    const pad = (x) => String(x).padStart(2, '0');
    const slots = [{ start: hhmm, end: `${pad(Math.floor(endMin / 60) % 24)}:${pad(endMin % 60)}` }];
    // 自检：这个节点此刻确实该发
    const target = slotTargetsForDay({
      dayKey: currentDayKey('Asia/Jakarta'), timezone: 'Asia/Jakarta', slots, accountName: ACCOUNT,
    })[0];
    assert.ok(Date.now() >= target.targetMs && Date.now() < target.endMs, '夹具没造对，节点此刻不该发');

    const settings = {
      minIntervalMs: 1, maxIntervalMs: 2, folderScanIntervalMs: 1000, videoExtensions: ['.mp4'],
      hashtagKeywords: ['fyp'], dailyPublishLimit: 4, timezone: 'Asia/Jakarta',
      postingSlots: { enabled: true, slots }, retryBackoffMs: [1000], notifications: { enabled: false },
    };

    // 先让 tick 扫一遍把视频放进队列，然后塞一个三小时后的 nextTime（模拟从时段模式升级过来）
    let calls = 0;
    const adapter = { async startProfile() { calls += 1; throw new Error('测试到此为止，能走到这一步就说明闸门放行了'); } };
    await tick(settings, [account], new Map([['fake', adapter]]));
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    state.nextTime = Date.now() + 3 * 3600 * 1000;
    state.retryAt = null;
    state.consecutiveFailures = 0;
    state.paused = false;
    state.slotsUsedToday = [];
    state.pendingIndex = null;
    writeFileSync(STATE_FILE, JSON.stringify(state));

    calls = 0;
    await tick(settings, [account], new Map([['fake', adapter]]));
    assert.equal(calls, 1, '旧的 nextTime 不该挡住节点模式的发布');
  } finally {
    rmSync(videoDir, { recursive: true, force: true });
    rmSync(STATE_FILE, { force: true });
  }
});

test('时段模式下，随机间隔照旧生效', async () => {
  const videoDir = mkdtempSync(path.join(tmpdir(), 'slot-regression2-'));
  writeFileSync(path.join(videoDir, '123456.mp4'), 'fake');
  const account = { name: ACCOUNT, browser: 'fake', browserId: 'x1', videoFolder: videoDir };
  try {
    const settings = {
      minIntervalMs: 1, maxIntervalMs: 2, folderScanIntervalMs: 1000, videoExtensions: ['.mp4'],
      hashtagKeywords: ['fyp'], dailyPublishLimit: 4, timezone: 'Asia/Jakarta',
      postingSlots: { enabled: false }, postingWindow: { enabled: false },
      retryBackoffMs: [1000], notifications: { enabled: false },
    };
    let calls = 0;
    const adapter = { async startProfile() { calls += 1; throw new Error('测试到此为止'); } };
    await tick(settings, [account], new Map([['fake', adapter]]));
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    state.nextTime = Date.now() + 3 * 3600 * 1000;
    state.retryAt = null; state.consecutiveFailures = 0; state.paused = false; state.pendingIndex = null;
    writeFileSync(STATE_FILE, JSON.stringify(state));

    calls = 0;
    await tick(settings, [account], new Map([['fake', adapter]]));
    assert.equal(calls, 0, '时段模式下 nextTime 还是要拦住');
  } finally {
    rmSync(videoDir, { recursive: true, force: true });
    rmSync(STATE_FILE, { force: true });
  }
});
