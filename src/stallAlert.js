import { notify } from './notifier.js';

export const DEFAULT_CYCLE_ALERT_MS = 90 * 60 * 1000;
export const SCHEDULER_ALERT_MS = 30 * 60 * 1000;

// 独立的单次计时器：被监视的 Promise 不返回也能提醒；绝不参与重试或关闭窗口。
export function watchForStall(settings, { delayMs, text, account }, log) {
  const startedAt = Date.now();
  const timer = setTimeout(() => {
    log.warn(text);
    void notify(settings, {
      title: '⚠️ TikTok自动发布可能卡住',
      text: `${text}\n本轮开始时间：${new Date(startedAt).toISOString()}`,
      ...(account ? { account } : {}),
    }, log).catch(err => log.warn(`卡死提醒发送失败：${err.message}`));
  }, delayMs);
  timer.unref?.();
  return { startedAt, stop: () => clearTimeout(timer) };
}
