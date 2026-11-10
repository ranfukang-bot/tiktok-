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
  const { accountProblemFolder, ...settingsOverrides } = options;
  const root = fs.mkdtempSync(path.join(repo, '.scheduler-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(repo, 'src'), path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config'));
  const account = { name: '账号:甲', phoneGroup: '手机,甲', browser: 'fake', videoFolder: path.join(root, 'videos') };
  fs.mkdirSync(account.videoFolder);
  const problemFolder = path.join(root, 'problem');
  account.problemFolder = accountProblemFolder ?? problemFolder;
  const settings = { minIntervalMs: 1, maxIntervalMs: 2, videoExtensions: ['.mp4'],
    timezone: 'UTC', postingSlots: { enabled: false }, postingWindow: { enabled: false },
    deleteAfterPublish: false, ...settingsOverrides };
  fs.writeFileSync(path.join(root, 'config/settings.json'), JSON.stringify(settings));
  fs.writeFileSync(path.join(root, 'config/accounts.json'), JSON.stringify([account]));
  const load = file => import(pathToFileURL(path.join(root, 'src', file)));
  const { tick } = await load('orchestrator.js');
  const { getState, setState } = await load('stateStore.js');
  const state = () => getState(account.name);
  let starts = 0, stops = 0, connects = 0;
  const uploads = [];
  const waits = [];
  const adapters = new Map([['fake', {
    async startProfile() { starts++; return { wsEndpoint: 'http://localhost:12345' }; },
    async stopProfile() { stops++; },
  }]]);
  const dir = () => problemFolder;
  const journal = () => {
    const file = path.join(root, 'state/moved-videos.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  };
  return {
    root, account, settings, load, state, dir, journal, starts: () => starts, stops: () => stops,
    uploads, waits, connects: () => connects,
    csv: (dir = problemFolder) => fs.readFileSync(path.join(dir, '发不出去的视频记录.csv'), 'utf8'),
    update: values => setState(account.name, { ...state(), ...values }),
    add: (...names) => names.forEach(name => fs.writeFileSync(path.join(account.videoFolder, name), name)),
    has: name => fs.existsSync(path.join(account.videoFolder, name)),
    async run(message, { attempted = false, moveOptions, accounts = [account], beforeUploadCheck, onWait, afterPublishClick } = {}) {
      await tick(settings, accounts, adapters, {
        connectBrowser: async () => {
          connects++;
          const page = { url: () => '/tiktokstudio/upload' };
          return { contexts: () => [{ pages: () => [page] }], close: async () => {} };
        },
        async waitBetweenVideos(ms) { waits.push(ms); await onWait?.(); },
        async uploadCycle({ beforeUpload, beforePublishClick, item, page }) {
          beforeUploadCheck?.();
          beforeUpload();
          uploads.push({ filename: item.filename, page });
          const error = typeof message === 'function' ? message(item) : message;
          if (attempted || !error) {
            await beforePublishClick();
            afterPublishClick?.();
          }
          if (error) throw new Error(error);
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
    assert.equal(getStatus().productIssuePolicy, 'move-aside-v2');
    assert.equal(getStatus().accounts[0].movedToday, 1);
  });
}

test('未配置、非目标错误、以及发布后出错均保留原文件', async t => {
  for (const [message, settings, attempted, code] of [
    [errors[0][0], { accountProblemFolder: '', problemFolder: '旧全局目录' }, false, 'content_error'],
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
  await f.run(item => item.productId === '123' ? errors[0][0] : null);
  assert.deepEqual(fs.readdirSync(f.dir()).filter(name => name.endsWith('.mp4')).sort(), ['123 (1).mp4', '123 (2).mp4', '123.mp4']);
  assert.equal(fs.readFileSync(path.join(f.dir('没库存'), '123.mp4'), 'utf8'), '原有视频');
  assert.equal(f.journal().length, 2);
  assert.equal(f.csv().trimEnd().split('\r\n').length, 3);
  assert.deepEqual(f.state().items.map(i => i.filename), ['456.mp4']);
  assert.equal(f.stops(), 1);
  assert.equal(f.starts(), 1);
  assert.equal(f.state().publishedToday, 1);
  assert.deepEqual(f.state().consecutiveProductMoves, []);
});

for (const crossesDeadline of [false, true]) test(`同轮同窗口补发并记原节点（跨截止时间：${crossesDeadline}）`, async t => {
  let now = Date.UTC(2026, 10, 10, 10, 30);
  t.mock.method(Date, 'now', () => now);
  const f = await fixture(t, { postingSlots: { enabled: true, slots: [{ start: '10:00', end: '11:00' }] } });
  f.add('123.mp4', '456.mp4');
  await f.run(item => item.productId === '123' ? errors[0][0] : null, {
    onWait() {
      assert.deepEqual(f.state().slotsUsedToday, []);
      assert.equal(f.state().publishedToday, 0);
      if (crossesDeadline) now = Date.UTC(2026, 10, 10, 11, 1);
    },
    afterPublishClick() { assert.equal(f.state().pendingSlot.key, '10:00'); },
  });
  assert.deepEqual(f.state().slotsUsedToday, ['10:00']);
  assert.equal(f.state().publishedToday, 1);
  assert.equal(f.starts(), 1);
  assert.equal(f.connects(), 1);
  assert.deepEqual(f.uploads.map(entry => entry.filename), ['123.mp4', '456.mp4']);
  assert.equal(f.uploads[0].page, f.uploads[1].page);
  assert.equal(f.waits.length, 1);
  assert.ok(f.waits[0] >= 10000 && f.waits[0] <= 30000);
  assert.equal(f.stops(), 1);
});

test('第一条开始上传前过点，安静跳过，不移动、不暂停', async t => {
  let now = Date.UTC(2026, 10, 10, 10, 30);
  t.mock.method(Date, 'now', () => now);
  const f = await fixture(t, { postingSlots: { enabled: true, slots: [{ start: '10:00', end: '11:00' }] } });
  f.add('123.mp4');
  await f.run(errors[0][0], { beforeUploadCheck() { now = Date.UTC(2026, 10, 10, 11, 1); } });
  assert.deepEqual(f.uploads, []);
  assert.equal(f.has('123.mp4'), true);
  assert.equal(f.state().paused, false);
  assert.equal(f.state().consecutiveFailures, 0);
});

test('补发遇到检查超时，按原规则退避并保留窗口', async t => {
  const f = await fixture(t);
  f.add('123.mp4', '456.mp4');
  await f.run(item => item.productId === '123' ? errors[0][0] : '审核等待超时（可重试）：检查还在运行');
  assert.equal(f.has('123.mp4'), false);
  assert.equal(f.has('456.mp4'), true);
  assert.equal(f.state().paused, false);
  assert.equal(f.state().consecutiveFailures, 1);
  assert.ok(f.state().retryAt > Date.now());
  assert.equal(f.stops(), 0);
  assert.equal(f.starts(), 1);
});

test('移走后只剩已达同商品上限的库存，关窗口但保留视频', async t => {
  const f = await fixture(t);
  const { currentDayKey } = await f.load('dailyQuota.js');
  f.update({ publishDayKey: currentDayKey('UTC'), publishedToday: 1, publishedProductIdsToday: ['456'] });
  f.add('123.mp4', '456.mp4');
  await f.run(errors[0][0]);
  assert.equal(f.has('456.mp4'), true);
  assert.equal(f.state().paused, false);
  assert.equal(f.stops(), 1);
  assert.deepEqual(f.waits, []);
});

test('补发等待期间跨天，按新一天检查同商品上限和记发布额度', async t => {
  let now = Date.UTC(2026, 10, 10, 23, 30);
  t.mock.method(Date, 'now', () => now);
  const f = await fixture(t, { postingSlots: { enabled: true, slots: [{ start: '23:00', end: '23:59' }] } });
  f.update({ publishDayKey: '2026-11-10', publishedToday: 1, publishedProductIdsToday: ['456'] });
  f.add('123.mp4', '456.mp4', '789.mp4');
  await f.run(item => item.productId === '123' ? errors[0][0] : null, {
    onWait() { now = Date.UTC(2026, 10, 11, 0, 1); },
    afterPublishClick() { assert.equal(f.state().pendingSlot.dayKey, '2026-11-10'); },
  });
  assert.deepEqual(f.uploads.map(entry => entry.filename), ['123.mp4', '456.mp4']);
  assert.equal(f.state().publishDayKey, '2026-11-11');
  assert.deepEqual(f.state().publishedProductIdsToday, ['456']);
  assert.equal(f.state().publishedToday, 1);
  assert.deepEqual(f.state().slotsUsedToday, [], '昨天的节点不占今天的同名节点');
});

test('两个账号的视频和 CSV 各写入自己的文件夹', async t => {
  const f = await fixture(t);
  const second = { ...f.account, name: '账号乙', videoFolder: path.join(f.root, 'videos2'), problemFolder: path.join(f.root, 'problem2') };
  fs.mkdirSync(second.videoFolder);
  fs.writeFileSync(path.join(second.videoFolder, '123.mp4'), '乙的视频');
  fs.writeFileSync(path.join(f.root, 'config/accounts.json'), JSON.stringify([f.account, second]));
  f.add('123.mp4');
  await f.run(errors[0][0], { accounts: [f.account, second] });
  assert.equal(fs.readFileSync(path.join(f.dir(), '123.mp4'), 'utf8'), '123.mp4');
  assert.equal(fs.readFileSync(path.join(second.problemFolder, '123.mp4'), 'utf8'), '乙的视频');
  assert.ok(f.csv().includes('"账号:甲"'));
  assert.ok(!f.csv().includes('"账号乙"'));
  assert.ok(f.csv(second.problemFolder).includes('"账号乙"'));
  assert.ok(!f.csv(second.problemFolder).includes('"账号:甲"'));
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
  const starts = f.starts();
  f.add('123.mp4', '234.mp4', '345.mp4');
  await f.run(errors[0][0]);
  assert.deepEqual(f.state().consecutiveProductMoves, ['123', '234']);
  assert.equal(f.starts(), starts + 1);
  assert.equal(f.stops(), 1);
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

test('运行时再次检查与其他账号目录和收件箱的双向重叠，拒绝移动', async t => {
  for (const kind of ['account-parent', 'account-child', 'inbox-parent', 'inbox-child']) {
    const f = await fixture(t);
    f.add('123.mp4');
    const overlap = kind.endsWith('parent') ? f.root : path.join(f.dir(), '子目录');
    const accounts = [f.account];
    if (kind.startsWith('inbox')) f.settings.inboxFolder = overlap;
    else accounts.push({ name: '其他账号', enabled: false, videoFolder: overlap });
    fs.writeFileSync(path.join(f.root, 'config/settings.json'), JSON.stringify(f.settings));
    fs.writeFileSync(path.join(f.root, 'config/accounts.json'), JSON.stringify(accounts));
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
