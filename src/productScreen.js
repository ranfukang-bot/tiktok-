// fastmoss 榜单导出的粗筛。
//
// 定位说清楚：这一步【替代不了扫码看详情】。fastmoss 的导出里没有广告佣金、
// 没有库存、"销量环比"那一列是空的，所以"广告佣金≥3%""库存≥1000""七天趋势
// 上升"这三条标准它一条都判断不了。
//
// 它能做的是把 50 条砍到 10 条左右，让你少扫 40 个码。真正的判断还是在扫码之后。
//
// 唯一 Excel 做不到、也是这个模块存在的理由：【记住你的判断】。榜单每次导出
// 会有大量重复的品，你扫码进去发现库存只有 200 否掉了，下次它又出现在榜上，
// Excel 不知道，你会再扫一遍。这里把判断按商品名存下来，下次直接标出来。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readSheet } from './xlsx.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', 'state');
const VERDICTS_PATH = path.join(STATE_DIR, 'product-verdicts.json');

// fastmoss 的中文表头。列顺序可能变，所以按名字找，不按位置。
const COLS = {
  rank: '排名',
  name: '商品名称',
  price: '商品售价',
  region: '国家/地区',
  shop: '所属店铺',
  shopSales: '店铺销量',
  category: '商品分类',
  commission: '佣金比例',
  sales: '销量',
  gmv: '销售额',
  totalSales: '总销量',
  status: '商品状态',
  listedAt: '预估商品上架时间',
};

// "Rp28,094  - 40,708" 这种区间取第一个数；"22%" 取 22；空/"-" 一律 null。
// 注意不能简单去掉所有非数字字符——"1,436" 去掉逗号是 1436，但
// "28,094 - 40,708" 全去掉会变成 2809440708，差好几个数量级。
function num(v) {
  if (v === null || v === undefined) return null;
  const first = String(v).split(/[-~]/)[0];
  const digits = first.replace(/[^\d.]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

export function loadVerdicts() {
  if (!existsSync(VERDICTS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(VERDICTS_PATH, 'utf-8'));
  } catch {
    // 判断记录坏了不该让整个功能瘫掉——大不了当作还没判断过，重新看一遍
    return {};
  }
}

export function saveVerdict(name, verdict, note = '') {
  if (!name) throw new Error('缺少商品名称');
  if (!['rejected', 'picked', ''].includes(verdict)) throw new Error('verdict 只能是 rejected / picked / 空');
  const all = loadVerdicts();
  if (!verdict) delete all[name];
  else all[name] = { verdict, note: String(note).slice(0, 200), at: new Date().toISOString() };
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(VERDICTS_PATH, JSON.stringify(all, null, 2));
  return all[name] || null;
}

/**
 * 读 fastmoss 导出的 xlsx，按门槛筛出候选。
 * @param {Buffer} buf xlsx 文件内容
 * @param {{minCommission?:number, minShopSales?:number, requireCommission?:boolean}} opts
 */
export function screenProducts(buf, opts = {}) {
  const minCommission = Number.isFinite(opts.minCommission) ? opts.minCommission : 8;
  const minShopSales = Number.isFinite(opts.minShopSales) ? opts.minShopSales : 0;
  const requireCommission = opts.requireCommission !== false;

  const rows = readSheet(buf);
  const header = rows[0].map((h) => String(h || '').trim());
  const idx = {};
  for (const [key, label] of Object.entries(COLS)) idx[key] = header.indexOf(label);

  if (idx.name < 0 || idx.commission < 0) {
    throw new Error(
      `这份表里找不到"商品名称"或"佣金比例"列，可能不是 fastmoss 的商品榜导出。` +
        `读到的表头是：${header.filter(Boolean).join(' / ')}`
    );
  }

  const verdicts = loadVerdicts();
  const cell = (r, key) => (idx[key] >= 0 ? r[idx[key]] : null);

  const all = [];
  for (const r of rows.slice(1)) {
    const name = String(cell(r, 'name') || '').trim();
    if (!name) continue;
    const sales = num(cell(r, 'sales'));
    const gmv = num(cell(r, 'gmv'));
    const commission = num(cell(r, 'commission'));
    const past = verdicts[name];
    all.push({
      rank: num(cell(r, 'rank')),
      name,
      commission,
      sales,
      gmv,
      // 客单价：表里没有这一列，用销售额÷销量算出来的
      avgPrice: sales && gmv ? Math.round(gmv / sales) : null,
      totalSales: num(cell(r, 'totalSales')),
      shop: String(cell(r, 'shop') || ''),
      shopSales: num(cell(r, 'shopSales')),
      category: String(cell(r, 'category') || ''),
      status: String(cell(r, 'status') || ''),
      listedAt: String(cell(r, 'listedAt') || '').slice(0, 10),
      priceText: String(cell(r, 'price') || ''),
      verdict: past ? past.verdict : '',
      verdictNote: past ? past.note : '',
      verdictAt: past ? past.at.slice(0, 10) : '',
    });
  }

  // 分类而不是直接丢弃：让用户看得到"筛掉了什么、为什么"，
  // 否则门槛调错了也不知道，只会觉得"怎么什么都没了"
  const reasons = { noCommission: 0, lowCommission: 0, smallShop: 0, offShelf: 0 };
  const passed = [];
  for (const p of all) {
    if (p.status && p.status !== '在售') { reasons.offShelf += 1; continue; }
    if (p.commission === null) {
      if (requireCommission) { reasons.noCommission += 1; continue; }
    } else if (p.commission < minCommission) { reasons.lowCommission += 1; continue; }
    if (minShopSales && p.shopSales !== null && p.shopSales < minShopSales) { reasons.smallShop += 1; continue; }
    passed.push(p);
  }

  // 佣金高的排前面；佣金一样时销量大的优先
  passed.sort((a, b) => (b.commission || 0) - (a.commission || 0) || (b.sales || 0) - (a.sales || 0));

  return {
    total: all.length,
    passed,
    reasons,
    // 这几项表里根本没有，UI 上要明说，免得用户以为筛完就不用扫码了
    missingFields: ['广告佣金', '库存数量', '近七天趋势（导出里的"销量环比"是空的）'],
  };
}
