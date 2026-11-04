import test from 'node:test';
import assert from 'node:assert/strict';
import { latestVersion, createVersionMonitor, CHECK_INTERVAL_MS, COMMIT_URL } from '../src/updateInfo.js';

const current = { sha: 'a'.repeat(40), date: '2026-10-01T00:00:00Z' };
const latest = { sha: 'b'.repeat(40), date: '2026-11-04T00:00:00Z' };

test('GitHub 请求使用公开 commits/main API，无 token，校验提交和日期', async () => {
  const result = await latestVersion({ request: async (url, options) => {
    assert.equal(url, COMMIT_URL);
    assert.equal(options.headers.Authorization, undefined);
    return { ok: true, json: async () => ({ sha: latest.sha, commit: { committer: { date: latest.date } } }) };
  } });
  assert.deepEqual(result, latest);
  await assert.rejects(latestVersion({ request: async () => ({ ok: true, json: async () => ({ sha: 'bad' }) }) }), /版本信息不完整/);
  await assert.rejects(latestVersion({ request: async () => ({ ok: false, status: 403 }) }), /403/);
});

test('版本监控每小时只检查并缓存结果，运行版本固定，离线保留更新提示', async () => {
  let tick, count = 0, offline = false, cancelled = false;
  const monitor = createVersionMonitor({
    getLocal: async () => current,
    getLatest: async () => { count++; if (offline) throw new Error('offline'); return count === 1 ? current : latest; },
    schedule: (fn, ms) => { tick = fn; assert.equal(ms, CHECK_INTERVAL_MS); return 123; },
    cancel: timer => { assert.equal(timer, 123); cancelled = true; },
  });
  await monitor.start();
  await monitor.check();
  assert.equal(count, 1);
  assert.equal(monitor.snapshot().updateAvailable, false);
  await tick();
  assert.equal(count, 2);
  assert.equal(monitor.snapshot().updateAvailable, true);
  assert.deepEqual(monitor.snapshot().current, current);
  offline = true;
  await tick();
  assert.equal(monitor.snapshot().updateAvailable, true);
  monitor.stop();
  assert.equal(cancelled, true);
});
