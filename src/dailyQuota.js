// 按账号自己配的时区(默认 Asia/Jakarta，即印尼WIB)算"今天"，账号每天最多发几条视频用这个限流。
// 用 Intl.DateTimeFormat 直接问系统"这个时区现在是哪一天"，不用自己算UTC偏移，
// 也不用惦记夏令时（印尼没有夏令时，但这个写法换成任何一个IANA时区都一样稳）。

export function currentDayKey(timezone) {
  // en-CA 这个locale格式化出来正好是 YYYY-MM-DD，省得自己拼字符串
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// 检查"今天"有没有变；跨天了就把这个账号的计数清零。
// 直接改传进来的state，返回是否发生了跨天重置，方便调用方决定要不要落盘/打日志。
export function rolloverIfNewDay(state, timezone) {
  const today = currentDayKey(timezone);
  if (state.publishDayKey === today) return false;
  state.publishDayKey = today;
  state.publishedToday = 0;
  return true;
}

export function hasQuotaRemaining(state, dailyLimit) {
  if (!Number.isFinite(dailyLimit)) return true; // 没设上限就不限制
  return (state.publishedToday || 0) < dailyLimit;
}
