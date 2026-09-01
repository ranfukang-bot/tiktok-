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

// ===== 允许发布的时间段(按账号时区算) =====
//
// 目的：额度是按当地0点刷新的，但"刚过0点就有额度"不代表"这时候该发"——
// 文件夹里堆着视频的话，会变成凌晨几点连发好几条，没有真人会这样发布。
// 用一个"允许发布的时段"（比如中午12点到午夜0点）把这种情况挡住。

// 把某个时区当前的年月日时分秒拆开。用 Intl 当唯一的时区数据来源，不自己维护偏移表。
function zonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

// 反过来：把"某时区的某年某月某日几点几分几秒"换算成UTC毫秒时间戳。
// 用两轮收敛而不是查夏令时表——先猜一个UTC时刻，看它在目标时区显示成几点，
// 跟目标差多少就把猜测值挪多少，重复一次基本就收敛了，这道题不需要严格到秒。
function zonedTimeToUtcMs(y, mo, d, h, mi, s, timezone) {
  // desiredAsUtc 必须是【固定不变】的基准，每一轮都拿它减掉当前猜测值对应的时区偏移。
  // 之前写成 `guess += guess - shownAsUtc`（拿 guess 自己滚动更新）在第二轮会拿已经
  // 修正过的 guess 再去和它自己比较，得到的偏移不再是"目标时刻的偏移"，会把结果
  // 反向修正回错的值——用真实数据测才发现这个：12:00 被算成了 5:00。
  const desiredAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = desiredAsUtc;
  for (let i = 0; i < 2; i++) {
    const shown = zonedParts(new Date(guess), timezone);
    const shownAsUtc = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second);
    const offset = shownAsUtc - guess; // 这个候选时刻在目标时区显示的墙钟，比UTC快多少
    guess = desiredAsUtc - offset;
  }
  return guess;
}

export function isWithinPostingWindow(nowMs, timezone, window) {
  if (!window.enabled) return true;
  const p = zonedParts(new Date(nowMs), timezone);
  const hourOfDay = p.hour + p.minute / 60 + p.second / 3600;
  return hourOfDay >= window.startHour && hourOfDay < window.endHour;
}

// 时段外时，算出"下一次进入时段"是什么时候(UTC毫秒)，用来在日志里告诉用户还要等多久。
export function nextPostingWindowStartMs(nowMs, timezone, window) {
  const p = zonedParts(new Date(nowMs), timezone);
  const hourOfDay = p.hour + p.minute / 60 + p.second / 3600;
  if (hourOfDay < window.startHour) {
    return zonedTimeToUtcMs(p.year, p.month, p.day, window.startHour, 0, 0, timezone);
  }
  // 已经过了今天的时段(含 hourOfDay >= endHour 的情况)：等明天的时段开始
  const tomorrowNoonish = new Date(zonedTimeToUtcMs(p.year, p.month, p.day, 12, 0, 0, timezone) + 24 * 3600 * 1000);
  const t = zonedParts(tomorrowNoonish, timezone);
  return zonedTimeToUtcMs(t.year, t.month, t.day, window.startHour, 0, 0, timezone);
}
