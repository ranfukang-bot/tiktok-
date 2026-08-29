import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', 'state');

function slug(accountName) {
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
