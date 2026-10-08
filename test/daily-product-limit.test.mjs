import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { recordConfirmedQuota, nextPublishableIndex, assertProductCanPublish } from '../src/dailyQuota.js';

const repo = path.resolve(import.meta.dirname, '..');
const noon = Date.UTC(2026, 9, 7, 4); // Manila 12:00
const day = 86400000;

// 真实扫描、队列、调度、记账、人工确认与状态持久化；只替换浏览器上传，不实际发布。
async function fixture(t, overrides = {}) {
  const root = mkdtempSync(path.join(repo, '.scheduler-test-'));
  cpSync(path.join(repo, 'src'), path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'config'));
  const videos = path.join(root, 'videos');
  mkdirSync(videos);
  const settings = {
    minIntervalMs: 1, maxIntervalMs: 2, timezone: 'Asia/Manila', dailyPublishLimit: 4,
    videoExtensions: ['.mp4'], postingSlots: { enabled: false }, postingWindow: { enabled: false },
    deleteAfterPublish: false, notifications: { enabled: false }, retryBackoffMs: [1], ...overrides,
  };
  const account = { name: '产品限制夹具', browser: 'fake', videoFolder: videos };
  writeFileSync(path.join(root, 'config', 'settings.json'), JSON.stringify(settings));
  writeFileSync(path.join(root, 'config', 'accounts.json'), JSON.stringify([account]));
  writeFileSync(path.join(root, 'src', 'browser', 'tiktokStudio.js'), `
    export const attempts = [];
    export let outcome = 'published';
    export function setOutcome(value) { outcome = value; }
    export async function runOneUploadCycle({item, beforeUpload, beforePublishClick}) {
      await beforeUpload();
      if (outcome === 'failure') throw new Error('fixture network failure');
      await beforePublishClick();
      attempts.push({...item});
      return {published: outcome === 'published'};
    }
  `);
  const originalNow = Date.now;
  const originalConnect = chromium.connectOverCDP;
  let now = noon;
  Date.now = () => now;
  chromium.connectOverCDP = async () => ({
    contexts: () => [{ pages: () => [{ url: () => 'https://www.tiktok.com/tiktokstudio/upload' }] }],
    async close() {},
  });
  t.after(() => {
    Date.now = originalNow;
    chromium.connectOverCDP = originalConnect;
    if (path.dirname(root) === repo && path.basename(root).startsWith('.scheduler-test-')) {
      rmSync(root, { recursive: true, force: true });
    }
  });
  const load = name => import(pathToFileURL(path.join(root, 'src', name)));
  const work = await load('orchestrator.js');
  const store = await load('stateStore.js');
  const controller = await load('controller.js');
  const upload = await load('browser/tiktokStudio.js');
  let opens = 0;
  const adapters = new Map([['fake', {
    async startProfile() { opens++; return { wsEndpoint: 'fixture' }; }, async stopProfile() {},
  }]]);
  return {
    settings, account, store, controller, upload, videos,
    add(name) { writeFileSync(path.join(videos, name), 'fixture video'); },
    at(ms) { now = ms; },
    opens: () => opens,
    state: () => store.getState(account.name),
    async tick(accounts = [account]) { now += 100; await work.tick(settings, accounts, adapters); },
  };
}

test('4 个产品各 3 条：连续三天每天各一条，扫描与删除已发布文件不丢库存或产品记录', async t => {
  const f = await fixture(t);
  const ids = ['1737318339699312031', '1737318339699312032', '1737318339699312033', '1737318339699312034'];
  for (const id of ids) for (let n = 0; n < 3; n++) f.add(`${id}${n ? ` (${n})` : ''}.mp4`);
  for (let d = 0; d < 3; d++) {
    f.at(noon + d * day);
    for (let n = 0; n < 4; n++) {
      await f.tick();
      const item = f.upload.attempts.at(-1);
      unlinkSync(path.join(f.videos, item.relativePath));
    }
    assert.deepEqual(f.upload.attempts.slice(d * 4).map(x => x.productId), ids);
    assert.deepEqual(f.state().publishedProductIdsToday, ids);
    assert.equal(f.state().publishedToday, 4);
    await f.tick();
    assert.equal(f.opens(), (d + 1) * 4);
    assert.equal(f.state().items.length - f.state().doneIndex - 1, 12 - (d + 1) * 4);
  }
  assert.equal(new Set(f.upload.attempts.map(x => x.relativePath)).size, 12);
});

test('剩余全是同产品则等待，不打开浏览器；加入其他产品可继续，不受另一账号影响', async t => {
  const f = await fixture(t, { dailyPublishLimit: 0 });
  f.add('100.mp4'); f.add('100 (1).mp4');
  await f.tick();
  assert.equal(f.controller.getStatus().accounts[0].productLimitReached, true);
  await f.tick();
  assert.equal(f.opens(), 1);
  assert.equal(f.state().paused, false);
  f.add('200.mp4');
  await f.tick();
  assert.deepEqual(f.upload.attempts.map(x => x.productId), ['100', '200']);
  assert.equal(f.state().items.length - f.state().doneIndex - 1, 1);
  const other = { ...f.account, name: '另一账号' };
  await f.tick([other]);
  assert.equal(f.upload.attempts.at(-1).productId, '100');
  f.at(noon + day);
  assert.equal(f.controller.getStatus().accounts[0].productLimitReached, false);
  await f.tick();
  assert.equal(f.upload.attempts.at(-1).productId, '100');
  assert.equal(f.state().publishedToday, 1);
});

test('失败不扣产品额度，待确认阻止继续；确认未发布能重试，确认已发布拦住同产品', async t => {
  const f = await fixture(t);
  f.add('100.mp4'); f.add('100 (1).mp4'); f.add('200.mp4');
  f.upload.setOutcome('failure');
  await f.tick();
  assert.deepEqual(f.state().publishedProductIdsToday, []);
  f.upload.setOutcome('uncertain');
  await f.tick();
  assert.equal(f.state().pauseCode, 'uncertain_publish');
  await f.tick();
  assert.equal(f.upload.attempts.length, 1);
  await f.controller.resolveUncertain(f.account.name, 'retry');
  await f.tick();
  assert.equal(f.upload.attempts.length, 2);
  assert.equal(f.upload.attempts[0].relativePath, f.upload.attempts[1].relativePath);
  await f.controller.resolveUncertain(f.account.name, 'published');
  assert.deepEqual(f.state().publishedProductIdsToday, ['100']);
  f.upload.setOutcome('published');
  await f.tick();
  assert.equal(f.upload.attempts.at(-1).productId, '200');
  assert.equal(f.state().items.length - f.state().doneIndex - 1, 1);
});

test('固定节点模式也跳过同产品，且同节点不能多发', async t => {
  const f = await fixture(t, { postingSlots: { enabled: true, slots: [
    { start: '12:00', end: '12:01' }, { start: '13:00', end: '13:01' },
  ] } });
  f.add('100.mp4'); f.add('100 (1).mp4'); f.add('200.mp4');
  await f.tick(); await f.tick();
  assert.equal(f.upload.attempts.length, 1);
  f.at(noon + 3600000);
  await f.tick();
  assert.deepEqual(f.upload.attempts.map(x => x.productId), ['100', '200']);
  assert.deepEqual(f.state().slotsUsedToday, ['12:00', '13:00']);
});

test('人工跨天确认只计发布当日产品，次日同产品仍可发', async t => {
  const f = await fixture(t);
  f.add('100.mp4'); f.add('100 (1).mp4');
  f.upload.setOutcome('uncertain');
  await f.tick();
  f.at(noon + day);
  await f.controller.resolveUncertain(f.account.name, 'published');
  assert.deepEqual(f.state().publishedProductIdsToday, []);
  f.upload.setOutcome('published');
  await f.tick();
  assert.deepEqual(f.state().publishedProductIdsToday, ['100']);
  assert.equal(f.state().publishedToday, 1);
});

test('产品记录按账号时区和点击发布时间记账：跨午夜、旧状态兼容、保留今天已有记录', () => {
  const midnight = Date.UTC(2026, 9, 7, 16);
  const state = { items: [{ productId: '100' }], doneIndex: -1, publishDayKey: '2026-10-07',
    publishedProductIdsToday: ['100'], pendingSince: midnight - 1 };
  assert.equal(nextPublishableIndex(state, 'Asia/Manila', midnight), 0);
  assert.equal(nextPublishableIndex(state, 'Asia/Jakarta', midnight), -1);
  assert.throws(() => assertProductCanPublish(state, '100', 'Asia/Jakarta', midnight),
    err => err.productDailyLimitReached === true);
  recordConfirmedQuota(state, 'Asia/Manila', midnight + 1, '100');
  assert.deepEqual(state.publishedProductIdsToday, []);
  state.publishedProductIdsToday = ['200'];
  recordConfirmedQuota(state, 'Asia/Manila', midnight + 2, '100');
  assert.deepEqual(state.publishedProductIdsToday, ['200']);
  state.pendingSince = midnight;
  recordConfirmedQuota(state, 'Asia/Manila', midnight + 2, '100');
  assert.deepEqual(state.publishedProductIdsToday, ['200', '100']);
  delete state.publishedProductIdsToday;
  assert.equal(nextPublishableIndex(state, 'Asia/Manila', midnight + 2), 0);
  recordConfirmedQuota(state, 'Asia/Manila', midnight + 2, '100');
  assert.deepEqual(state.publishedProductIdsToday, ['100']);
});
