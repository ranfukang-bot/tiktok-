import { chromium } from 'playwright-core';
import {
  loadSettings,
  loadAccounts,
  resolveText,
  resolveHashtags,
  resolveDailyLimit,
  resolveTimezone,
  resolvePostingPlan,
} from './config.js';
import { createAdapter } from './browserAdapters/index.js';
import { createLogger } from './logger.js';
import { getState, setState, pause, clearFailures } from './stateStore.js';
import { scanDirectory, syncFilesIntoQueue, deletePublishedFile } from './folderScanner.js';
import { runOneUploadCycle } from './browser/tiktokStudio.js';
import { classifyError, retryDelayMs, maxRetries } from './errorPolicy.js';
import { notify } from './notifier.js';
import {
  rolloverIfNewDay,
  hasQuotaRemaining,
  isWithinPostingWindow,
  currentDayKey,
  evaluateSlots,
  assertSlotStillOpen,
} from './dailyQuota.js';

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

// quiet: 没有任何变化时不打日志。调度循环每 30 秒扫一次，不加这个会一直刷
// "扫描完成，文件夹和队列一致"；网页上手动点"扫描"时不传 quiet，照常给回音。
export async function syncAccountFolder(account, settings, log, { quiet = false } = {}) {
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
  } else if (!quiet) {
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

async function processAccountOnce(account, settings, adapter, log, slot = null) {
  const state = getState(account.name);
  const nextIdx = state.doneIndex + 1;
  const item = state.items[nextIdx];
  if (!item) return;

  log.info(`账号到点，开始处理第 ${nextIdx + 1}/${state.items.length} 条: ${item.relativePath}`);

  // 一旦置为true，说明这轮已经可能点过发布按钮了，任何后续错误都不许自动重试
  let publishAttempted = false;
  // 只有确认发布成功才关窗口。别的情况(报错、结果不确定)都要把窗口留着——
  // 那些情况的处理办法就是"人去打开这个号看一眼"，窗口关了就没得看了。
  let publishConfirmed = false;

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
          // 进流程时没过点，不代表现在没过点：上传+检查可能花掉十几二十分钟。
          // 这个检查必须在 publishAttempted 置true【之前】，否则一旦在这里中断，
          // 错误会被分类成"可能已经点过发布"，账号会被暂停等人确认——可我们
          // 恰恰是还没点。
          assertSlotStillOpen(slot, Date.now());
          publishAttempted = true;
          const s = getState(account.name);
          s.pendingIndex = nextIdx;
          s.pendingSince = Date.now();
          // 记下这一条是为哪个节点发的：万一发布结果不确定，人可能过几个小时才来
          // 确认，那时候得按【当初这个】节点记账，不能占掉确认那一刻的节点。
          s.pendingSlot = slot ? { key: slot.key, dayKey: slot.dayKey, start: slot.start, end: slot.end } : null;
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
      publishConfirmed = true;
      latest.doneIndex = nextIdx;
      latest.pendingIndex = null;
      latest.pendingSince = null;
      // 时间节点模式下由节点本身控制什么时候发，不能再叠一个随机间隔：
      // 那个间隔可能一睡就是两三个小时，足以让账号整个错过下一个节点。
      latest.nextTime = slot ? Date.now() : Date.now() + randomInterval(settings.minIntervalMs, settings.maxIntervalMs);
      // 极小概率跨天卡在这几十秒里，保险起见在计数前再判一次
      const rolledOver = rolloverIfNewDay(latest, resolveTimezone(settings, account));
      latest.publishedToday = (latest.publishedToday || 0) + 1;
      // 跨天了就别记了：这个节点属于昨天，记下来会把今天同名的节点白白占掉
      if (slot && !rolledOver) {
        latest.slotsUsedToday = [...new Set([...(latest.slotsUsedToday || []), slot.key])];
      }
      latest.pendingSlot = null;
      setState(account.name, latest);
      clearFailures(account.name);

      const dailyLimit = resolveDailyLimit(settings, account);
      if (!hasQuotaRemaining(latest, dailyLimit)) {
        log.info(
          `本条发布完成，今天已经发了 ${latest.publishedToday}/${dailyLimit} 条，额度用完，` +
            `等 ${resolveTimezone(settings, account)} 过完这一天再继续`
        );
      } else {
        log.info(
          slot
            ? `本条发布完成（${slot.key} 这个时间节点已用掉），等下一个时间节点`
            : `本条发布完成，下一条将在约 ${fmtMinutes(latest.nextTime - Date.now())} 分钟后开始`
        );
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
    // 先断开CDP连接，再让指纹浏览器客户端把这个环境正经关掉。
    // 顺序不能反：browser.close() 只是断开我们这端的连接，窗口还开着，
    // 真正释放那一千多MB内存的是 stopProfile。
    await browser.close().catch(() => {});

    // ⚠️ 这个 finally 里【绝对不能用 return】：finally 里的 return 会把正在往上抛的
    // 异常整个吞掉，报错就再也传不到 handleAccountError，账号既不会暂停也不会通知你。
    // 所以下面全用 if/else 分支。
    if (settings.closeProfileAfterCycle !== false) {
      if (!publishConfirmed) {
        // 只在确认发布成功之后才关。出错、或者发布结果不确定的时候，处理办法本来就是
        // "人打开这个号去看一眼"(看内容列表到底发出去没有、看是不是哪个检查开关被关了)，
        // 这时候关掉窗口等于把人要看的东西收走了。留着的那一千多MB是值的。
        log.info('这一轮没有确认发布成功，保留指纹浏览器窗口，方便你打开看一眼');
      } else {
        try {
          await adapter.stopProfile(account);
          log.info('已关闭该账号的指纹浏览器窗口，释放内存');
        } catch (err) {
          // 关不掉不影响这一条的发布结果，下一轮开窗口时指纹浏览器会自己处理已开着的环境，
          // 所以只提醒一句，不按失败处理、更不能因此把账号暂停。
          log.warn(`关闭指纹浏览器环境失败(不影响发布结果): ${err.message}`);
        }
      }
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
    // 文件夹同步放在下面那些闸门【之前】：闸门管的是"什么时候发"，不该顺带把
    // "界面上显示文件夹里还有几条"也一起冻住。节点模式一天只开四个一小时的窗口，
    // 放在闸门后面的话，你下午三点丢进去的视频要等到 16:30 才会在界面上出现，
    // 看着像程序坏了。这一步只是读一下本地目录，很便宜。
    if (!Number.isInteger(state.pendingIndex)) {
      await syncAccountFolder(account, settings, log, { quiet: true });
    }

    // 今天的额度用完了，安安静静跳过，不算错误也不用暂停/通知——按账号自己的时区过了0点自动恢复
    if (!hasQuotaRemaining(state, dailyLimit)) return;

    // 到点了没？两种模式都是"没到就安安静静跳过"，不暂停不通知。
    //
    // 时间节点模式(默认)：一天几个固定波峰档口，每个档口最多一条，【错过不补发】。
    // 视频做晚了就少发几条，绝不在晚上把当天额度硬塞完——五个半小时连发四条是
    // 被判"营销灌水"的典型特征，而且前一条还没在初始流量池里跑完就被下一条截断。
    //
    // 时间段模式(旧行为)：只要在时段内、间隔够了就发。
    const plan = resolvePostingPlan(settings);
    const dayKey = currentDayKey(timezone);
    let slot = null;
    if (plan.mode === 'slots') {
      const decision = evaluateSlots({
        nowMs: Date.now(),
        timezone,
        dayKey,
        slots: plan.slots,
        accountName: account.name,
        usedKeys: state.slotsUsedToday || [],
      });
      if (!decision.due) return;
      slot = { ...decision.due, dayKey };
    } else if (!isWithinPostingWindow(Date.now(), timezone, plan.window)) {
      return;
    }

    const fresh = getState(account.name);
    if (fresh.paused || Number.isInteger(fresh.pendingIndex)) return;
    const nextIdx = fresh.doneIndex + 1;
    if (nextIdx >= fresh.items.length) return;
    // nextTime 是【时段模式】那套随机发布间隔，节点模式下不该再看它：
    // 从时段模式升级过来的状态文件里可能留着一个几小时后的 nextTime，
    // 那会把整个 19:30-20:30 节点白白挡掉。失败退避用的是 retryAt，在上面单独判。
    if (plan.mode === 'window' && Date.now() < fresh.nextTime) return;

    const adapter = adapters.get(account.browser);
    processingAccounts.add(account.name);
    try {
      await processAccountOnce(account, settings, adapter, log, slot);
    } finally {
      processingAccounts.delete(account.name);
    }
  } catch (err) {
    // 过点放弃不是故障：不计失败、不暂停、不通知，视频留在队列里等下一个节点
    if (err.slotExpired) {
      log.info(err.message);
      return;
    }
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
      howToFix = '这属于配置问题，重试也没用。在控制台网页上点这个账号的"编辑"核对一下环境ID/视频文件夹和页面结构，或者检查指纹浏览器客户端是不是开着';
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
