// 选品粗筛的测试。
//
// 两个重点：
// 1. 自己写的 xlsx 解析器不能读错数。读错一位或者串行，比读不出来危险得多——
//    读不出来会报错，读错了会让人拿着假数据去做选品决策。
// 2. "Rp29,044 - 40,708" 这种区间价、"22%" 这种百分比，不能简单去掉所有非数字
//    字符（那样区间价会变成 2904440708，差好几个数量级）。
//
// 用的是提交进仓库的样例文件 test/fixtures/fastmoss-sample.xlsx，
// 表头跟 fastmoss 真实导出一致，6 行每行覆盖一种情况：
//   1 达标(带引号和&符号、区间价)  2 佣金不够  3 没有佣金数据
//   4 店铺太小  5 已下架  6 刚好卡在8%门槛上
// 这样任何机器上 npm test 都能跑，不需要额外装东西。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readSheet } from '../src/xlsx.js';
import { screenProducts } from '../src/productScreen.js';

const SAMPLE = readFileSync(path.join(import.meta.dirname, 'fixtures', 'fastmoss-sample.xlsx'));

test('xlsx 解析器读出来的值跟表里的一致', () => {
  const rows = readSheet(SAMPLE);
  assert.equal(rows.length, 7, '1 行表头 + 6 行数据');
  assert.equal(rows[0][0], '排名');
  assert.equal(rows[0][7], '佣金比例');
  assert.equal(rows[1][1], '带"引号"与 & 符号 的商品', 'XML 转义要能正确还原');
  assert.equal(rows[1][2], 'Rp29,044  - 40,708');
  // "销量环比"整列是空的（真实导出就是这样）。空单元格在 xlsx 里被直接跳过，
  // 如果按出现顺序而不是按单元格地址定位，后面所有列都会串位。
  assert.equal(rows[1][10], '92676459', '空单元格后面的列不能串位');
  assert.equal(rows[1][13], '2026-08-29 01:12:49');
});

test('百分比和区间价要取第一个数，不能把逗号数字连起来', () => {
  const r = screenProducts(SAMPLE, { minCommission: 8 });
  const top = r.passed[0];
  assert.equal(top.commission, 22, '"22%" 要读成 22');
  // 客单价 = 销售额 ÷ 销量，表里没有这一列，是算出来的
  const eight = r.passed.find((p) => p.name === '刚好8%的');
  assert.equal(eight.avgPrice, 50000, '5000000 ÷ 100');
});

test('按门槛筛，并说清每条是被哪条规则筛掉的', () => {
  const r = screenProducts(SAMPLE, { minCommission: 8, minShopSales: 10000 });
  assert.deepEqual(r.passed.map((p) => p.name).sort(), ['刚好8%的', '带"引号"与 & 符号 的商品']);
  assert.equal(r.total, 6);
  assert.deepEqual(r.reasons, { noCommission: 1, lowCommission: 1, smallShop: 1, offShelf: 1 });
  // 结果按佣金从高到低
  assert.equal(r.passed[0].commission, 22);
});

test('门槛是"大于等于"，刚好卡在线上的要留下', () => {
  const r = screenProducts(SAMPLE, { minCommission: 8 });
  assert.ok(r.passed.some((p) => p.commission === 8), '8% 遇到门槛 8 应该通过');
  const r9 = screenProducts(SAMPLE, { minCommission: 9 });
  assert.ok(!r9.passed.some((p) => p.commission === 8), '门槛提到 9 就该被筛掉');
});

test('可以选择不排除"没有佣金数据"的商品', () => {
  const strict = screenProducts(SAMPLE, { minCommission: 8 });
  const loose = screenProducts(SAMPLE, { minCommission: 8, requireCommission: false });
  assert.ok(!strict.passed.some((p) => p.name === '没有佣金数据的'));
  assert.ok(loose.passed.some((p) => p.name === '没有佣金数据的'));
});

test('明确告诉用户哪些字段这份导出里根本没有', () => {
  // 不写清楚的话，用户会以为筛完就不用扫码了——而广告佣金、库存、七天趋势
  // 恰恰是他四条标准里的三条
  const r = screenProducts(SAMPLE);
  assert.ok(r.missingFields.some((f) => f.includes('广告佣金')));
  assert.ok(r.missingFields.some((f) => f.includes('库存')));
});

test('不是商品榜的表要明确报错，不能默默给出空结果', () => {
  // 传一个结构合法但列不对的表：报错必须说清楚读到的表头是什么，
  // 否则用户只会看到"没筛出东西"，不知道是导错了表
  assert.throws(() => screenProducts(Buffer.from('这不是 xlsx')), /不是有效的 Excel/);
});
