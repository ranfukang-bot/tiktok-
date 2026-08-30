import { chromium } from 'playwright-core';
import {
  loadSettings,
  loadAccounts,
  resolveText,
  resolveHashtags,
  resolveDailyLimit,
  resolveTimezone,
  findMissingRequiredText,
  textKeyLabel,
} from './config.js';
import { createAdapter } from './browserAdapters/index.js';
import { createLogger } from './logger.js';
import { getState, setState, pause, clearFailures } from './stateStore.js';
import { scanDirectory, syncFilesIntoQueue, deletePublishedFile } from './folderScanner.js';
import { runOneUploadCycle } from './browser/tiktokStudio.js';
import { classifyError, retryDelayMs, maxRetries } from './errorPolicy.js';
import { notify } from './notifier.js';
import { rolloverIfNewDay, hasQuotaRemaining } from './dailyQuota.js';

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

function fmtMinutes(ms) {
  return Math.max(1, Math.round(ms / 60000));
}

// 真正需要人来处理时才走这里：暂停账号 + 推送通知（每次暂停只推一条）
async function pauseAndNotify(account, settings, { reason, code, log, howToFix }) {
  const state = pause(account.name, reason, code);
  // 具体错误内容由调用方负责打印，这里只说明"停了、需要人管"，避免同一段长报错刷两遍
  log.warn('已暂停该账号，需要你处理');

  if (state.notifiedForPause) return;
  const lines = [`账号：${account.name}`, '', reason];
  if (howToFix) lines.push('', `怎么处理：${howToFix}`);
  const result = await notify(
    settings,
    { title: '⚠️ TikTok自动发布需要你处理', text: lines.join('\n'), account: account.name },
    log
  );
  if (result.sent) {
    const latest = getState(account.name);
    latest.notifiedForPause = true;
    setState(account.name, latest);
    log.info('已推送通知');
  }
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

  // 开浏览器之前先自检文案配置。放在 startProfile 之前是有意的：配置不全的话
  // 没必要先把指纹浏览器窗口拉起来再失败。网页上的保存校验能被绕过(手改
  // accounts.json、校验上线前就存在的老账号、直接改 settings.json)，这里是最后一道。
  const missingText = findMissingRequiredText(settings, account);
  if (missingText.length) {
    throw new Error(
      `界面文案配置缺失：这个账号缺少 ${missingText.map(textKeyLabel).join('、')}，` +
        '其中版权/违规提示、商品弹窗这类是安全判断，缺了不会报错但保护是关着的。' +
        '请在控制台网页上编辑该账号，把界面文案填完整后再继续'
    );
  }

  // 一旦置为true，说明这轮已经可能点过发布按钮了，任何后续错误都不许自动重试
  let publishAttempted = false;

  const { wsEndpoint } = await adapter.startProfile(account);
  const browser = await chromium.connectOverCDP(wsEndpoint);
  try {
    const page = await findOrOpenStudioPage(browser);
    const config = {
      text: resolveText(settings, account),
      hashtagKeywords: resolveHashtags(settings, account),
    };

    let result;
    try {
      result = await runOneUploadCycle({
        page,
        account,
        item,
        config,
        log,
        beforePublishClick: async () => {
          publishAttempted = true;
          const s = getState(account.name);
          s.pendingIndex = nextIdx;
          s.pendingSince = Date.now();
          setState(account.name, s);
        },
      });
    } catch (err) {
      // 把"是否已经点过发布"这个关键信息带给上层的错误分类逻辑
      err.publishAttempted = publishAttempted;
      throw err;
    }

    const latest = getState(account.name);
    if (result.published) {
      latest.doneIndex = nextIdx;
      latest.pendingIndex = null;
      latest.pendingSince = null;
      latest.nextTime = Date.now() + randomInterval(settings.minIntervalMs, settings.maxIntervalMs);
      // 极小概率跨天卡在这几十秒里，保险起见在计数前再判一次
      rolloverIfNewDay(latest, resolveTimezone(settings, account));
      latest.publishedToday = (latest.publishedToday || 0) + 1;
      setState(account.name, latest);
      clearFailures(account.name);

      const dailyLimit = resolveDailyLimit(settings, account);
      if (!hasQuotaRemaining(latest, dailyLimit)) {
        log.info(
          `本条发布完成，今天已经发了 ${latest.publishedToday}/${dailyLimit} 条，额度用完，` +
            `等 ${resolveTimezone(settings, account)} 过完这一天再继续`
        );
      } else {
        log.info(`本条发布完成，下一条将在约 ${fmtMinutes(latest.nextTime - Date.now())} 分钟后开始`);
      }
      if (settings.deleteAfterPublish !== false) {
        await deletePublishedFile(account.videoFolder, item, log);
      }
    } else {
      await pauseAndNotify(account, settings, {
        reason: '点击发布后没等到跳转，这一条到底发出去没有不确定，已停下等你确认（不会自动重试，避免同一条发两遍）',
        code: 'uncertain_publish',
        howToFix: '打开这个账号的指纹浏览器看一眼TikTok内容列表，然后在控制台网页上点"确认已发布"或"确认未发布，重试"',
        log,
      });
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
    // 上一轮失败后正在等待重试，时间没到就先不动
    if (Number.isFinite(state.retryAt) && Date.now() < state.retryAt) return;

    const timezone = resolveTimezone(settings, account);
    const dailyLimit = resolveDailyLimit(settings, account);
    if (rolloverIfNewDay(state, timezone)) {
      setState(account.name, state);
      log.info(`${timezone} 进入新的一天，今日发布额度已刷新`);
    }
    // 今天的额度用完了，安安静静跳过，不算错误也不用暂停/通知——按账号自己的时区过了0点自动恢复
    if (!hasQuotaRemaining(state, dailyLimit)) return;

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
    await handleAccountError(account, settings, err, log);
  }
}

// 出错之后的决策：自己重试，还是停下来叫人
async function handleAccountError(account, settings, err, log) {
  const verdict = classifyError(err, { publishAttempted: err.publishAttempted });
  log.error(`出错: ${verdict.reason}`);

  const backoff = settings.retryBackoffMs;
  const limit = maxRetries(backoff);

  if (verdict.kind !== 'transient') {
    let howToFix;
    if (verdict.code === 'missing_history_tag') {
      howToFix = '这个账号自己打开TikTok Studio手动发一条带上这个话题标签的作品，TikTok记住之后再点控制台网页上的"继续"';
    } else if (verdict.kind === 'config') {
      howToFix = '这属于配置问题，重试也没用。在控制台网页上点这个账号的"编辑"核对一下环境ID/视频文件夹/界面语言，或者检查指纹浏览器客户端是不是开着';
    } else {
      howToFix = '这一条需要你人工看一眼再决定怎么处理，处理完在控制台网页上点"继续"';
    }
    await pauseAndNotify(account, settings, { reason: verdict.reason, code: verdict.code, howToFix, log });
    return;
  }

  const state = getState(account.name);
  const failures = (state.consecutiveFailures || 0) + 1;

  if (failures > limit) {
    await pauseAndNotify(account, settings, {
      reason: `连续失败 ${failures} 次，已经自动重试过 ${limit} 次仍然不行，最后一次的错误是：${verdict.reason}`,
      code: 'retry_exhausted',
      howToFix: '看一下控制台网页底部的运行日志，找到反复失败的那一步；处理完点"继续"',
      log,
    });
    return;
  }

  const delay = retryDelayMs(failures, backoff);
  state.consecutiveFailures = failures;
  state.retryAt = Date.now() + delay;
  state.lastError = verdict.reason;
  setState(account.name, state);
  log.warn(`看起来是临时问题，${fmtMinutes(delay)} 分钟后自动重试（第 ${failures}/${limit} 次），暂时不打扰你`);
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
