// 把运行中的错误分成三类，决定是"自己重试"还是"停下来叫人"。
//
// ⚠️ 最重要的安全边界：只要有可能已经点过发布按钮，就绝对不能自动重试——
// 重试一次就可能把同一条视频发两遍。这种情况一律归到 never_retry，
// 必须由人打开TikTok后台核实过才能继续。
//
// 分类结果：
//   'never_retry' 立即暂停并通知，重试不安全或毫无意义
//   'config'      立即暂停并通知，是配置填错了，重试多少次都一样
//   'transient'   页面/网络的临时抽风，隔一会儿重试往往就好了

const NEVER_RETRY_CODES = new Set(['uncertain_publish']);

// 配置类：人不动手改，重试一万次也不会好
const CONFIG_PATTERNS = [
  /找不到文件夹/,
  /Require api-key/i,
  /无法使用API/,
  /请升级套餐/,
  /缺少 profileId/,
  /缺少 containerCode/,
  /缺少 browserId/,
  /未知的指纹浏览器类型/,
  /连不上比特浏览器本地API/,
  /本地API地址/,
];

// 内容/数据类：这条视频本身有问题，换个时间重试也是同样结果
const CONTENT_PATTERNS = [
  /版权或内容严重违规/,
  /已搜到，但单选框没有真正选中/,
  /商品.*没有真正选中/,
];

// 账号还没攒够历史话题标签：只能靠人先手动发一条建立记录，重试没用
const MISSING_HISTORY_TAG_PATTERNS = [/没找到历史话题.*的建议项/];

// 明确认定为"临时抽风"的信号；除此之外没匹配上的未知错误也按临时处理
// （因为发布前的所有步骤每轮都是从全新上传页重跑的，重试本身是安全的）。
const TRANSIENT_PATTERNS = [
  /等待元素超时/,
  /Timeout .*exceeded/i,
  /TikTok页面自己崩溃/,
  /net::ERR/i,
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND/,
  /fetch failed/i,
  /Target (page|closed)|Session closed|browser has been closed/i,
  /Draft\.js没有稳定清空/,
  /文案没有被全选/,
  /没有执行安全文案替换/,
  /话题标签.*重复出现/,
  /缺少话题标签/,
  /文案框为空或不可见/,
];

function matchesAny(patterns, text) {
  return patterns.some((re) => re.test(text));
}

// Playwright的报错后面会跟一大段"Call log:"调试细节，对你没用还刷屏，
// 展示给人看之前砍掉；分类用的仍然是完整原文。
export function briefMessage(message) {
  const cut = String(message).split(/\n\s*Call log:/i)[0].trim();
  return cut.length > 300 ? `${cut.slice(0, 300)}…` : cut;
}

/**
 * @param {Error} err
 * @param {{ publishAttempted?: boolean }} context
 *        publishAttempted: 本轮是否已经走到"点过发布按钮"那一步。
 *        只要是 true，无论错误内容是什么，一律 never_retry。
 */
export function classifyError(err, context = {}) {
  const message = (err && err.message) || String(err);
  const code = err && err.code;

  const brief = briefMessage(message);

  // 安全第一：已经可能点过发布了，任何错误都不许自动重试。
  if (context.publishAttempted) {
    return {
      kind: 'never_retry',
      code: 'uncertain_publish',
      reason: `发布过程中出错，且当时可能已经点过发布按钮，发布结果不确定：${brief}`,
    };
  }

  if (code && NEVER_RETRY_CODES.has(code)) {
    return { kind: 'never_retry', code, reason: brief };
  }

  if (matchesAny(CONFIG_PATTERNS, message)) {
    return { kind: 'config', code: 'config_error', reason: brief };
  }

  if (matchesAny(MISSING_HISTORY_TAG_PATTERNS, message)) {
    return { kind: 'never_retry', code: 'missing_history_tag', reason: brief };
  }

  if (matchesAny(CONTENT_PATTERNS, message)) {
    return { kind: 'never_retry', code: 'content_error', reason: brief };
  }

  if (matchesAny(TRANSIENT_PATTERNS, message)) {
    return { kind: 'transient', code: 'transient', reason: brief };
  }

  // 没见过的错误：按临时处理，但重试次数有限，连续失败够多次还是会叫人。
  return { kind: 'transient', code: 'unknown', reason: brief };
}

// 重试间隔：5分钟 → 15分钟 → 40分钟，之后放弃并叫人。
// 故意越退越久，避免TikTok那边真出问题时我们还在密集重试。
const DEFAULT_BACKOFF_MS = [5 * 60 * 1000, 15 * 60 * 1000, 40 * 60 * 1000];

export function retryDelayMs(attempt, backoff = DEFAULT_BACKOFF_MS) {
  if (attempt < 1) return backoff[0];
  return backoff[Math.min(attempt - 1, backoff.length - 1)];
}

export function maxRetries(backoff = DEFAULT_BACKOFF_MS) {
  return backoff.length;
}
