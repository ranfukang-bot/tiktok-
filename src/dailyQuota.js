// 按账号自己配的时区(默认 Asia/Jakarta，即印尼WIB)算"今天"，账号每天最多发几条视频用这个限流。
// 用 Intl.DateTimeFormat 直接问系统"这个时区现在是哪一天"，不用自己算UTC偏移，
// 也不用惦记夏令时（印尼没有夏令时，但这个写法换成任何一个IANA时区都一样稳）。

export function currentDayKey(timezone, nowMs = Date.now()) {
  // en-CA 这个locale格式化出来正好是 YYYY-MM-DD，省得自己拼字符串
  // 用 Date.now() 而不是 new Date()：两者在生产里完全一样，但测试冻结时钟时
  // 只能拦住 Date.now，写成 new Date() 的话这里会漏出真实系统日期，
  // 导致"冻结了时钟"的测试其实只在某一天能过。
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nowMs));
}

// 自动确认与人工确认共用记账规则：按点击发布的日期，而不是收到确认的日期。
// 只维护今天的额度；昨天的发布不扣今天额度，也不覆盖今天已有的计数。
export function recordConfirmedQuota(state, timezone, nowMs = Date.now()) {
  const dayKey = currentDayKey(timezone, nowMs);
  const since = state.pendingSince;
  const publishedDay = Number.isFinite(since) && since > 0
    ? currentDayKey(timezone, since)
    : state.pendingSlot?.dayKey || dayKey;
  if (state.publishDayKey !== dayKey) {
    state.publishDayKey = dayKey;
    state.publishedToday = 0;
    state.slotsUsedToday = [];
  }
  // 极老记录连日期也没有时，保守地占今天一条额度，避免突破上限。
  if (publishedDay !== dayKey) return false;
  state.publishedToday = (state.publishedToday || 0) + 1;
  return true;
}

// 检查"今天"有没有变；跨天了就把这个账号的计数清零。
// 直接改传进来的state，返回是否发生了跨天重置，方便调用方决定要不要落盘/打日志。
export function rolloverIfNewDay(state, timezone) {
  const today = currentDayKey(timezone);
  if (state.publishDayKey === today) return false;
  state.publishDayKey = today;
  state.publishedToday = 0;
  state.slotsUsedToday = [];
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

// ===== 固定发布时间节点(按账号时区算) =====
//
// 跟上面的"时间段"是两种模式，二选一：
//   时间段：12:00-24:00 之间，只要有视频、间隔够了就发 —— 容易在时段一开始就连发几条。
//   时间节点：一天几个固定的波峰档口，每个档口最多发一条。
//
// 为什么要节点：带货的转化集中在几个波峰(午休、下班、晚高峰、睡前)，均匀铺开会把
// 额度浪费在流量低谷。而且一条带货视频需要两三个小时在初始流量池里跑完播和互动，
// 发太密后一条会直接截断前一条的流量。
//
// 【不补发】是这套逻辑的核心：视频做晚了，错过的节点就是错过了，不会在晚上把
// 四条硬塞进去。宁可今天少发，也不要在五个半小时里连发四条——那是被风控判
// "营销灌水"的典型特征，而且算法本来就没有"今天没发够就降权"这种机制。

export function parseHm(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

export function formatHm(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = Math.floor(minutes % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// FNV-1a。要的不是密码学强度，是【同一个账号+同一天+同一个节点，算出来永远一样】：
// 如果每次tick都重新random，目标时刻会一直漂移，永远也到不了点。
function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// 把今天的每个节点换算成具体时刻。节点在配置里是"11:30-12:30"这种当地时间，
// 开始上传的目标时刻是区间里的一个稳定随机点；不同账号可能撞在同一分钟。
export function slotTargetsForDay({ dayKey, timezone, slots, accountName }) {
  const [y, mo, d] = dayKey.split('-').map(Number);
  return slots.map((slot) => {
    const startMin = parseHm(slot.start);
    const endMin = parseHm(slot.end);
    const span = endMin - startMin;
    const jitter = span > 1 ? hash32(`${accountName}|${dayKey}|${slot.start}`) % span : 0;
    const targetMin = startMin + jitter;
    return {
      key: slot.start,
      label: slot.label || '',
      start: slot.start,
      end: slot.end,
      targetText: formatHm(targetMin),
      startMs: zonedTimeToUtcMs(y, mo, d, 0, startMin, 0, timezone),
      endMs: zonedTimeToUtcMs(y, mo, d, 0, endMin, 0, timezone),
      targetMs: zonedTimeToUtcMs(y, mo, d, 0, targetMin, 0, timezone),
    };
  }).sort((a, b) => a.startMs - b.startMs);
}

function nextDayKey(dayKey) {
  const [y, mo, d] = dayKey.split('-').map(Number);
  const next = new Date(Date.UTC(y, mo - 1, d) + 24 * 3600 * 1000);
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

// 现在这一刻该不该发。返回 due 非空就是"该发了"，其余情况都是安静地等——
// 不算错误，不暂停，不通知。
export function evaluateSlots({ nowMs, timezone, dayKey, slots, accountName, usedKeys = [] }) {
  const targets = slotTargetsForDay({ dayKey, timezone, slots, accountName });
  const used = new Set(usedKeys);

  // 到点了、这个节点今天还没用过、窗口还没过完 —— 三条都满足才发
  const due = targets.find((t) => !used.has(t.key) && nowMs >= t.targetMs && nowMs < t.endMs) || null;

  // 今天还剩几个能用的节点(没用过、窗口还没过完)
  const upcoming = targets.filter((t) => !used.has(t.key) && nowMs < t.endMs);

  let nextAt = null;
  if (due) {
    nextAt = nowMs;
  } else if (upcoming.length) {
    nextAt = upcoming[0].targetMs;
  } else if (targets.length) {
    // 今天发完了/全错过了，给个明天第一个节点的时刻，好在界面上显示"还要等多久"
    const tomorrow = slotTargetsForDay({ dayKey: nextDayKey(dayKey), timezone, slots, accountName });
    nextAt = tomorrow.length ? tomorrow[0].targetMs : null;
  }

  return { due, nextAt, remainingSlots: upcoming.length, targets };
}

// 真正提交视频文件前的准入检查：开浏览器/等页面时过点，就不要再新开上传。
// 一旦已开始上传，本轮允许跨截止时间完成，仍受安全检查和原有超时限制。
//
// err.slotExpired 这个标记是有分量的：调用方靠它把这种情况当作"安静跳过"，
// 而不是故障。要是漏了这个标记，过点放弃会被算成一次失败，攒够次数账号就被
// 暂停并推送通知了。
export function assertSlotCanStartUpload(slot, nowMs) {
  if (!slot || nowMs < slot.endMs) return;
  const err = new Error(
    `开始上传前已经过了 ${slot.start}-${slot.end} 这个时间节点，本次不再新开上传，` +
      '视频留在队列里等下一个节点'
  );
  err.slotExpired = true;
  throw err;
}

// 人工确认"已发布"时，该把哪个节点记成已用掉。
//
// 用的是这一条【当初发的时候】占的节点(pendingSlot)，不是确认那一刻的节点：
// 中午发的一条卡在结果不确定，人可能晚上19:45才来确认，按当前节点记账会把晚上
// 的节点白白占掉。跨天之后才确认的，那是昨天的节点，今天同名的节点必须留着。
// targets 是【当天】的节点时刻表，用来给没有 pendingSlot 的历史记录兜底。
export function creditedSlotOnConfirm(state, dayKey, targets = []) {
  const pending = state && state.pendingSlot;
  if (pending && pending.key) {
    return pending.dayKey === dayKey ? pending.key : null;
  }
  // 升级之前就卡在"待确认"的记录里没有 pendingSlot。这种不能当成"不需要记账"——
  // 原节点要是还没结束，确认完恢复后会在同一个节点里再发一条。
  // 好在 pendingSince(当初点发布的那一刻)从第一版就有，拿它反查当初落在哪个节点，
  // 比"按确认那一刻的节点算"准确得多。
  const since = state && state.pendingSince;
  if (!Number.isFinite(since)) return null;
  const hit = targets.find((t) => since >= t.startMs && since < t.endMs);
  return hit ? hit.key : null;
}
