// 允许发布时间段的时区换算测试。
//
// 这里守的是一个真实踩过的坑：zonedTimeToUtcMs 的两轮收敛算法第一版写错了，
// 拿本该固定不变的目标墙钟时间去跟【已经修正过一次的猜测值】反复比较，导致
// 第二轮把结果又崩偏了——本地时间"中午12点"被算成了"凌晨5点"，而且是纯数学
// 问题，不跑一次真实换算完全看不出来，语法检查更查不出来。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isWithinPostingWindow, nextPostingWindowStartMs } from '../src/dailyQuota.js';

const W = { enabled: true, startHour: 12, endHour: 24 };

// 雅加达 UTC+7，全年无夏令时，方便手算验证
function utcForJakarta(y, mo, d, h, mi = 0) {
  return Date.UTC(y, mo - 1, d, h - 7, mi);
}

test('时段边界判断（雅加达当地时间）', () => {
  assert.equal(isWithinPostingWindow(utcForJakarta(2026, 3, 15, 11, 59), 'Asia/Jakarta', W), false, '差1分钟不该放行');
  assert.equal(isWithinPostingWindow(utcForJakarta(2026, 3, 15, 12, 0), 'Asia/Jakarta', W), true, '整点开始应放行');
  assert.equal(isWithinPostingWindow(utcForJakarta(2026, 3, 15, 18, 0), 'Asia/Jakarta', W), true);
  assert.equal(isWithinPostingWindow(utcForJakarta(2026, 3, 15, 23, 59), 'Asia/Jakarta', W), true, '午夜前1分钟应放行');
  assert.equal(isWithinPostingWindow(utcForJakarta(2026, 3, 16, 0, 0), 'Asia/Jakarta', W), false, '刚过午夜不该放行');
  assert.equal(isWithinPostingWindow(utcForJakarta(2026, 3, 15, 5, 0), 'Asia/Jakarta', W), false, '凌晨不该放行——这正是这个功能要挡住的场景');
});

test('enabled:false 时永远放行，不影响没配这项的老账号', () => {
  const off = { ...W, enabled: false };
  assert.equal(isWithinPostingWindow(utcForJakarta(2026, 3, 15, 5, 0), 'Asia/Jakarta', off), true);
});

test('下一个时段开始时间：时区换算必须来回对得上，不能自己滚飞', () => {
  const fromEarlyMorning = nextPostingWindowStartMs(utcForJakarta(2026, 3, 15, 5, 0), 'Asia/Jakarta', W);
  assert.equal(fromEarlyMorning, utcForJakarta(2026, 3, 15, 12, 0), '凌晨5点应该等到今天中午12点');

  const fromLateNight = nextPostingWindowStartMs(utcForJakarta(2026, 3, 15, 23, 30), 'Asia/Jakarta', W);
  assert.equal(fromLateNight, utcForJakarta(2026, 3, 16, 12, 0), '越过今天窗口后应该给明天中午');
});

test('跨时区一致性：马尼拉 UTC+8', () => {
  function utcForManila(y, mo, d, h, mi = 0) {
    return Date.UTC(y, mo - 1, d, h - 8, mi);
  }
  assert.equal(isWithinPostingWindow(utcForManila(2026, 3, 15, 11, 0), 'Asia/Manila', W), false);
  assert.equal(isWithinPostingWindow(utcForManila(2026, 3, 15, 13, 0), 'Asia/Manila', W), true);
});

test('带夏令时的时区不崩，返回值形状正确', () => {
  const now = Date.now();
  assert.equal(typeof isWithinPostingWindow(now, 'America/New_York', W), 'boolean');
  const next = nextPostingWindowStartMs(now, 'America/New_York', W);
  assert.equal(typeof next, 'number');
  assert.ok(next > now - 24 * 3600 * 1000, '应该返回一个合理的时间点，不是垃圾值');
});
