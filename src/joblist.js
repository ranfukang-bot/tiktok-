// 品单：一个品一行，从选品那一刻建起，一路走到发布。
//
// 为什么要有这么个东西：之前选品插件、Gemini 脚本、视频队列脚本各出各的文件，
// 格式还都不一样，中间靠人把数据端过去、靠"Excel第N行 ↔ 文件夹N"对齐。
// 一旦中间删一行插一行，整批全错位，而且不报错——要等视频挂到错的商品上才发现。
//
// 品单用【商品ID】当主键。商品ID就是 FastMoss 详情页地址末尾那串数字，
// 也正是发布时挂车要搜的那个，还正好是视频文件名的约定。一个ID贯穿全程。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', 'state');
const JOBLIST_PATH = path.join(STATE_DIR, 'joblist.json');

// 商品ID必须原样当字符串存。19位已经超出 Number 的安全整数范围，
// 一旦哪里走了 Number()，末尾几位会被悄悄改掉，然后就挂到别的商品上了。
export function normalizeProductId(value) {
  const text = String(value ?? '').trim();
  return /^\d{6,25}$/.test(text) ? text : '';
}

function normalizeItem(raw) {
  const productId = normalizeProductId(raw && raw.productId);
  if (!productId) return null;
  return {
    productId,
    name: String((raw && raw.name) || '').trim(),
    account: String((raw && raw.account) || '').trim(),
    note: String((raw && raw.note) || '').trim(),
    addedAt: Number.isFinite(raw && raw.addedAt) ? raw.addedAt : Date.now(),
  };
}

export function loadJoblist() {
  if (!existsSync(JOBLIST_PATH)) return [];
  let raw;
  try {
    raw = JSON.parse(readFileSync(JOBLIST_PATH, 'utf-8'));
  } catch (err) {
    throw new Error(`品单文件损坏(${JOBLIST_PATH})：${err.message}`);
  }
  const items = Array.isArray(raw) ? raw : raw.items;
  if (!Array.isArray(items)) return [];
  return items.map(normalizeItem).filter(Boolean);
}

export function saveJoblist(items) {
  if (!Array.isArray(items)) throw new Error('品单格式不对，应该是一个数组');
  const cleaned = [];
  const seen = new Set();
  for (const raw of items) {
    const item = normalizeItem(raw);
    if (!item) throw new Error(`品单里有一行的商品ID不合法：${JSON.stringify(raw && raw.productId)}。商品ID是 FastMoss 详情页地址末尾那串数字`);
    // 同一个ID留最后一条：重复了说明是改过的，后写的那条才是用户想要的
    if (seen.has(item.productId)) {
      cleaned[cleaned.findIndex((x) => x.productId === item.productId)] = item;
      continue;
    }
    seen.add(item.productId);
    cleaned.push(item);
  }
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(JOBLIST_PATH, JSON.stringify({ items: cleaned }, null, 2), 'utf-8');
  return cleaned;
}

export function findJob(items, productId) {
  const id = normalizeProductId(productId);
  return id ? items.find((item) => item.productId === id) || null : null;
}

// ===== 从选品插件导出的 CSV 导入 =====
//
// 只认表头名字，不认列的位置——插件以后加列减列都不会把这里搞崩。

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const body = text.replace(/^﻿/, ''); // 插件为了 Excel 能正确认中文加了 BOM
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quoted) {
      if (ch !== '"') { field += ch; continue; }
      if (body[i + 1] === '"') { field += '"'; i += 1; continue; }
      quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim()));
}

export function importFromCsv(text, { defaultAccount = '' } = {}) {
  const rows = parseCsv(String(text || ''));
  if (!rows.length) throw new Error('这份内容里没读到任何行');
  const header = rows[0].map((h) => h.trim());
  const idCol = header.findIndex((h) => h === '商品ID');
  const nameCol = header.findIndex((h) => h === '商品');
  if (idCol === -1) {
    throw new Error(
      `这份表里没有"商品ID"这一列（读到的表头是：${header.join(' / ') || '空'}）。` +
        '选品插件要 0.12.0 以上版本才会导出商品ID，请先更新插件重新导出'
    );
  }
  const items = [];
  const skipped = [];
  for (const row of rows.slice(1)) {
    const productId = normalizeProductId(row[idCol]);
    const name = nameCol === -1 ? '' : String(row[nameCol] || '').trim();
    if (!productId) {
      // 插件对读不到ID的商品会留空，不是错误，但得告诉用户是哪几个，免得以为导全了
      if (name) skipped.push(name);
      continue;
    }
    items.push({ productId, name, account: defaultAccount, note: '', addedAt: Date.now() });
  }
  if (!items.length) throw new Error('这份表里一条有效的商品ID都没有');
  return { items, skipped };
}

// 把导入的合并进现有品单：已经存在的ID保留原来的账号设置，不覆盖。
// 用户可能已经给某个品指好账号了，重新导一次表不该把它清掉。
export function mergeJoblist(existing, incoming) {
  const byId = new Map(existing.map((item) => [item.productId, item]));
  let added = 0;
  let kept = 0;
  for (const item of incoming) {
    const old = byId.get(item.productId);
    if (old) {
      byId.set(item.productId, { ...old, name: item.name || old.name });
      kept += 1;
    } else {
      byId.set(item.productId, item);
      added += 1;
    }
  }
  return { items: [...byId.values()], added, kept };
}
