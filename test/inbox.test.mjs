// 收件箱归档的测试。
//
// 这块会【真的搬文件】，所以测的重点不是"搬对了没"，而是"该不动的时候有没有忍住"：
// 收件箱同时也是你的下载目录，里面还有别的东西；目标文件夹里那个同名文件可能是
// 还没发出去的视频。搬错一次的代价比不搬大得多。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { routeInbox } from '../src/inbox.js';
import { normalizeProductId, importFromCsv, mergeJoblist, findJob } from '../src/joblist.js';

const SETTINGS = { videoExtensions: ['.mp4', '.mov'] };
const OLD = Date.now() - 60 * 1000; // 早就写完了，可以搬

function makeDirs() {
  const root = mkdtempSync(path.join(tmpdir(), 'inbox-test-'));
  const inbox = path.join(root, '收件箱');
  const folderA = path.join(root, '印尼1号');
  const folderB = path.join(root, '印尼2号');
  for (const dir of [inbox, folderA, folderB]) mkdirSync(dir, { recursive: true });
  return { root, inbox, folderA, folderB };
}

function put(dir, name, content = 'video', mtimeMs = OLD) {
  const file = path.join(dir, name);
  writeFileSync(file, content);
  const seconds = mtimeMs / 1000;
  utimesSync(file, seconds, seconds);
  return file;
}

const accounts = (dirs) => [
  { name: '印尼1号', videoFolder: dirs.folderA },
  { name: '印尼2号', videoFolder: dirs.folderB },
];

test('按商品ID送进品单里指定的那个账号文件夹', async () => {
  const dirs = makeDirs();
  try {
    put(dirs.inbox, '1737318339699312031.mp4', 'A');
    put(dirs.inbox, '1735360337668113923.mp4', 'B');
    const joblist = [
      { productId: '1737318339699312031', account: '印尼1号' },
      { productId: '1735360337668113923', account: '印尼2号' },
    ];
    const r = await routeInbox({ ...SETTINGS, inboxFolder: dirs.inbox }, accounts(dirs), joblist);
    assert.equal(r.moved.length, 2);
    assert.equal(readFileSync(path.join(dirs.folderA, '1737318339699312031.mp4'), 'utf-8'), 'A');
    assert.equal(readFileSync(path.join(dirs.folderB, '1735360337668113923.mp4'), 'utf-8'), 'B');
    assert.equal(existsSync(path.join(dirs.inbox, '1737318339699312031.mp4')), false, '搬走之后收件箱里不该还留着');
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('认不出来的东西原样留着，一个都不许动', async () => {
  // 收件箱就是下载目录，里面全是不相干的文件。乱动就是事故。
  const dirs = makeDirs();
  try {
    put(dirs.inbox, '发票.pdf');
    put(dirs.inbox, '随手截的图.png');
    put(dirs.inbox, '9999999999999999999.mp4');   // 是视频，但品单里没有
    put(dirs.inbox, '未命名视频.mp4');              // 文件名里读不出商品ID
    const r = await routeInbox({ ...SETTINGS, inboxFolder: dirs.inbox }, accounts(dirs), [
      { productId: '1737318339699312031', account: '印尼1号' },
    ]);
    assert.equal(r.moved.length, 0);
    for (const name of ['发票.pdf', '随手截的图.png', '9999999999999999999.mp4', '未命名视频.mp4']) {
      assert.ok(existsSync(path.join(dirs.inbox, name)), `${name} 不该被动`);
    }
    // 视频文件要说明为什么没搬；非视频文件不啰嗦
    assert.equal(r.skipped.length, 2);
    assert.ok(r.skipped.every((s) => s.filename.endsWith('.mp4')));
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('目标文件夹已有同名文件时不覆盖，留在收件箱等人看', async () => {
  // 覆盖掉的可能是还没发出去的那条视频
  const dirs = makeDirs();
  try {
    put(dirs.inbox, '1737318339699312031.mp4', '新的');
    put(dirs.folderA, '1737318339699312031.mp4', '原来那条');
    const r = await routeInbox({ ...SETTINGS, inboxFolder: dirs.inbox }, accounts(dirs), [
      { productId: '1737318339699312031', account: '印尼1号' },
    ]);
    assert.equal(r.moved.length, 0);
    assert.equal(readFileSync(path.join(dirs.folderA, '1737318339699312031.mp4'), 'utf-8'), '原来那条');
    assert.equal(readFileSync(path.join(dirs.inbox, '1737318339699312031.mp4'), 'utf-8'), '新的');
    assert.match(r.skipped[0].reason, /已经有同名文件/);
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('刚写完的文件先不碰——可能还在下载', async () => {
  const dirs = makeDirs();
  try {
    put(dirs.inbox, '1737318339699312031.mp4', '半个文件', Date.now());
    const joblist = [{ productId: '1737318339699312031', account: '印尼1号' }];
    const r = await routeInbox({ ...SETTINGS, inboxFolder: dirs.inbox }, accounts(dirs), joblist);
    assert.equal(r.moved.length, 0);
    assert.equal(r.skipped.length, 0, '这不是"跳过"，只是还没轮到它，别打警告吓人');
    assert.ok(existsSync(path.join(dirs.inbox, '1737318339699312031.mp4')));

    // 静置够了就搬
    const later = await routeInbox({ ...SETTINGS, inboxFolder: dirs.inbox }, accounts(dirs), joblist,
      { now: Date.now() + 60 * 1000 });
    assert.equal(later.moved.length, 1);
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('品单里还没指定账号、或者账号不存在时，说清楚原因并留着文件', async () => {
  const dirs = makeDirs();
  try {
    put(dirs.inbox, '1737318339699312031.mp4');
    put(dirs.inbox, '1735360337668113923.mp4');
    const r = await routeInbox({ ...SETTINGS, inboxFolder: dirs.inbox }, accounts(dirs), [
      { productId: '1737318339699312031', account: '' },
      { productId: '1735360337668113923', account: '早就删掉的号' },
    ]);
    assert.equal(r.moved.length, 0);
    assert.match(r.skipped.find((s) => s.filename.startsWith('1737'))?.reason, /还没.*指定发布账号/);
    assert.match(r.skipped.find((s) => s.filename.startsWith('1735'))?.reason, /找不到/);
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('文件名带 (1) 这种重名后缀也认得出来', async () => {
  // 同一个品复刻多条视频，下载时浏览器会自动加 (1)(2)，发布端本来就按这个规则解析
  const dirs = makeDirs();
  try {
    put(dirs.inbox, '1737318339699312031 (2).mp4');
    const r = await routeInbox({ ...SETTINGS, inboxFolder: dirs.inbox }, accounts(dirs), [
      { productId: '1737318339699312031', account: '印尼1号' },
    ]);
    assert.equal(r.moved.length, 1);
    assert.ok(existsSync(path.join(dirs.folderA, '1737318339699312031 (2).mp4')), '文件名要原样保留，发布端靠它区分不同视频');
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('没填收件箱就是没开这个功能，什么都不做', async () => {
  const r = await routeInbox({ ...SETTINGS, inboxFolder: '' }, [], []);
  assert.equal(r.enabled, false);
  assert.equal(r.moved.length, 0);
});

test('收件箱路径填错要明确报错，不能默默什么都不干', async () => {
  await assert.rejects(
    routeInbox({ ...SETTINGS, inboxFolder: path.join(tmpdir(), '这个文件夹不存在-' + Date.now()) }, [], []),
    /收件箱文件夹不存在/
  );
});

// ===== 品单本身 =====

test('商品ID当字符串存，19位不能丢精度', () => {
  const id = '1737318339699312031';
  assert.equal(normalizeProductId(id), id);
  assert.equal(normalizeProductId(' 1737318339699312031 '), id);
  assert.equal(normalizeProductId('abc'), '');
  assert.equal(normalizeProductId(''), '');
  assert.notEqual(String(Number(id)), id, '这就是不能用 Number 的原因');
});

test('从选品插件的 CSV 导入，只认表头不认列的位置', () => {
  const csv = '﻿"分组","商品ID","商品","价格"\r\n' +
    '"合格新品","1737318339699312031","BELI 1 DAPAT 3 - Parfum","Rp24,653"\r\n' +
    '"合格新品","1735360337668113923","TAHU BULAT isi 50pcs","Rp13,750"\r\n';
  const { items } = importFromCsv(csv, { defaultAccount: '印尼1号' });
  assert.equal(items.length, 2);
  assert.equal(items[0].productId, '1737318339699312031');
  assert.equal(items[0].name, 'BELI 1 DAPAT 3 - Parfum');
  assert.equal(items[0].account, '印尼1号');
});

test('导入的表里没有商品ID列时，报错要说清楚该怎么办', () => {
  // 用旧版插件导出的表就是这样，光说"格式不对"会让人一头雾水
  assert.throws(
    () => importFromCsv('"分组","商品","价格"\r\n"合格新品","某商品","Rp1"\r\n'),
    /选品插件要 0\.12\.0 以上版本/
  );
});

test('重新导一次表，不能把已经指好的账号清掉', () => {
  // 这是最容易踩的：选完品先指账号，过两天补导一批新品，结果之前指的全没了
  const existing = [{ productId: '1737318339699312031', name: '旧名', account: '印尼1号', note: '爆过', addedAt: 1 }];
  const { items } = importFromCsv(
    '"商品ID","商品"\r\n"1737318339699312031","新名"\r\n"1735360337668113923","新品"\r\n',
    { defaultAccount: '印尼2号' }
  );
  const merged = mergeJoblist(existing, items);
  const old = findJob(merged.items, '1737318339699312031');
  assert.equal(old.account, '印尼1号', '已经指好的账号不能被默认账号覆盖');
  assert.equal(old.note, '爆过', '备注也要留着');
  assert.equal(old.name, '新名', '商品名可以用表里的新值');
  assert.equal(findJob(merged.items, '1735360337668113923').account, '印尼2号');
  assert.equal(merged.added, 1);
  assert.equal(merged.kept, 1);
});
