import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', 'state');

export function slug(accountName) {
  return accountName.replace(/[^a-zA-Z0-9_\-一-龥]/g, '_');
}

function statePath(accountName) {
  return path.join(STATE_DIR, `${slug(accountName)}.json`);
}

function defaultState() {
  return {
    items: [],
    doneIndex: -1,
    pendingIndex: null,
    pendingSince: null,
    nextTime: Date.now(),
    paused: false,
    pauseReason: '',
    pauseCode: '',
    // 连续失败次数：成功一次就清零。达到上限后才真正暂停并叫人。
    consecutiveFailures: 0,
    // 下次自动重试的时间；没在重试等待中就是 null
    retryAt: null,
    lastError: '',
    // 这次暂停是否已经推送过通知，避免每轮循环重复轰炸
    notifiedForPause: false,
    // 每日发布额度：publishDayKey 是按配置时区算出来的"今天"(YYYY-MM-DD)，
    // 跟当前算出来的日期对不上就说明跨天了，publishedToday 会被清零重新计数。
    publishDayKey: '',
    publishedToday: 0,
    // 独立于文件队列保存，已发布视频被回收、重新扫描或重启后仍能限制同产品。
    publishedProductIdsToday: [],
    // 固定时间节点模式：今天已经用掉了哪几个节点(存节点的开始时间，如 "19:30")。
    // 跨天跟 publishedToday 一起清空。
    slotsUsedToday: [],
    // 正在等发布结果确认的那一条当初占的是哪个节点(含当天日期)。人工确认时按这份
    // 记账，而不是按"确认那一刻"的节点——中午发的不该占掉晚上的节点。
    pendingSlot: null,
    updatedAt: Date.now(),
  };
}

export function getState(accountName) {
  const file = statePath(accountName);
  if (!existsSync(file)) return defaultState();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    return { ...defaultState(), ...raw };
  } catch (err) {
    throw new Error(`账号 ${accountName} 的状态文件损坏(${file})：${err.message}`);
  }
}

export function setState(accountName, state) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  state.updatedAt = Date.now();
  writeFileSync(statePath(accountName), JSON.stringify(state, null, 2));
}

export function pause(accountName, reason, code = 'runtime') {
  const state = getState(accountName);
  state.paused = true;
  state.pauseReason = reason || '自动发布已暂停';
  state.pauseCode = code;
  state.retryAt = null;
  setState(accountName, state);
  return state;
}

export function resume(accountName) {
  const state = getState(accountName);
  state.paused = false;
  state.pauseReason = '';
  state.pauseCode = '';
  state.consecutiveFailures = 0;
  state.retryAt = null;
  state.lastError = '';
  state.notifiedForPause = false;
  setState(accountName, state);
  return state;
}

// 一轮成功后清掉所有失败痕迹
export function clearFailures(accountName) {
  const state = getState(accountName);
  state.consecutiveFailures = 0;
  state.retryAt = null;
  state.lastError = '';
  state.notifiedForPause = false;
  setState(accountName, state);
  return state;
}

// Windows 文件名不区分大小写；所有账号必须映射到不同的状态文件。
export function validateAccountNames(accounts) {
  const seen = new Map();
  for (const account of accounts) {
    const key = slug(account.name).toLowerCase();
    if (seen.has(key)) throw new Error(`账号名称对应同一个状态文件："${seen.get(key)}" 和 "${account.name}"，请换一个名称`);
    if (['joblist', 'product-verdicts'].includes(key)) throw new Error(`账号名称 "${account.name}" 与系统状态文件重名，请换一个名称`);
    seen.set(key, account.name);
  }
}

// 同步校验及迁移，中间不让出事件循环，避免检查通过后又开始处理旧账号。
// 先完整预检，再移动文件；品单或配置保存失败时把已移动的文件恢复。
export function renameAccountStates(renames, { isProcessing, commit }) {
  const moves = renames.map(({ from, to }) => {
    const state = getState(from);
    if (isProcessing(from) || isProcessing(to) || state.pendingIndex != null || state.pauseCode === 'uncertain_publish') {
      throw new Error(`账号 "${from}" 正在处理或发布结果尚未确认，请先处理完再改名`);
    }
    const source = statePath(from), target = statePath(to);
    const sameFile = source.toLowerCase() === target.toLowerCase();
    if (!sameFile && existsSync(target)) throw new Error(`新名称 "${to}" 已有状态文件，不能覆盖，请换一个名称`);
    return { source, target, sameFile };
  });
  const joblistPath = path.join(STATE_DIR, 'joblist.json');
  const originalJoblist = renames.length && existsSync(joblistPath) ? readFileSync(joblistPath, 'utf8') : null;
  let updatedJoblist;
  if (originalJoblist !== null) {
    updatedJoblist = JSON.parse(originalJoblist);
    const items = Array.isArray(updatedJoblist) ? updatedJoblist : updatedJoblist.items;
    if (!Array.isArray(items)) throw new Error('品单格式不对，无法安全更新改名引用');
    const mapping = new Map(renames.map(({ from, to }) => [from, to]));
    for (const item of items) if (mapping.has(item.account)) item.account = mapping.get(item.account);
  }
  const moved = [];
  try {
    for (const move of moves) {
      if (existsSync(move.source) && move.source !== move.target) {
        renameSync(move.source, move.target);
        moved.push(move);
      }
    }
    if (originalJoblist !== null) writeFileSync(joblistPath, JSON.stringify(updatedJoblist, null, 2));
    commit();
  } catch (err) {
    for (const move of moved.reverse()) renameSync(move.target, move.source);
    if (originalJoblist !== null) writeFileSync(joblistPath, originalJoblist);
    throw err;
  }
}
