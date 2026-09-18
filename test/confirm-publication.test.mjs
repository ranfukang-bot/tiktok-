import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { recordConfirmedQuota } from '../src/dailyQuota.js';

// 导入隔离副本的真实 controller/config/stateStore，不读写用户的 config/ 或 state/。
// 临时目录位于仓库内，仅为了复用 node_modules；不启动调度或浏览器。
const repo = path.resolve(import.meta.dirname, '..');
let fixture, controller, store;
const ACCOUNT = '人工确认夹具';
const noon = Date.UTC(2026, 0, 15, 4, 0); // Manila 12:00
const evening = Date.UTC(2026, 0, 15, 12, 0);
const midnight = Date.UTC(2026, 0, 15, 16, 30); // Manila 次日 00:30，Jakarta 仍是昨天
const settings = {
  minIntervalMs: 1000, maxIntervalMs: 2000, timezone: 'Asia/Jakarta',
  deleteAfterPublish: false, dailyPublishLimit: 2,
  postingSlots: { enabled: true, slots: [{ start: '11:30', end: '12:30' }, { start: '19:30', end: '20:30' }] },
};

before(async () => {
  fixture = mkdtempSync(path.join(repo, '.confirmation-test-'));
  cpSync(path.join(repo, 'src'), path.join(fixture, 'src'), { recursive: true });
  mkdirSync(path.join(fixture, 'config'));
  writeFileSync(path.join(fixture, 'config', 'settings.json'), JSON.stringify(settings));
  writeFileSync(path.join(fixture, 'config', 'accounts.json'), JSON.stringify([{ name: ACCOUNT, timezone: 'Asia/Manila' }]));
  controller = await import(pathToFileURL(path.join(fixture, 'src', 'controller.js')));
  store = await import(pathToFileURL(path.join(fixture, 'src', 'stateStore.js')));
});

after(() => {
  if (fixture && path.dirname(fixture) === repo && path.basename(fixture).startsWith('.confirmation-test-')) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

async function confirm({ at = evening, overrides = {}, decision = 'published' } = {}) {
  store.setState(ACCOUNT, {
    ...store.getState(ACCOUNT), items: [{ filename: 'fixture.mp4' }, { filename: 'next.mp4' }],
    doneIndex: -1, pendingIndex: 0, pendingSince: noon,
    pendingSlot: { key: '11:30', dayKey: '2026-01-15' },
    publishDayKey: '2026-01-15', publishedToday: 1, slotsUsedToday: [],
    paused: true, pauseCode: 'uncertain_publish', ...overrides,
  });
  const realNow = Date.now;
  Date.now = () => at;
  try { await controller.resolveUncertain(ACCOUNT, decision); }
  finally { Date.now = realNow; }
  return store.getState(ACCOUNT);
}

test('真实确认路径：同日增加额度、记原节点、清理待确认记录，不重复计数', async () => {
  const state = await confirm();
  assert.equal(state.publishedToday, 2);
  assert.deepEqual(state.slotsUsedToday, ['11:30']);
  assert.equal(state.doneIndex, 0);
  assert.equal(state.paused, false);
  assert.equal(state.pendingSlot, null);
  assert.equal(state.pendingSince, null);
  await assert.rejects(controller.resolveUncertain(ACCOUNT, 'published'), /不是/);
  assert.equal(store.getState(ACCOUNT).publishedToday, 2);
});

test('真实确认路径：按账号时区跨天，昨天的发布不扣今天额度', async () => {
  const state = await confirm({ at: midnight });
  assert.equal(state.publishDayKey, '2026-01-16');
  assert.equal(state.publishedToday, 0);
  assert.deepEqual(state.slotsUsedToday, []);
});

test('真实确认路径：跨天确认不能增加或清掉今天已有的计数', async () => {
  const state = await confirm({ at: midnight, overrides: {
    publishDayKey: '2026-01-16', publishedToday: 1, slotsUsedToday: ['00:00'],
  } });
  assert.equal(state.publishedToday, 1);
  assert.deepEqual(state.slotsUsedToday, ['00:00']);
});

test('真实确认路径：旧记录用 pendingSince 补记同日节点和额度', async () => {
  const state = await confirm({ overrides: { pendingSlot: null } });
  assert.equal(state.publishedToday, 2);
  assert.deepEqual(state.slotsUsedToday, ['11:30']);
});

test('原节点的上传拖进下个节点：仍只记原节点，不误占下个节点', async () => {
  const state = await confirm({ overrides: { pendingSince: evening } });
  assert.equal(state.publishedToday, 2);
  assert.deepEqual(state.slotsUsedToday, ['11:30']);
});

test('昨天开始上传，今天才点击发布：计今天额度，但不占今天同名节点', async () => {
  const state = await confirm({ at: midnight + 1000, overrides: { pendingSince: midnight } });
  assert.equal(state.publishDayKey, '2026-01-16');
  assert.equal(state.publishedToday, 1);
  assert.deepEqual(state.slotsUsedToday, []);
});

test('真实确认路径：旧记录跨天也不扣新一天额度', async () => {
  const state = await confirm({ at: midnight, overrides: { pendingSlot: null } });
  assert.equal(state.publishedToday, 0);
  assert.deepEqual(state.slotsUsedToday, []);
});

test('真实确认路径：确认未发布不消耗额度或节点', async () => {
  const state = await confirm({ decision: 'retry' });
  assert.equal(state.publishedToday, 1);
  assert.deepEqual(state.slotsUsedToday, []);
  assert.equal(state.doneIndex, -1);
});

test('真实确认路径：旧时段模式同样按发布时间记额度', async () => {
  const file = path.join(fixture, 'config', 'settings.json');
  writeFileSync(file, JSON.stringify({ ...settings, postingSlots: { enabled: false } }));
  try {
    assert.equal((await confirm()).publishedToday, 2);
    const tomorrow = await confirm({ at: midnight });
    assert.equal(tomorrow.publishedToday, 0);
    assert.deepEqual(tomorrow.slotsUsedToday, []);
  } finally {
    writeFileSync(file, JSON.stringify(settings));
  }
});

test('共用记账函数：无时间戳时用原节点日期；完全缺失时保守占当日额度', () => {
  const state = { publishDayKey: '2026-01-15', publishedToday: 1, pendingSlot: { dayKey: '2026-01-15' } };
  assert.equal(recordConfirmedQuota(state, 'Asia/Manila', midnight), false);
  assert.equal(state.publishedToday, 0);
  state.pendingSlot = null;
  assert.equal(recordConfirmedQuota(state, 'Asia/Manila', midnight), true);
  assert.equal(state.publishedToday, 1);
});

test('自动确认共用的记账函数：午夜前点击、午夜后收到结果不扣新一天额度', () => {
  const state = { publishDayKey: '2026-01-15', publishedToday: 2, slotsUsedToday: ['11:30'],
    pendingSince: Date.UTC(2026, 0, 15, 15, 59, 59) };
  assert.equal(recordConfirmedQuota(state, 'Asia/Manila', Date.UTC(2026, 0, 15, 16, 0, 1)), false);
  assert.equal(state.publishedToday, 0);
  assert.equal(state.publishDayKey, '2026-01-16');
  assert.deepEqual(state.slotsUsedToday, []);
});

test('点击继续清零旧失败次数，但不重置成功记录和下一次时间', () => {
  store.setState(ACCOUNT,{...store.getState(ACCOUNT),paused:true,pauseCode:'retry_exhausted',pauseReason:'旧失败',consecutiveFailures:3,retryAt:123,lastError:'旧错误',pendingIndex:null,doneIndex:0,publishedToday:1,nextTime:999});
  controller.setAccountPaused(ACCOUNT,false);
  const state=store.getState(ACCOUNT);
  assert.equal(state.paused,false);assert.equal(state.consecutiveFailures,0);
  assert.equal(state.lastError,'');assert.equal(state.retryAt,null);
  assert.equal(state.doneIndex,0);assert.equal(state.publishedToday,1);assert.equal(state.nextTime,999);
});

test('发布结果不确定时，普通继续按钮不能绕过人工确认', () => {
  store.setState(ACCOUNT,{...store.getState(ACCOUNT),paused:true,pauseCode:'uncertain_publish',pendingIndex:0});
  assert.throws(()=>controller.setAccountPaused(ACCOUNT,false),/先确认/);
  assert.equal(store.getState(ACCOUNT).paused,true);
});
