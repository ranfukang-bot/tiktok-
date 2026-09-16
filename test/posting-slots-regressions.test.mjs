// Codex 复查发现的四个跨流程问题的回归测试。
// 这四个都不是"节点判断算错了"，而是【判断之后到真正发布之间】那段路上的问题，
// 原来的节点测试全都覆盖不到。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertSlotCanStartUpload,
  creditedSlotOnConfirm,
  currentDayKey,
  slotTargetsForDay,
} from '../src/dailyQuota.js';
import { resolveTimezone } from '../src/config.js';
import { tick } from '../src/orchestrator.js';

// ===== 1. 截止时间只限制开始上传（新规则） =====
test('开始上传前过点要拦住，节点内允许开始', () => {
  const slot = { key: '11:30', start: '11:30', end: '12:30', endMs: Date.UTC(2026, 8, 12, 5, 30) };
  // 还在窗口里：放行
  assert.doesNotThrow(() => assertSlotCanStartUpload(slot, slot.endMs - 1));
  // 过点了：拦住
  assert.throws(() => assertSlotCanStartUpload(slot, slot.endMs), /11:30-12:30/);
  assert.throws(() => assertSlotCanStartUpload(slot, slot.endMs + 60000), /不再新开上传/);
  // 时段模式下没有节点，永远放行
  assert.doesNotThrow(() => assertSlotCanStartUpload(null, Date.now()));
});

test('过点放弃必须带 slotExpired 标记，否则会被当成故障暂停账号', () => {
  // 这个标记决定了调用方是"安静跳过"还是"记一次失败"。攒够失败次数账号会被
  // 暂停并推送通知——可这根本不是故障，只是时间到了不发而已。
  const slot = { key: '11:30', start: '11:30', end: '12:30', endMs: 1000 };
  try {
    assertSlotCanStartUpload(slot, 2000);
    assert.fail('应该抛错');
  } catch (err) {
    assert.equal(err.slotExpired, true);
  }
});

test('节点检查只在 beforeUpload，发布前仍持久化原节点', () => {
  const src = readFileSync(new URL('../src/orchestrator.js', import.meta.url), 'utf8');
  const start = src.indexOf('beforeUpload:');
  const publish = src.indexOf('beforePublishClick:', start);
  assert.match(src.slice(start, publish), /assertSlotCanStartUpload\(slot, Date.now\(\)\)/);
  assert.doesNotMatch(src.slice(publish), /assertSlotCanStartUpload\(/);
  assert.match(src.slice(publish), /s\.pendingSlot = slot/);
});

// 人工确认额度由 confirm-publication.test.mjs 用隔离配置调用真实 controller 验证，
// 不再只用源码正则守卫；不需要操作真实账号。

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
// 故意选一个不是今天的日期：如果哪里还偷偷用了系统时钟，这条测试就会挂
const DAY = '2026-01-15';
const TZ = 'Asia/Jakarta';
const SLOTS = [{ start: '11:30', end: '12:30' }, { start: '19:30', end: '20:30' }];
const TARGETS = slotTargetsForDay({ dayKey: DAY, timezone: TZ, slots: SLOTS, accountName: '回归号' });
const jakarta = (h, m) => Date.UTC(2026, 0, 15, h - 7, m);

test('中午发的卡住，晚上才确认：占掉的是中午那个节点，不是晚上的', () => {
  const state = { pendingSlot: { key: '11:30', dayKey: DAY }, pendingSince: jakarta(12, 5) };
  assert.equal(creditedSlotOnConfirm(state, DAY, TARGETS), '11:30');
});

test('跨天之后才确认：不能占用新一天同名的节点', () => {
  const state = { pendingSlot: { key: '11:30', dayKey: DAY }, pendingSince: jakarta(12, 5) };
  assert.equal(creditedSlotOnConfirm(state, '2026-01-16', TARGETS), null);
});

// 升级之前就卡在"待确认"的记录没有 pendingSlot。当成"不需要记账"的话，原节点
// 要是还没结束，确认完恢复后会在同一个节点里再发一条。
test('升级前留下的待确认记录：用 pendingSince 反查出当初的节点', () => {
  const legacy = { pendingSince: jakarta(12, 5) }; // 当初是中午那个节点里发的
  assert.equal(creditedSlotOnConfirm(legacy, DAY, TARGETS), '11:30');
});

test('升级前的记录跨天之后才确认：同样不占用新一天的节点', () => {
  const legacy = { pendingSince: jakarta(12, 5) };
  const otherDayTargets = slotTargetsForDay({ dayKey: '2026-01-16', timezone: TZ, slots: SLOTS, accountName: '回归号' });
  assert.equal(creditedSlotOnConfirm(legacy, '2026-01-16', otherDayTargets), null);
});

test('连 pendingSince 都没有时，不瞎记节点', () => {
  assert.equal(creditedSlotOnConfirm({}, DAY, TARGETS), null);
  assert.equal(creditedSlotOnConfirm(null, DAY, TARGETS), null);
});

// ===== 4. 旧的随机间隔不能挡住节点 =====
// 从时段模式升级过来的状态文件里留着一个几小时后的 nextTime，
// 会把整个节点窗口白白挡掉。
const ACCOUNT = '节点回归测试号';
const STATE_FILE = path.join(import.meta.dirname, '..', 'state', `${ACCOUNT}.json`);

// 时钟是固定的：原来这里拿"当前分钟"现造一个一分钟的节点，在雅加达 23:59 跑会
// 造出 23:59-00:00 这种被配置校验直接拒绝的区间，普通分钟末尾跑也可能在第二次
// tick 之前就过期。改成冻结 Date.now，用真实的节点时刻表倒推出一个"肯定该发"的时刻。
async function withFrozenClock(atMs, fn) {
  const real = Date.now;
  Date.now = () => atMs;
  try { return await fn(); } finally { Date.now = real; }
}

const REG_SLOTS = [{ start: '11:30', end: '12:30' }];
function frozenNowInsideSlot(accountName) {
  // 用真实函数算出这个账号今天的目标时刻，再把"现在"定在它之后一毫秒
  const targets = slotTargetsForDay({
    dayKey: DAY, timezone: TZ, slots: REG_SLOTS, accountName,
  });
  return targets[0].targetMs + 1;
}

async function runTickOnce(settings, account, { prepare } = {}) {
  let calls = 0;
  const adapter = {
    async startProfile() { calls += 1; throw new Error('测试到此为止，能走到这一步就说明闸门放行了'); },
  };
  await tick(settings, [account], new Map([['fake', adapter]]));
  if (prepare) {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    prepare(state);
    writeFileSync(STATE_FILE, JSON.stringify(state));
  }
  calls = 0;
  await tick(settings, [account], new Map([['fake', adapter]]));
  return calls;
}

test('状态里留着旧的随机间隔时，节点模式照样能发', async () => {
  const videoDir = mkdtempSync(path.join(tmpdir(), 'slot-regression-'));
  writeFileSync(path.join(videoDir, '123456.mp4'), 'fake');
  const account = { name: ACCOUNT, browser: 'fake', browserId: 'x1', videoFolder: videoDir, timezone: TZ };
  const settings = {
    minIntervalMs: 1, maxIntervalMs: 2, folderScanIntervalMs: 1000, videoExtensions: ['.mp4'],
    hashtagKeywords: ['fyp'], dailyPublishLimit: 4, timezone: TZ,
    postingSlots: { enabled: true, slots: REG_SLOTS }, retryBackoffMs: [1000], notifications: { enabled: false },
  };
  try {
    const calls = await withFrozenClock(frozenNowInsideSlot(ACCOUNT), () =>
      runTickOnce(settings, account, {
        prepare: (state) => {
          // 模拟从时段模式升级过来：状态里留着一个三小时后的 nextTime
          state.nextTime = Date.now() + 3 * 3600 * 1000;
          state.retryAt = null; state.consecutiveFailures = 0; state.paused = false;
          state.slotsUsedToday = []; state.pendingIndex = null;
        },
      }));
    assert.equal(calls, 1, '旧的 nextTime 不该挡住节点模式的发布');
  } finally {
    rmSync(videoDir, { recursive: true, force: true });
    rmSync(STATE_FILE, { force: true });
  }
});

test('时段模式下，随机间隔照旧生效', async () => {
  const videoDir = mkdtempSync(path.join(tmpdir(), 'slot-regression2-'));
  writeFileSync(path.join(videoDir, '123456.mp4'), 'fake');
  const account = { name: ACCOUNT, browser: 'fake', browserId: 'x1', videoFolder: videoDir, timezone: TZ };
  const settings = {
    minIntervalMs: 1, maxIntervalMs: 2, folderScanIntervalMs: 1000, videoExtensions: ['.mp4'],
    hashtagKeywords: ['fyp'], dailyPublishLimit: 4, timezone: TZ,
    postingSlots: { enabled: false }, postingWindow: { enabled: false },
    retryBackoffMs: [1000], notifications: { enabled: false },
  };
  try {
    const calls = await withFrozenClock(frozenNowInsideSlot(ACCOUNT), () =>
      runTickOnce(settings, account, {
        prepare: (state) => {
          state.nextTime = Date.now() + 3 * 3600 * 1000;
          state.retryAt = null; state.consecutiveFailures = 0; state.paused = false; state.pendingIndex = null;
        },
      }));
    assert.equal(calls, 0, '时段模式下 nextTime 还是要拦住');
  } finally {
    rmSync(videoDir, { recursive: true, force: true });
    rmSync(STATE_FILE, { force: true });
  }
});
