// 真实网页、CSS 和 JS；所有请求均在独立浏览器中拦截，不访问网络或用户数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

test('版本相同时隐藏更新提示，有新提交才显示，重新检查相同版本后再次隐藏', async t => {
  const executablePath = process.env.CHROMIUM_PATH || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(existsSync);
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  t.after(() => browser.close());
  const page = await browser.newPage();
  const current = { sha: '107bc1c6d692d7bb8a3ed839c7229eac6628d687', date: '2026-11-04T09:41:08Z' };
  const next = { sha: 'b'.repeat(40), date: '2026-11-06T00:00:00Z' };
  let info = { current, latest: current, updateAvailable: false };
  const unexpected = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://console.test') {
      unexpected.push(url.origin);
      return route.abort();
    }
    const pathname = url.pathname;
    if (['/', '/app.js', '/style.css'].includes(pathname)) {
      const file = pathname === '/' ? 'index.html' : pathname.slice(1);
      return route.fulfill({
        body: readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'),
        contentType: file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'text/css',
      });
    }
    if (pathname === '/api/logs/stream') return route.fulfill({ body: '', contentType: 'text/event-stream' });
    const values = {
      '/api/version': info,
      '/api/settings': JSON.parse(readFileSync(new URL('../config/settings.example.json', import.meta.url), 'utf8')),
      '/api/accounts': [], '/api/joblist': [], '/api/logs': [],
      '/api/status': { running: false, accounts: [] },
    };
    return route.fulfill({ json: values[pathname] || {} });
  });
  await page.goto('http://console.test/');
  await page.waitForFunction(() => document.getElementById('current-version').textContent.includes('107bc1c'));
  const notice = page.locator('#update-notice');
  assert.match(await page.locator('#current-version').innerText(), /107bc1c.*2026-11-04/);
  assert.equal(await notice.isVisible(), false, '相同提交不应显示“有新版本”');

  info = { current, latest: next, updateAvailable: true };
  await page.evaluate(() => refreshVersion());
  assert.equal(await notice.isVisible(), true);
  assert.equal(await notice.innerText(), '有新版本：关掉控制台，重新双击 start.bat 即可更新');

  info = { current: next, latest: next, updateAvailable: false };
  await page.evaluate(() => refreshVersion());
  assert.equal(await notice.isVisible(), false);
  assert.match(await page.locator('#current-version').innerText(), /bbbbbbb.*2026-11-06/);
  assert.deepEqual(unexpected, []);
});
