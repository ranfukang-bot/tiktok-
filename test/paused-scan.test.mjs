import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(import.meta.dirname, '..');

test('已暂停或在退避中的账号：文件夹不存在也不扫描、不报错、不改暂停原因', async () => {
  const root = mkdtempSync(path.join(repo, '.scheduler-test-'));
  try {
    cpSync(path.join(repo, 'src'), path.join(root, 'src'), { recursive: true });
    mkdirSync(path.join(root, 'config'));
    writeFileSync(path.join(root, 'config', 'settings.json'), JSON.stringify({ minIntervalMs: 1, maxIntervalMs: 2 }));
    writeFileSync(path.join(root, 'config', 'accounts.json'), '[]');
    const load = (f) => import(pathToFileURL(path.join(root, 'src', f)));
    const { tickAll } = await load('orchestrator.js');
    const { getState, setState } = await load('stateStore.js');
    const { subscribe } = await load('logBus.js');
    const missing = path.join(root, '不存在的文件夹');
    const paused = { name: '手动暂停夹具', browser: 'bitbrowser', browserId: 'x', videoFolder: missing };
    const backoff = { name: '退避夹具', browser: 'bitbrowser', browserId: 'x', videoFolder: missing };
    const p = getState(paused.name); p.paused = true; p.pauseReason = '用户手动暂停'; p.pauseCode = 'user'; setState(paused.name, p);
    const b = getState(backoff.name); b.retryAt = Date.now() + 600000; b.consecutiveFailures = 1; setState(backoff.name, b);
    const errors = [];
    const off = subscribe((e) => { if (e.level !== 'info') errors.push(`${e.account}: ${e.message}`); });
    const settings = { minIntervalMs: 1, maxIntervalMs: 2, videoExtensions: ['.mp4'], notifications: { enabled: false } };
    for (let i = 0; i < 3; i += 1) await tickAll(settings, [paused, backoff]);
    off();
    assert.deepEqual(errors, [], '暂停/退避中的账号不能每圈报错');
    assert.equal(getState(paused.name).pauseReason, '用户手动暂停');
    assert.equal(getState(paused.name).pauseCode, 'user');
    assert.equal(getState(backoff.name).consecutiveFailures, 1, '退避等待期间不能累计失败次数');
    assert.equal(getState(backoff.name).paused, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
