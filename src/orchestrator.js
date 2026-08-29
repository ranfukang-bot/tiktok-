import { chromium } from 'playwright-core';
import { loadSettings, loadAccounts, resolveText, resolveHashtags } from './config.js';
import { createAdapter } from './browserAdapters/index.js';
import { createLogger } from './logger.js';
import { getState, setState, pause } from './stateStore.js';
import { scanDirectory, syncFilesIntoQueue } from './folderScanner.js';
import { runOneUploadCycle } from './browser/tiktokStudio.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInterval(min, max) {
  return min + Math.random() * (max - min);
}

const processingAccounts = new Set();
export function isAccountProcessing(name) {
  return processingAccounts.has(name);
}

export async function syncAccountFolder(account, settings, log) {
  const state = getState(account.name);
  let records;
  try {
    records = await scanDirectory(account.videoFolder, settings.videoExtensions);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`找不到文件夹 "${account.videoFolder}"，请检查路径是否正确、文件夹是否还在`);
    }
    throw err;
  }
  const result = syncFilesIntoQueue(state, records);
  setState(account.name, state);
  if (result.deferred) {
    log.info('本条正在等待发布结果确认，暂不同步文件夹');
    return result;
  }
  if (result.added || result.removed) {
    log.info(`文件夹同步：新增 ${result.added} 个，移除 ${result.removed} 个，队列共 ${result.total} 个`);
    if (result.resumed) log.info('▶️ 已移除缺失文件的旧记录，自动发布已恢复');
  } else {
    log.info(`扫描完成，文件夹和队列一致（共 ${result.total} 个）`);
  }
  return result;
}

async function findOrOpenStudioPage(browser) {
  const contexts = browser.contexts();
  for (const ctx of contexts) {
    for (const p of ctx.pages()) {
      if (p.url().includes('/tiktokstudio/')) return p;
    }
  }
  const ctx = contexts[0] || (await browser.newContext());
  const pages = ctx.pages();
  return pages[0] || (await ctx.newPage());
}

async function processAccountOnce(account, settings, adapter, log) {
  const state = getState(account.name);
  const nextIdx = state.doneIndex + 1;
  const item = state.items[nextIdx];
  if (!item) return;

  log.info(`账号到点，开始处理第 ${nextIdx + 1}/${state.items.length} 条: ${item.relativePath}`);

  const { wsEndpoint } = await adapter.startProfile(account);
  const browser = await chromium.connectOverCDP(wsEndpoint);
  try {
    const page = await findOrOpenStudioPage(browser);
    const config = {
      text: resolveText(settings, account),
      hashtagKeywords: resolveHashtags(settings, account),
    };

    const result = await runOneUploadCycle({
      page,
      account,
      item,
      config,
      log,
      beforePublishClick: async () => {
        const s = getState(account.name);
        s.pendingIndex = nextIdx;
        s.pendingSince = Date.now();
        setState(account.name, s);
      },
    });

    const latest = getState(account.name);
    if (result.published) {
      latest.doneIndex = nextIdx;
      latest.pendingIndex = null;
      latest.pendingSince = null;
      latest.nextTime = Date.now() + randomInterval(settings.minIntervalMs, settings.maxIntervalMs);
      setState(account.name, latest);
      log.info(`本条发布完成，下一条将在约 ${Math.round((latest.nextTime - Date.now()) / 60000)} 分钟后开始`);
    } else {
      pause(
        account.name,
        '点击发布后45秒仍未跳转到内容页，发布结果不确定；请打开该指纹浏览器人工核实TikTok内容列表，' +
          `确认后运行: node src/index.js resolve "${account.name}" --published 或 --retry`,
        'uncertain_publish'
      );
      log.warn('发布结果不确定，已暂停该账号，等待人工核实');
    }
  } finally {
    await browser.close().catch(() => {});
    if (settings.closeProfileAfterCycle) {
      await adapter.stopProfile(account).catch((err) => log.warn(`关闭指纹浏览器环境失败: ${err.message}`));
    }
  }
}

async function tickAccount(settings, account, adapters) {
  const log = createLogger(account.name);
  try {
    const state = getState(account.name);
    if (state.paused) return;
    if (!Number.isInteger(state.pendingIndex)) {
      await syncAccountFolder(account, settings, log);
    }

    const fresh = getState(account.name);
    if (fresh.paused || Number.isInteger(fresh.pendingIndex)) return;
    const nextIdx = fresh.doneIndex + 1;
    if (nextIdx >= fresh.items.length) return;
    if (Date.now() < fresh.nextTime) return;

    const adapter = adapters.get(account.browser);
    processingAccounts.add(account.name);
    try {
      await processAccountOnce(account, settings, adapter, log);
    } finally {
      processingAccounts.delete(account.name);
    }
  } catch (err) {
    log.error(`出错: ${err.message}`);
    pause(account.name, err.message, err.code || 'runtime');
  }
}

// 同一批次内的账号各自独立(各自的浏览器环境、各自的状态文件)，可以放心并发跑。
export async function tick(settings, accounts, adapters) {
  await Promise.all(accounts.map((account) => tickAccount(settings, account, adapters)));
}

function buildAdapters(settings, accounts) {
  const adapters = new Map();
  for (const kind of new Set(accounts.map((a) => a.browser))) {
    adapters.set(kind, createAdapter(kind, settings));
  }
  return adapters;
}

// 账号分组后组内并发跑，组间顺序跑，避免同一时刻启动过多指纹浏览器窗口。
export async function tickAll(settings, accounts) {
  const adapters = buildAdapters(settings, accounts);
  const concurrency = settings.concurrency || 1;
  for (let i = 0; i < accounts.length; i += concurrency) {
    const batch = accounts.slice(i, i + concurrency);
    await tick(settings, batch, adapters);
  }
}

export async function runOrchestrator() {
  const settings = loadSettings();
  const accounts = loadAccounts();
  console.log(`已加载 ${accounts.length} 个账号，并发数=${settings.concurrency || 1}，每 ${settings.folderScanIntervalMs / 1000}s 检查一次。Ctrl+C 退出。`);
  while (true) {
    await tickAll(loadSettings(), loadAccounts());
    await sleep(settings.folderScanIntervalMs);
  }
}
