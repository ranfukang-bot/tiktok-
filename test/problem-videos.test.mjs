import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as io from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';

const repo = path.resolve(import.meta.dirname, '..');
const errors = [
  ['商品没库存：库存为0', '没库存'],
  ['page.evaluate: Error: 未找到精确商品ID 123，核对橱窗', '橱窗找不到商品'],
  ['商品当前不可用：已禁用', '商品不可用'],
];

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(repo, '.scheduler-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(repo, 'src'), path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config'));
  const account = { name: '账号:甲', phoneGroup: '手机,甲', browser: 'fake', videoFolder: path.join(root, 'videos') };
  fs.mkdirSync(account.videoFolder);
  const problemFolder = path.join(root, 'problem');
  const settings = { problemFolder, minIntervalMs: 1, maxIntervalMs: 2, videoExtensions: ['.mp4'],
    timezone: 'UTC', postingSlots: { enabled: false }, postingWindow: { enabled: false },
    deleteAfterPublish: false, ...options };
  fs.writeFileSync(path.join(root, 'config/settings.json'), JSON.stringify(settings));
  fs.writeFileSync(path.join(root, 'config/accounts.json'), JSON.stringify([account]));
  const load = file => import(pathToFileURL(path.join(root, 'src', file)));
  const { tick } = await load('orchestrator.js');
  const { getState, setState } = await load('stateStore.js');
  const state = () => getState(account.name);
  let starts = 0, stops = 0;
  const adapters = new Map([['fake', {
    async startProfile() { starts++; return { wsEndpoint: 'http://localhost:12345' }; },
    async stopProfile() { stops++; },
  }]]);
  const dir = reason => path.join(problemFolder, '账号_甲', reason);
  const journal = () => {
    const file = path.join(root, 'state/moved-videos.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  };
  return {
    root, account, settings, load, state, dir, journal, starts: () => starts, stops: () => stops,
    csv: () => fs.readFileSync(path.join(problemFolder, '移走记录.csv'), 'utf8'),
    update: values => setState(account.name, { ...state(), ...values }),
    add: (...names) => names.forEach(name => fs.writeFileSync(path.join(account.videoFolder, name), name)),
    has: name => fs.existsSync(path.join(account.videoFolder, name)),
    async run(message, { attempted = false, moveOptions } = {}) {
      await tick(settings, [account], adapters, {
        connectBrowser: async () => ({ isConnected: () => true, contexts: () => [{ pages: () => [{ url: () => '/tiktokstudio/upload' }] }],
          close: async () => {} }),
        async uploadCycle({ beforePublishClick }) {
          if (attempted || !message) await beforePublishClick();
          if (message) throw new Error(message);
          return { published: true };
        },
        moveOptions,
      });
    },
  };
}

for (const [message, label] of errors) {
  test(`发布前：${label}只移走待发视频，不占额度或节点`, async t => {
    const f = await fixture(t);
    f.add('123.mp4');
    f.update({ consecutiveFailures: 2, retryAt: 1 });
    await f.run(message);
    assert.equal(fs.readFileSync(path.join(f.dir(label), '123.mp4'), 'utf8'), '123.mp4');
    assert.equal(f.has('123.mp4'), false);
    assert.equal(f.state().paused, false);
    assert.equal(f.state().consecutiveFailures, 2);
    assert.equal(f.state().retryAt, 1);
    assert.equal(f.state().publishedToday, 0);
    assert.deepEqual(f.state().slotsUsedToday, []);
    assert.deepEqual(f.state().items, []);
    assert.equal(f.stops(), 1);
    assert.equal(f.journal().length, 1);
    assert.equal(f.journal()[0].csvPending, false);
    const csv = f.csv();
    assert.equal(csv[0], '\uFEFF');
    assert.equal(csv.trimEnd().split('\r\n').length, 2);
    assert.ok(csv.includes(`"账号:甲","手机,甲","${label}","123","123.mp4"`));
    const { getStatus } = await f.load('controller.js');
    assert.equal(getStatus().productIssuePolicy, 'move-aside-v1');
    assert.equal(getStatus().accounts[0].movedToday, 1);
  });
}

test('未配置、非目标错误、以及发布后出错均保留原文件', async t => {
  for (const [message, settings, attempted, code] of [
    [errors[0][0], { problemFolder: '' }, false, 'content_error'],
    [errors[0][0], {}, true, 'uncertain_publish'],
    ['商品橱窗为空', {}, false, 'content_error'],
    ['页面结构不受支持', {}, false, 'config_error'],
    ['商品锚点名称候选已耗尽', {}, false, 'content_error'],
  ]) {
    const f = await fixture(t, settings);
    f.add('123.mp4');
    await f.run(message, { attempted });
    assert.equal(f.state().paused, true);
    assert.equal(f.state().pauseCode, code);
    assert.equal(f.has('123.mp4'), true);
    assert.deepEqual(f.journal(), []);
    assert.equal(f.stops(), 0);
  }
});

test('同商品一起移走，不覆盖重名；有下一条时复用窗口', async t => {
  const f = await fixture(t);
  f.add('123.mp4', '123 (1).mp4', '456.mp4');
  fs.mkdirSync(f.dir('没库存'), { recursive: true });
  fs.writeFileSync(path.join(f.dir('没库存'), '123.mp4'), '原有视频');
  await f.run(errors[0][0]);
  assert.deepEqual(fs.readdirSync(f.dir('没库存')).sort(), ['123 (1).mp4', '123 (2).mp4', '123.mp4']);
  assert.equal(fs.readFileSync(path.join(f.dir('没库存'), '123.mp4'), 'utf8'), '原有视频');
  assert.equal(f.journal().length, 2);
  assert.equal(f.csv().trimEnd().split('\r\n').length, 3);
  assert.deepEqual(f.state().items.map(i => i.filename), ['456.mp4']);
  assert.equal(f.stops(), 0);
  await f.run();
  assert.equal(f.starts(), 1);
  assert.equal(f.state().publishedToday, 1);
  assert.deepEqual(f.state().consecutiveProductMoves, []);
});

test('移走后同一发布时间节点可发布下一条，节点只记成功发布', async t => {
  t.mock.method(Date, 'now', () => Date.UTC(2026, 10, 10, 10, 30));
  const f = await fixture(t, { postingSlots: { enabled: true, slots: [{ start: '10:00', end: '11:00' }] } });
  f.add('123.mp4', '456.mp4');
  await f.run(errors[0][0]);
  assert.deepEqual(f.state().slotsUsedToday, []);
  await f.run();
  assert.deepEqual(f.state().slotsUsedToday, ['10:00']);
  assert.equal(f.state().publishedToday, 1);
  assert.equal(f.starts(), 1);
});

const errCode = code => Object.assign(new Error(code), { code });
test('跨盘复制后源文件删不掉：回滚复制品并暂停', async t => {
  const f = await fixture(t);
  f.add('123.mp4');
  await f.run(errors[0][0], { moveOptions: { io: { ...io,
    rename: async () => { throw errCode('EXDEV'); },
    unlink: async file => {
      if (file.startsWith(f.account.videoFolder + path.sep)) throw errCode('EACCES');
      await io.unlink(file);
    },
  } } });
  assert.equal(f.has('123.mp4'), true);
  assert.deepEqual(fs.readdirSync(f.dir('没库存')), []);
  assert.equal(f.state().paused, true);
  assert.deepEqual(f.journal(), []);
});

test('文件被占用：间隔两秒重试五次，最终暂停且不留目标副本', async t => {
  const f = await fixture(t);
  f.add('123.mp4');
  let attempts = 0;
  const delays = [];
  await f.run(errors[0][0], { moveOptions: { delay: async ms => delays.push(ms), io: { ...io,
    rename: async () => { attempts++; throw errCode(attempts % 2 ? 'EBUSY' : 'EPERM'); },
  } } });
  assert.equal(attempts, 6);
  assert.deepEqual(delays, Array(5).fill(2000));
  assert.match(f.state().pauseReason, /视频文件被占用，没能移走/);
  assert.equal(f.has('123.mp4'), true);
  assert.deepEqual(fs.readdirSync(f.dir('没库存')), []);
});

test('第三个不同商品才暂停通知，成功发布和手动继续清零', async t => {
  const notices = [];
  const receiver = createServer(async (req, res) => {
    let data = '';
    for await (const chunk of req) data += chunk;
    notices.push(JSON.parse(data));
    res.end('ok');
  }).listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  t.after(() => receiver.close());
  const f = await fixture(t, { notifications: { enabled: true, provider: 'webhook',
    webhook: { url: `http://127.0.0.1:${receiver.address().port}` } } });
  f.add('123.mp4');
  await f.run(errors[0][0]);
  f.add('123.mp4', '234.mp4', '345.mp4');
  await f.run(errors[0][0]);
  assert.deepEqual(f.state().consecutiveProductMoves, ['123']);
  await f.run(errors[0][0]);
  assert.equal(notices.length, 0);
  await f.run(errors[0][0]);
  assert.equal(f.has('345.mp4'), true);
  assert.equal(f.state().pauseCode, 'product_move_breaker');
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /连续3个不同商品挂车失败/);
  const { setAccountPaused } = await f.load('controller.js');
  setAccountPaused(f.account.name, false);
  assert.deepEqual(f.state().consecutiveProductMoves, []);
  f.update({ consecutiveProductMoves: ['123', '234'] });
  await f.run();
  assert.deepEqual(f.state().consecutiveProductMoves, []);
  f.add('456.mp4');
  await f.run(errors[0][0]);
  assert.equal(f.state().paused, false);
  assert.deepEqual(f.state().consecutiveProductMoves, ['456']);
});

test('运行时再次检查账号目录和收件箱重叠，拒绝移动', async t => {
  for (const kind of ['account', 'inbox']) {
    const f = await fixture(t);
    f.add('123.mp4');
    if (kind === 'inbox') f.settings.inboxFolder = f.root;
    else f.settings.problemFolder = path.join(f.account.videoFolder, 'sub');
    fs.writeFileSync(path.join(f.root, 'config/settings.json'), JSON.stringify(f.settings));
    await f.run(errors[0][0]);
    assert.equal(f.state().paused, true);
    assert.equal(f.has('123.mp4'), true);
    assert.deepEqual(f.journal(), []);
  }
});

test('CSV 被占用时照常移走；下轮扫描补写，后续不重复写', async t => {
  const f = await fixture(t);
  f.add('123.mp4');
  await f.run(errors[0][0], { moveOptions: { append: () => { throw errCode('EBUSY'); } } });
  assert.equal(f.state().paused, false);
  assert.equal(f.has('123.mp4'), false);
  assert.equal(f.journal()[0].csvPending, true);
  assert.throws(f.csv, { code: 'ENOENT' });
  const { tickAll } = await f.load('orchestrator.js');
  await tickAll(f.settings, []);
  assert.equal(f.journal()[0].csvPending, false);
  const csv = f.csv();
  await tickAll(f.settings, []);
  assert.equal(f.csv(), csv);
  assert.equal(csv.trimEnd().split('\r\n').length, 2);
});
