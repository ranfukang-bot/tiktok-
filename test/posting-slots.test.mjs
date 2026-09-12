// 固定发布时间节点的测试。
//
// 这块必须用真实时刻算，不能只测"函数返回了个对象"：上一次做发布时段的时候，
// 时区换算写错了一个符号，中午12点被算成早上5点，只有拿真数字跑才看得出来。
//
// 重点覆盖用户真正关心的那几条：
//   1. 到点才发，不到点不发
//   2. 每个节点当天只能用一次
//   3. 【错过不补发】——视频做晚了，错过的节点就没了，绝不在晚上连发
//   4. 同一个账号同一天算出来的目标时刻必须稳定（不稳定就永远到不了点）
//   5. 不同账号错开，同一部手机上的号不会一起发
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSlots, slotTargetsForDay, parseHm, formatHm } from '../src/dailyQuota.js';
import { resolvePostingPlan, DEFAULT_POSTING_SLOTS } from '../src/config.js';

const TZ = 'Asia/Jakarta'; // UTC+7，无夏令时
const DAY = '2026-09-12';
const SLOTS = DEFAULT_POSTING_SLOTS;

// 把"雅加达当地几点几分"写成UTC毫秒，测试里当作"现在"
function local(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return Date.UTC(2026, 8, 12, h - 7, m, 0);
}

const base = { timezone: TZ, dayKey: DAY, slots: SLOTS, accountName: '印尼1号' };

test('时间换算：节点区间落在当地正确的钟点上', () => {
  const targets = slotTargetsForDay({ ...base });
  const evening = targets.find((t) => t.key === '19:30');
  assert.equal(evening.startMs, local('19:30'));
  assert.equal(evening.endMs, local('20:30'));
  // 目标时刻必须落在区间之内
  assert.ok(evening.targetMs >= evening.startMs && evening.targetMs < evening.endMs);
});

test('同一账号同一天算出来的目标时刻是稳定的', () => {
  // 每轮tick都重算一次。如果这里用了 Math.random，目标时刻会一直往后漂，
  // 永远也等不到"到点了"。
  const a = slotTargetsForDay({ ...base }).map((t) => t.targetMs);
  const b = slotTargetsForDay({ ...base }).map((t) => t.targetMs);
  assert.deepEqual(a, b);
});

test('不同账号的目标时刻错开，同一部手机上的号不会一起发', () => {
  const a = slotTargetsForDay({ ...base, accountName: '印尼1号' }).map((t) => t.targetText);
  const b = slotTargetsForDay({ ...base, accountName: '印尼2号' }).map((t) => t.targetText);
  assert.notDeepEqual(a, b);
});

test('不到点不发，到点才发', () => {
  const targets = slotTargetsForDay({ ...base });
  const noon = targets.find((t) => t.key === '11:30');
  const before = evaluateSlots({ ...base, nowMs: noon.targetMs - 60000 });
  assert.equal(before.due, null);
  assert.equal(before.nextAt, noon.targetMs, '界面上要能显示还要等多久');

  const after = evaluateSlots({ ...base, nowMs: noon.targetMs + 1000 });
  assert.equal(after.due?.key, '11:30');
});

test('凌晨、早上都不发（这正是做这个功能的起因）', () => {
  for (const t of ['00:05', '03:00', '08:00', '10:00']) {
    assert.equal(evaluateSlots({ ...base, nowMs: local(t) }).due, null, `${t} 不该发`);
  }
});

test('一个节点当天只能用一次', () => {
  const targets = slotTargetsForDay({ ...base });
  const noon = targets.find((t) => t.key === '11:30');
  const now = noon.targetMs + 60000;
  assert.equal(evaluateSlots({ ...base, nowMs: now }).due?.key, '11:30');
  // 用过之后，即使还在这个区间里，也不会再发第二条
  assert.equal(evaluateSlots({ ...base, nowMs: now, usedKeys: ['11:30'] }).due, null);
});

test('错过的节点不补发：下午5点半才做出视频，当天只发晚上那两条', () => {
  // 这是用户问的那个场景。11:30 和 16:30 两个节点已经过去了，
  // 绝不能把它们攒到晚上一起发出来。
  const used = [];
  const published = [];
  // 从 17:30 开始，每 5 分钟看一次，一直看到第二天凌晨
  for (let t = local('17:30'); t < local('23:59'); t += 5 * 60000) {
    const r = evaluateSlots({
      ...base, nowMs: t, usedKeys: used, minGapMs: 90 * 60000,
      lastPublishAt: published.length ? published[published.length - 1] : null,
    });
    if (r.due) { used.push(r.due.key); published.push(t); }
  }
  assert.deepEqual(used, ['19:30', '21:30'], '只用晚上这两个节点，不补 11:30 和 16:30');
  assert.equal(published.length, 2);
  // 两条之间实打实隔开了
  assert.ok(published[1] - published[0] >= 90 * 60000, '两条之间至少隔了90分钟');
});

test('一整天从头跑：四条正好落在四个节点里，且互相不挤', () => {
  const used = [];
  const published = [];
  for (let t = local('00:00'); t < local('23:59'); t += 5 * 60000) {
    const r = evaluateSlots({
      ...base, nowMs: t, usedKeys: used, minGapMs: 90 * 60000,
      lastPublishAt: published.length ? published[published.length - 1] : null,
    });
    if (r.due) { used.push(r.due.key); published.push(t); }
  }
  assert.deepEqual(used, ['11:30', '16:30', '19:30', '21:30']);
  for (let i = 1; i < published.length; i += 1) {
    assert.ok(published[i] - published[i - 1] >= 90 * 60000,
      `第${i}条和第${i + 1}条之间只隔了 ${(published[i] - published[i - 1]) / 60000} 分钟`);
  }
});

test('最少间隔会顶掉挨太近的节点，但不会把它顺延到别的时段', () => {
  const slots = [{ start: '19:00', end: '19:30' }, { start: '19:40', end: '20:10' }];
  const tight = { timezone: TZ, dayKey: DAY, slots, accountName: 'x' };
  // 抖动是随账号名算出来的，不能假设它落在哪：直接拿算出来的目标时刻做基准
  const [slotA, slotB] = slotTargetsForDay({ ...tight });
  const publishedAt = slotA.targetMs;
  assert.equal(evaluateSlots({ ...tight, nowMs: publishedAt }).due?.key, '19:00');
  // 刚发完就到第二个节点：被90分钟的最少间隔挡住，而且这个节点很快就结束，
  // 于是干脆放弃——不会顺延到晚上别的时间偷偷发出来
  const later = evaluateSlots({
    ...tight, nowMs: Math.max(slotB.targetMs, publishedAt + 60000), usedKeys: ['19:00'],
    minGapMs: 90 * 60000, lastPublishAt: publishedAt,
  });
  assert.equal(later.due, null);
  assert.equal(later.blockedByGap, true);
  const muchLater = evaluateSlots({
    ...tight, nowMs: local('22:00'), usedKeys: ['19:00'],
    minGapMs: 90 * 60000, lastPublishAt: local('19:29'),
  });
  assert.equal(muchLater.due, null, '过了节点窗口就是过了，不会挪到别的时间发');
});

test('今天发完了，nextAt 指向明天的第一个节点', () => {
  const r = evaluateSlots({ ...base, nowMs: local('23:00'), usedKeys: SLOTS.map((s) => s.start) });
  assert.equal(r.due, null);
  assert.equal(r.remainingSlots, 0);
  assert.ok(r.nextAt > local('23:00'));
  // 明天中午那个节点：距离现在 12-14 小时
  const hours = (r.nextAt - local('23:00')) / 3600000;
  assert.ok(hours > 11 && hours < 15, `应该是明天中午，实际差 ${hours.toFixed(1)} 小时`);
});

test('时区跟着账号走：同样的节点，菲律宾(UTC+8)比印尼(UTC+7)早一小时到点', () => {
  const jkt = slotTargetsForDay({ ...base, timezone: 'Asia/Jakarta' }).find((t) => t.key === '19:30');
  const mnl = slotTargetsForDay({ ...base, timezone: 'Asia/Manila' }).find((t) => t.key === '19:30');
  assert.equal(jkt.startMs - mnl.startMs, 3600000);
});

test('配置解析：老配置默认就是节点模式，配错了明确报错不静默放行', () => {
  assert.equal(resolvePostingPlan({}).mode, 'slots', '没配过 postingSlots 的老配置走节点模式');
  assert.equal(resolvePostingPlan({}).slots.length, 4);
  assert.equal(resolvePostingPlan({ postingSlots: { enabled: false } }).mode, 'window');
  assert.throws(() => resolvePostingPlan({ postingSlots: { slots: [{ start: '9点半', end: '10:30' }] } }), /格式不对/);
  assert.throws(() => resolvePostingPlan({ postingSlots: { slots: [{ start: '20:00', end: '19:00' }] } }), /结束时间/);
  assert.throws(() => resolvePostingPlan({
    postingSlots: { slots: [{ start: '19:00', end: '19:30' }, { start: '19:00', end: '20:00' }] },
  }), /两个发布时间节点/);
  // 自定义节点要按开始时间排好序，不能依赖用户填的顺序
  const custom = resolvePostingPlan({ postingSlots: { slots: [{ start: '21:00', end: '22:00' }, { start: '12:00', end: '13:00' }] } });
  assert.deepEqual(custom.slots.map((s) => s.start), ['12:00', '21:00']);
});

test('时分解析的边界', () => {
  assert.equal(parseHm('00:00'), 0);
  assert.equal(parseHm('23:59'), 1439);
  assert.equal(parseHm('9:05'), 545);
  assert.equal(parseHm('24:00'), null);
  assert.equal(parseHm('12:60'), null);
  assert.equal(parseHm(''), null);
  assert.equal(formatHm(545), '09:05');
});

test('不卡整点和半点（那是各种定时脚本扎堆释放的时间）', () => {
  // 抖动是均匀的，总会有落在 :00 / :30 上的时候，要能挪开。
  // 扫一大批账号名，只要出现一次整点就算没做到。
  const hits = [];
  for (let i = 0; i < 300; i += 1) {
    for (const t of slotTargetsForDay({ ...base, accountName: `号${i}` })) {
      const minute = Number(t.targetText.split(':')[1]);
      if (minute === 0 || minute === 30) hits.push(`号${i} ${t.targetText}`);
      // 挪完也不能挪出区间
      assert.ok(t.targetMs >= t.startMs && t.targetMs < t.endMs, `${t.targetText} 跑到 ${t.start}-${t.end} 外面了`);
    }
  }
  assert.deepEqual(hits, []);
});

test('区间太窄挪不动时，宁可卡整点也不能跑出区间', () => {
  const slots = [{ start: '20:00', end: '20:01' }];
  for (const t of slotTargetsForDay({ ...base, slots })) {
    assert.ok(t.targetMs >= t.startMs && t.targetMs < t.endMs);
  }
});
