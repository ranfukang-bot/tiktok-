import test from 'node:test';
import assert from 'node:assert/strict';
import { runOneUploadCycle } from '../src/browser/tiktokStudio.js';
import { installTkqInPage } from '../src/browser/injected.js';
import { assertSlotCanStartUpload } from '../src/dailyQuota.js';

// 运行真实 Node 上传编排，页面/时钟使用替身：不连 TikTok，不读取视频，不实际发布。
async function cycle({ expiredBeforeUpload = false, unsafe = false, uncertain = false, uploadFails = false, cleanupFails = false,
  selectionTimeout = false, accepted = true, receiptFails = false, uploadCheckFails = false } = {}) {
  const events = [];
  const slot = { key: '19:30', start: '19:30', end: '20:30', endMs: 100000 };
  let now = expiredBeforeUpload ? slot.endMs : slot.endMs - 1;
  const realTimer = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { queueMicrotask(fn); return 0; };
  const input = {
    first() { return this; }, async waitFor() {},
    async setInputFiles() {
      events.push('upload'); now = slot.endMs + 3000;
      if (uploadFails) throw new Error('upload failed');
      if (selectionTimeout) throw Object.assign(new Error('locator.setInputFiles: Timeout 30000ms exceeded.'), { name: 'TimeoutError' });
    },
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
      if (name === 'hasAcceptedUpload') {
        if (receiptFails) throw new Error('页面丢失');
        return accepted;
      }
      if (name === 'waitForUploadComplete' && uploadCheckFails) throw new Error('视频上传失败');
      if (name === 'locateCaptionEditor') return { x: 1, y: 1, text: '' };
      if (name === 'waitForChecksPassAndAssertSafe' && unsafe) throw new Error('检查未通过');
      if (name === 'clickPublishButton') return { clicked: true };
      if (name === 'clickUploadEntranceAndWait' && cleanupFails) throw new Error('Execution context was destroyed');
      return true;
    },
    async waitForURL() { if (uncertain) throw new Error('confirmation timeout'); },
    async waitForFunction(fn, args, options) {
      assert.equal(options.timeout, 5000, '浏览器无响应时核验也必须有时限');
      if (await this.evaluate(fn, args) !== true) throw new Error('receipt timeout');
      return { async dispose() {} };
    },
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

test('确认发布成功后返回上传页失败，不得改判失败或重复发布', async () => {
  const {result,error,events}=await cycle({cleanupFails:true});
  assert.ifError(error);
  assert.equal(result.published,true);
  assert.equal(events.filter(x=>x==='clickPublishButton').length,1);
});

test('选文件超时但页面收到本条视频：不重传，仍依次等待上传、检查和发布', async () => {
  const { result, error, events } = await cycle({ selectionTimeout: true });
  assert.ifError(error);
  assert.equal(result.published, true);
  assert.equal(events.filter(x => x === 'upload').length, 1);
  const required = ['upload', 'hasAcceptedUpload', 'waitForUploadComplete', 'addProductLink',
    'waitForChecksPassAndAssertSafe', 'assertReadyToPublish', 'pending', 'clickPublishButton'];
  for (let i = 1; i < required.length; i++) assert.ok(events.indexOf(required[i]) > events.indexOf(required[i - 1]));
  assert.equal(events.filter(x => x === 'clickPublishButton').length, 1);
});

for (const options of [{ accepted: false }, { receiptFails: true }]) {
  test(`选文件超时，无法确认接收则停止：${JSON.stringify(options)}`, async () => {
    const { error, events } = await cycle({ selectionTimeout: true, ...options });
    assert.equal(error.name, 'TimeoutError');
    assert.ok(!events.includes('waitForUploadComplete'));
    assert.ok(!events.includes('pending'));
    assert.equal(events.filter(x => x === 'upload').length, 1);
  });
}

for (const options of [{ uploadCheckFails: true }, { unsafe: true }]) {
  test(`超时恢复不放宽上传及内容检查：${JSON.stringify(options)}`, async () => {
    const { error, events } = await cycle({ selectionTimeout: true, ...options });
    assert.ok(error);
    assert.ok(!events.includes('pending'));
    assert.ok(!events.includes('clickPublishButton'));
  });
}
