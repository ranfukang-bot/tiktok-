// 账号真正需要人处理时给你推一条消息，免得你一直开着网页盯。
// 支持几种常见渠道，配好哪个就用哪个；没配就静默跳过（不影响主流程）。
//
// 通知失败绝不能影响发布本身：所有发送都包了超时和try/catch，
// 失败只写日志，不往上抛。

const SEND_TIMEOUT_MS = 10000;

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

const PROVIDERS = {
  // Telegram 机器人：跟 @BotFather 要 botToken，再把机器人拉进对话拿 chatId
  async telegram(cfg, { title, text }) {
    if (!cfg.botToken || !cfg.chatId) throw new Error('Telegram 需要填 botToken 和 chatId');
    await postJson(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
      chat_id: cfg.chatId,
      text: `${title}\n\n${text}`,
    });
  },

  // 企业微信群机器人：群设置里添加机器人后拿到的 Webhook 地址
  async wecom(cfg, { title, text }) {
    if (!cfg.webhookUrl) throw new Error('企业微信需要填 webhookUrl');
    await postJson(cfg.webhookUrl, {
      msgtype: 'text',
      text: { content: `${title}\n\n${text}` },
    });
  },

  // Bark（iOS推送App）：把App里给的地址填进来即可
  async bark(cfg, { title, text }) {
    if (!cfg.serverUrl) throw new Error('Bark 需要填 serverUrl');
    const base = cfg.serverUrl.replace(/\/$/, '');
    await postJson(base, { title, body: text, group: 'TikTok发布' });
  },

  // 自定义 webhook：原样POST一个JSON过去，方便你接自己的系统
  async webhook(cfg, payload) {
    if (!cfg.url) throw new Error('自定义webhook需要填 url');
    await postJson(cfg.url, payload, cfg.headers || {});
  },
};

export function listProviders() {
  return Object.keys(PROVIDERS);
}

/**
 * 发送一条通知。
 * @param {object} settings 全局设置（读 settings.notifications）
 * @param {{title: string, text: string, account?: string}} payload
 * @param {{info: Function, warn: Function}} [log]
 * @returns {Promise<{sent: boolean, skipped?: string, error?: string}>}
 */
export async function notify(settings, payload, log) {
  const cfg = (settings && settings.notifications) || {};
  if (!cfg.enabled) return { sent: false, skipped: '通知未启用' };

  const provider = PROVIDERS[cfg.provider];
  if (!provider) return { sent: false, skipped: `未知的通知渠道: ${cfg.provider}` };

  try {
    await provider(cfg[cfg.provider] || {}, payload);
    return { sent: true };
  } catch (err) {
    // 通知发不出去是小事，绝不能因此打断发布流程
    if (log) log.warn(`通知发送失败(${cfg.provider}): ${err.message}`);
    return { sent: false, error: err.message };
  }
}

// 供网页上"发送测试通知"按钮用；这个要把错误抛出来，好让用户看到哪里配错了
export async function sendTestNotification(settings) {
  const cfg = (settings && settings.notifications) || {};
  if (!cfg.enabled) throw new Error('通知功能还没启用，请先勾选启用并保存设置');
  const provider = PROVIDERS[cfg.provider];
  if (!provider) throw new Error(`未知的通知渠道: ${cfg.provider}`);
  await provider(cfg[cfg.provider] || {}, {
    title: '✅ TikTok批量发布控制台 测试通知',
    text: '能看到这条消息说明通知配置成功了。真正需要你处理的时候才会推送，不会打扰你。',
  });
}
