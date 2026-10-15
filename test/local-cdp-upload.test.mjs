import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, openSync, ftruncateSync, closeSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { cdpConnectOptions } from '../src/orchestrator.js';

test('本机指纹浏览器地址才标记 isLocal，远程地址保持原传输方式', () => {
  assert.deepEqual(cdpConnectOptions('ws://127.0.0.1:52011/devtools/browser/abc'), { isLocal: true });
  assert.deepEqual(cdpConnectOptions('http://127.0.0.1:9222'), { isLocal: true });
  assert.deepEqual(cdpConnectOptions('http://localhost:9222'), { isLocal: true });
  assert.deepEqual(cdpConnectOptions('ws://[::1]:9222/devtools/browser/x'), { isLocal: true });
  assert.deepEqual(cdpConnectOptions('ws://192.168.1.20:9222/devtools/browser/x'), {});
  assert.deepEqual(cdpConnectOptions('not a url'), {});
});

test('通过 CDP 连接本机浏览器：超过50MB的视频也能直接选中，不再报 not co-located', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tkq-cdp-'));
  // 和真实账号文件夹一样带中文。Windows 上必须通过；Linux 需在 UTF-8 locale 下运行。
  mkdirSync(path.join(dir, '2号机印尼5号'));
  const video = path.join(dir, '2号机印尼5号', '1737318339699312031.mp4');
  const fd = openSync(video, 'w');
  ftruncateSync(fd, 60 * 1024 * 1024); // 60MB 稀疏文件，不真正写满磁盘
  closeSync(fd);
  const profile = path.join(dir, 'profile');
  // 与其他测试一致：优先用电脑上已装的 Chrome/Edge，没有才用 Playwright 自带浏览器。
  const executablePath = process.env.CHROMIUM_PATH || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(existsSync);
  const launched = await chromium.launchPersistentContext(profile, {
    ...(executablePath ? { executablePath } : {}),
    args: ['--remote-debugging-port=0'],
  });
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 50 && !existsSync(portFile); i += 1) await new Promise((r) => setTimeout(r, 100));
    const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
    const endpoint = `http://127.0.0.1:${port}`;
    const browser = await chromium.connectOverCDP(endpoint, cdpConnectOptions(endpoint));
    try {
      const page = await browser.contexts()[0].newPage();
      await page.setContent('<input type="file" accept="video/*">');
      await page.locator('input[type=file]').setInputFiles(video, { timeout: 10000 });
      const picked = await page.evaluate(() => {
        const f = document.querySelector('input').files[0];
        return { name: f.name, size: f.size };
      });
      assert.deepEqual(picked, { name: '1737318339699312031.mp4', size: 60 * 1024 * 1024 });
    } finally {
      await browser.close();
    }
  } finally {
    await launched.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
