import { loadSettings, loadAccounts, loadAllAccounts, resolveDailyLimit, resolveTimezone } from './config.js';
import { tickAll, isAccountProcessing, syncAccountFolder } from './orchestrator.js';
import { getState, setState } from './stateStore.js';
import { createLogger } from './logger.js';
import { deletePublishedFile } from './folderScanner.js';
import { currentDayKey } from './dailyQuota.js';

let running = false;
let loopPromise = null;
let lastTickError = null;
let lastTickAt = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loop() {
  while (running) {
    try {
      const settings = loadSettings();
      const accounts = loadAccounts();
      await tickAll(settings, accounts);
      lastTickError = null;
    } catch (err) {
      lastTickError = err.message;
      console.error('调度循环出错:', err);
    }
    lastTickAt = Date.now();
    const settings = loadSettings();
    await sleep(settings.folderScanIntervalMs || 30000);
  }
}

export function start() {
  if (running) return;
  running = true;
  loopPromise = loop();
}

export function stop() {
  running = false;
}

export function isRunning() {
  return running;
}

export function getStatus() {
  let accounts = [];
  let settingsError = null;
  try {
    const settings = loadSettings();
    accounts = loadAccounts().map((account) => {
      const state = getState(account.name);
      const timezone = resolveTimezone(settings, account);
      const dailyLimit = resolveDailyLimit(settings, account);
      // 这里只算展示用的数字，不落盘：真正的跨天重置由调度循环下一轮tick做，
      // GET接口不该有副作用。跨天了就当作今天还没发过来显示，不用等下一轮tick。
      const publishedToday = state.publishDayKey === currentDayKey(timezone) ? state.publishedToday || 0 : 0;
      return {
        name: account.name,
        browser: account.browser,
        videoFolder: account.videoFolder,
        total: state.items.length,
        doneIndex: state.doneIndex,
        remaining: Math.max(0, state.items.length - (state.doneIndex + 1)),
        paused: state.paused,
        pauseReason: state.pauseReason,
        pauseCode: state.pauseCode,
        nextTime: state.nextTime,
        processing: isAccountProcessing(account.name),
        consecutiveFailures: state.consecutiveFailures || 0,
        retryAt: state.retryAt,
        lastError: state.lastError,
        publishedToday,
        dailyLimit: Number.isFinite(dailyLimit) ? dailyLimit : null,
        quotaExhausted: Number.isFinite(dailyLimit) && publishedToday >= dailyLimit,
      };
    });
    void settings;
  } catch (err) {
    settingsError = err.message;
  }
  return { running, lastTickAt, lastTickError, settingsError, accounts };
}

export async function resolveUncertain(accountName, decision) {
  const state = getState(accountName);
  if (state.pauseCode !== 'uncertain_publish') {
    throw new Error(`账号 "${accountName}" 当前不是"发布结果不确定"状态`);
  }
  const settings = loadSettings();
  let publishedItem = null;
  if (decision === 'published') {
    const uncertainIndex = state.doneIndex + 1;
    if (uncertainIndex < state.items.length) {
      publishedItem = state.items[uncertainIndex];
      state.doneIndex = uncertainIndex;
    }
    state.nextTime = Date.now() + settings.minIntervalMs + Math.random() * (settings.maxIntervalMs - settings.minIntervalMs);
  } else {
    state.nextTime = Date.now();
  }
  state.paused = false;
  state.pauseReason = '';
  state.pauseCode = '';
  state.pendingIndex = null;
  state.pendingSince = null;
  setState(accountName, state);

  if (publishedItem && settings.deleteAfterPublish !== false) {
    const account = loadAllAccounts().find((a) => a.name === accountName);
    if (account) {
      const log = createLogger(accountName);
      await deletePublishedFile(account.videoFolder, publishedItem, log);
    }
  }
}

// 手动触发一次文件夹扫描，不需要先启动整个自动发布循环，方便添加账号后马上验证路径对不对。
export async function scanAccountNow(accountName) {
  const account = loadAllAccounts().find((a) => a.name === accountName);
  if (!account) throw new Error(`没找到账号 "${accountName}"`);
  const settings = loadSettings();
  const log = createLogger(accountName);
  return syncAccountFolder(account, settings, log);
}

export function setAccountPaused(accountName, paused) {
  const state = getState(accountName);
  state.paused = paused;
  if (!paused) {
    state.pauseReason = '';
    state.pauseCode = '';
  } else {
    state.pauseReason = state.pauseReason || '用户手动暂停';
    state.pauseCode = state.pauseCode || 'user';
  }
  setState(accountName, state);
}
