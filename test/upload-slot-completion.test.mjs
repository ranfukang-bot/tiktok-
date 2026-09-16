import test from 'node:test';
import assert from 'node:assert/strict';
import { runOneUploadCycle } from '../src/browser/tiktokStudio.js';
import { installTkqInPage } from '../src/browser/injected.js';
import { assertSlotCanStartUpload } from '../src/dailyQuota.js';

// 运行真实 Node 上传编排，页面/时钟使用替身：不连 TikTok，不读取视频，不实际发布。
async function cycle({ expiredBeforeUpload = false, unsafe = false, uncertain = false, uploadFails = false } = {}) {
  const events = [];
  const slot = { key: '19:30', start: '19:30', end: '20:30', endMs: 100000 };
  let now = expiredBeforeUpload ? slot.endMs : slot.endMs - 1;
  const realTimer = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { queueMicrotask(fn); return 0; };
  const input = {
    first() { return this; }, async waitFor() {},
    async setInputFiles() { events.push('upload'); now = slot.endMs + 3000; if (uploadFails) throw new Error('upload failed'); },
  };
  const page = {
    on() {}, url: () => 'https://www.tiktok.com/tiktokstudio/upload', locator: () => input,
    async bringToFront() {}, mouse: { async move() {}, async click() {} },
    async evaluate(fn) {
      if (fn === installTkqInPage) return;
      const code = fn.toString();
      if (code.includes('document.querySelector')) return true;
      const name = /window\.__tkq\.(\w+)/.exec(code)?.[1];
      assert.ok(name, `未识别的页面调用：${code}`);
      events.push(name);
      if (name === 'locateCaptionEditor') return { x: 1, y: 1, text: '' };
      if (name === 'waitForChecksPassAndAssertSafe' && unsafe) throw new Error('检查未通过');
      if (name === 'clickPublishButton') return { clicked: true };
      return true;
    },
    async waitForURL() { if (uncertain) throw new Error('confirmation timeout'); },
  };
  try {
    const result = await runOneUploadCycle({
      page, account: { videoFolder: 'C:/fixture' }, item: { filename: 'fixture.mp4', relativePath: 'fixture.mp4', productId: '1' },
      config: { hashtagKeywords: [] }, log: { info() {}, warn() {} },
      beforeUpload() { events.push('admission'); assertSlotCanStartUpload(slot, now); },
      beforePublishClick() { events.push('pending'); },
    });
    return { result, events };
  } catch (error) { return { error, events }; }
  finally { globalThis.setTimeout = realTimer; }
}

test('节点内开始上传，晚三秒完成也会经过安全检查并发布一次', async () => {
  const { result, error, events } = await cycle();
  assert.ifError(error);
  assert.equal(result.published, true);
  assert.ok(events.indexOf('admission') < events.indexOf('upload'));
  assert.ok(events.indexOf('waitForChecksPassAndAssertSafe') < events.indexOf('pending'));
  assert.ok(events.indexOf('assertReadyToPublish') < events.indexOf('pending'));
  assert.ok(events.indexOf('pending') < events.indexOf('clickPublishButton'));
  assert.equal(events.filter(x => x === 'clickPublishButton').length, 1);
});

test('等页面时已经过点：不上传、不记发布尝试、不点击发布', async () => {
  const { error, events } = await cycle({ expiredBeforeUpload: true });
  assert.equal(error.slotExpired, true);
  for (const step of ['upload', 'pending', 'clickPublishButton']) assert.ok(!events.includes(step));
});

test('跨点完成不等于强发：安全检查失败仍然阻止发布', async () => {
  const { error, events } = await cycle({ unsafe: true });
  assert.match(error.message, /检查未通过/);
  assert.ok(!events.includes('pending'));
  assert.ok(!events.includes('clickPublishButton'));
});

test('跨点发布结果不确定：不重复点击发布', async () => {
  const { result, events } = await cycle({ uncertain: true });
  assert.equal(result.uncertain, true);
  assert.equal(result.published, false);
  assert.equal(events.filter(x => x === 'clickPublishButton').length, 1);
});

test('上传失败不允许进入发布流程', async () => {
  const { error, events } = await cycle({ uploadFails: true });
  assert.match(error.message, /upload failed/);
  assert.ok(!events.includes('pending'));
  assert.ok(!events.includes('clickPublishButton'));
});
