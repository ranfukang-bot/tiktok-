import * as fs from 'node:fs';
import * as files from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { productIdFromFilename, resolveItemPath } from './folderScanner.js';

export const PRODUCT_ISSUE_LABELS = {
  out_of_stock: '没库存',
  not_in_showcase: '橱窗找不到商品',
  unavailable: '商品不可用',
};
const journalPath = fileURLToPath(new URL('../state/moved-videos.json', import.meta.url));
const csvHeader = '\uFEFF时间,账号,手机分组,原因,商品ID,文件名,现在位置,原来位置\r\n';

// 即使目标还未创建，也解析已存在的父目录，防止 junction / 符号链接绕过校验。
function canonical(dir) {
  try {
    return fs.realpathSync.native(dir);
  } catch (err) {
    if (err.code !== 'ENOENT' || path.dirname(dir) === dir) throw err;
    return path.join(canonical(path.dirname(dir)), path.basename(dir));
  }
}

function contains(parent, child) {
  if (process.platform === 'win32') {
    parent = parent.toLowerCase();
    child = child.toLowerCase();
  }
  const relative = path.relative(parent, child);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

export function validateProblemFolder(settings, accounts, destination = settings.problemFolder) {
  const value = String(destination ?? '').trim();
  if (!value) return '';
  const dir = path.resolve(value);
  const real = canonical(dir);
  const info = fs.statSync(real, { throwIfNoEntry: false });
  if (info && !info.isDirectory()) throw new Error('问题视频文件夹路径不是目录');
  const protectedDirs = [
    ...accounts.map(account => [account.videoFolder, `账号「${account.name}」的视频文件夹`]),
    [settings.inboxFolder, '收件箱'],
  ];
  for (const [folder, label] of protectedDirs) {
    if (!folder?.trim()) continue;
    const other = path.resolve(folder);
    const otherReal = canonical(other);
    if (contains(dir, other) || contains(other, dir) || contains(real, otherReal) || contains(otherReal, real)) {
      throw new Error(`问题视频文件夹不能与${label}相同或互相包含`);
    }
  }
  return real;
}

export function productMoveBreaker(value = 3) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 2) throw new Error('连续商品问题暂停阈值必须是至少 2 的整数');
  return number;
}

function safeAccountName(name) {
  const safe = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '_') || '_';
  return /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(safe) ? '_' + safe : safe;
}

function busy(err) { return err.code === 'EBUSY' || err.code === 'EPERM'; }

async function retryBusy(work, delay) {
  for (let retries = 0;; retries++) {
    try { return await work(); }
    catch (err) {
      if (!busy(err)) throw err;
      if (retries === 5) throw new Error('视频文件被占用，没能移走', { cause: err });
      await delay(2000);
    }
  }
}

async function reserveFilename(directory, filename, io, delay) {
  const { name, ext } = path.parse(filename);
  for (let n = 1;; n++) {
    const target = path.join(directory, n === 1 ? filename : `${name.replace(/\s*\(\d+\)$/, '')} (${n})${ext}`);
    try {
      await retryBusy(async () => {
        const handle = await io.open(target, 'wx');
        await handle.close();
      }, delay);
      return target;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

async function moveFile(source, target, io, delay) {
  try {
    try {
      await retryBusy(() => io.rename(source, target), delay);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      await retryBusy(() => io.copyFile(source, target), delay);
      const [original, copy] = await Promise.all([io.stat(source), io.stat(target)]);
      if (original.size !== copy.size) throw new Error('跨盘复制后视频大小不一致');
      await retryBusy(() => io.unlink(source), delay);
    }
  } catch (err) {
    try { await retryBusy(() => io.unlink(target), delay); }
    catch (cleanup) {
      if (cleanup.code !== 'ENOENT') throw new Error(`视频移动失败，且无法清理目标文件 ${target}：${cleanup.message}`, { cause: err });
    }
    throw err;
  }
}

function localTimestamp(date = new Date()) {
  const p = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

function readJournal() {
  try {
    const records = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    if (!Array.isArray(records)) throw new Error('moved-videos.json 记录格式不正确');
    return records;
  }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
}

function writeJournal(records) {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const temp = journalPath + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(records, null, 2), { flag: 'wx' });
    fs.renameSync(temp, journalPath);
  } finally { fs.rmSync(temp, { force: true }); }
}

function csvRow(record) {
  return [record.time, record.account, record.phoneGroup, record.reason, record.productId,
    record.filename, record.destination, record.source]
    .map(value => '"' + String(value).replaceAll('"', '""') + '"').join(',') + '\r\n';
}

// 每轮重试。同步更新 journal 和 CSV，避免不同账号同时完成时覆盖彼此的记录。
export function flushMovedVideoCsv(log, { append = fs.appendFileSync } = {}) {
  try {
    const records = readJournal();
    const pending = new Map();
    for (const row of records.filter(record => record.csvPending)) {
      if (!pending.has(row.problemFolder)) pending.set(row.problemFolder, []);
      pending.get(row.problemFolder).push(row);
    }
    for (const [folder, rows] of pending) {
      try {
        const target = path.join(folder, '移走记录.csv');
        const header = !fs.existsSync(target) || fs.statSync(target).size === 0 ? csvHeader : '';
        append(target, header + rows.map(csvRow).join(''), 'utf8');
        for (const row of rows) row.csvPending = false;
        writeJournal(records);
      } catch (err) {
        log?.warn(`移走记录.csv 暂时写不了，下轮补写：${err.message}`);
      }
    }
  } catch (err) { log?.warn(`读取移走记录失败：${err.message}`); }
}

export function movedVideoCountsToday(date = new Date()) {
  const day = localTimestamp(date).slice(0, 10);
  const counts = new Map();
  for (const record of readJournal()) {
    if (record.time.startsWith(day)) counts.set(record.account, (counts.get(record.account) || 0) + 1);
  }
  return counts;
}

export async function moveProductVideos({ account, productId, reason, items, validate, log },
  { io = files, delay = sleep, append } = {}) {
  const label = PRODUCT_ISSUE_LABELS[reason];
  let count = 0;
  let directory;
  for (const item of items) {
    const root = validate();
    directory = path.join(root, safeAccountName(account.name), label);
    validate(directory);
    await io.mkdir(directory, { recursive: true });
    const resolved = validate(directory);
    if (!contains(root, resolved)) throw new Error('问题视频子目录指向问题文件夹之外');
    const source = path.resolve(resolveItemPath(account.videoFolder, item));
    const filename = path.basename(source);
    if (!contains(canonical(path.resolve(account.videoFolder)), canonical(source)) ||
        productIdFromFilename(filename) !== productId) throw new Error('待移动视频路径或商品ID与队列记录不符');
    readJournal(); // 日志损坏时先停下，避免移走了却没有可恢复的记录。
    const destination = await reserveFilename(resolved, filename, io, delay);
    await moveFile(source, destination, io, delay);
    const records = readJournal();
    records.push({ time: localTimestamp(), account: account.name, phoneGroup: account.phoneGroup || '',
      reason: label, productId, filename, destination, source, problemFolder: root, csvPending: true });
    writeJournal(records);
    count++;
    flushMovedVideoCsv(log, { append });
  }
  return { count, directory };
}
