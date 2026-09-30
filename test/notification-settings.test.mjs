import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import pw from 'playwright-core';

test('notification settings preserve Bark, save PushPlus and report acceptance honestly', async () => {
  // Entirely isolated page/API fixtures: no real config, accounts or notification service.
  const executablePath = process.env.CHROMIUM_PATH || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(existsSync);
  const browser = await pw.chromium.launch(executablePath ? { executablePath } : {});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.addInitScript(() => { window.EventSource = class {}; });
    let settings = {
      minIntervalMs: 3600000, maxIntervalMs: 7200000,
      notifications: { enabled: true, provider: 'bark', bark: { serverUrl: 'https://example.invalid/private-bark' } },
    };
    let rejectTest = false;
    await page.route('**/*', async route => {
      const req = route.request();
      const pathname = new URL(req.url()).pathname;
      let data;
      if (pathname === '/api/settings') {
        if (req.method() === 'PUT') settings = req.postDataJSON();
        data = settings;
      } else if (pathname === '/api/notifications/test') {
        return route.fulfill({ status: rejectTest ? 400 : 200, json: rejectTest ? { error: '需要实名' } : { ok: true, queued: true } });
      } else if (pathname === '/api/status') data = { running: false, accounts: [] };
      else if (['/api/accounts', '/api/joblist', '/api/logs'].includes(pathname)) data = [];
      else if (['/', '/app.js', '/style.css'].includes(pathname)) {
        const name = pathname === '/' ? 'index.html' : pathname.slice(1);
        const file = new URL(`../public/${name}`, import.meta.url);
        return route.fulfill({ contentType: pathname === '/' ? 'text/html' : pathname.endsWith('.js') ? 'text/javascript' : 'text/css', body: existsSync(file) ? readFileSync(file) : '' });
      } else return route.abort();
      return route.fulfill({ json: data });
    });
    const open = async () => {
      await page.goto('http://publisher.test/');
      await page.waitForFunction(() => document.getElementById('s-notify-bark-url').value.includes('private-bark'));
      await page.locator('#settings-details > summary').click();
    };
    await open();
    assert.equal(await page.locator('#s-notify-provider').inputValue(), 'bark');
    await page.locator('#s-notify-provider').selectOption('pushplus');
    assert.equal(await page.locator('[data-provider="pushplus"]').isVisible(), true);
    assert.equal(await page.locator('[data-provider="bark"]').isVisible(), false);
    await page.locator('#s-notify-pushplus-token').fill(' test-token ');
    const saved = page.waitForEvent('dialog');
    await page.locator('#settings-form').evaluate(form => form.requestSubmit());
    const savedDialog = await saved;
    assert.equal(savedDialog.message(), '已保存');
    await savedDialog.accept();
    assert.equal(settings.notifications.provider, 'pushplus');
    assert.equal(settings.notifications.pushplus.token, 'test-token');
    assert.equal(settings.notifications.bark.serverUrl, 'https://example.invalid/private-bark');
    await open();
    assert.equal(await page.locator('#s-notify-provider').inputValue(), 'pushplus');
    assert.equal(await page.locator('#s-notify-pushplus-token').inputValue(), 'test-token');
    for (const rejected of [false, true]) {
      rejectTest = rejected;
      const dialogPromise = page.waitForEvent('dialog');
      await page.locator('#btn-test-notify').click();
      const dialog = await dialogPromise;
      assert.match(dialog.message(), rejected ? /发送失败.*需要实名/ : /受理不代表送达/);
      await dialog.accept();
      await page.waitForFunction(() => !document.getElementById('btn-test-notify').disabled);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
