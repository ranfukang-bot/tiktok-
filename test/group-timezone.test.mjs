import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { resolveTimezone, resolveTimezoneSource, isValidTimezone } from '../src/config.js';
import { currentDayKey, slotTargetsForDay } from '../src/dailyQuota.js';

const repo = path.resolve(import.meta.dirname, '..');
const mexico = 'America/Mexico_City';
const jakarta = 'Asia/Jakarta';
const manila = 'Asia/Manila';
const now = Date.parse('2026-10-19T18:00:00Z');
const groupName = '墨西哥 / 1号机';
const settings = { timezone: manila, phoneGroupTimezones: { [groupName]: mexico, '印尼1号机': jakarta } };

for (const [label, config, account, timezone, source] of [
  ['账号字段优先于分组和全局', settings, { phoneGroup: groupName, timezone: 'Asia/Tokyo' }, 'Asia/Tokyo', 'account'],
  ['分组优先于全局', settings, { phoneGroup: groupName }, mexico, 'group'],
  ['分组名前后空格不影响匹配', settings, { phoneGroup: `  ${groupName}  ` }, mexico, 'group'],
  ['无分组设置沿用全局', settings, { phoneGroup: '新手机' }, manila, 'global'],
  ['没有全局设置使用默认', {}, {}, jakarta, 'global'],
  ['空账号和分组时区继续向下取值', { ...settings, phoneGroupTimezones: { [groupName]: '' } }, { phoneGroup: groupName, timezone: '' }, manila, 'global'],
]) {
  test(`时区与来源优先级：${label}`, () => {
    assert.equal(resolveTimezone(config, account), timezone);
    assert.equal(resolveTimezoneSource(config, account), source);
  });
}

test('空分组名不查分组表；原型属性不能被当成分组设置', () => {
  const config = { ...settings, phoneGroupTimezones: { '': mexico, '   ': mexico } };
  for (const phoneGroup of ['', '   ', undefined, null, 'constructor', '__proto__']) {
    assert.equal(resolveTimezone(config, { phoneGroup }), manila);
    assert.equal(resolveTimezoneSource(config, { phoneGroup }), 'global');
  }
  assert.equal(resolveTimezone({ phoneGroupTimezones: { '': mexico } }, { phoneGroup: '  ' }), jakarta);
  assert.equal(resolveTimezoneSource({ phoneGroupTimezones: { '': mexico } }, { phoneGroup: '  ' }), 'global');
});

test('isValidTimezone 使用 Intl 校验有效、别名和无效时区', () => {
  for (const tz of [mexico, jakarta, manila, 'UTC', 'Asia/Ho_Chi_Minh']) assert.equal(isValidTimezone(tz), true, tz);
  for (const tz of ['Not/A_Timezone', '', '   ', null, undefined, 123]) assert.equal(isValidTimezone(tz), false, String(tz));
});

test('同一时刻墨西哥是19日、印尼是20日，同名节点落在各自当地19:30至20:30', () => {
  const targets = [groupName, '印尼1号机'].map(phoneGroup => {
    const account = { name: phoneGroup, phoneGroup };
    const timezone = resolveTimezone(settings, account);
    const dayKey = currentDayKey(timezone, now);
    assert.equal(dayKey, phoneGroup === groupName ? '2026-10-19' : '2026-10-20');
    const [slot] = slotTargetsForDay({ dayKey, timezone, accountName: account.name, slots: [{ start: '19:30', end: '20:30' }] });
    assert.ok(slot.targetMs >= slot.startMs && slot.targetMs < slot.endMs);
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    assert.equal(clock.format(slot.startMs), '19:30');
    assert.equal(clock.format(slot.endMs), '20:30');
    assert.ok(clock.format(slot.targetMs) >= '19:30' && clock.format(slot.targetMs) < '20:30');
    assert.equal(currentDayKey(timezone, slot.targetMs), dayKey);
    return slot;
  });
  assert.equal(targets[0].startMs, Date.parse('2026-10-20T01:30:00Z'));
  assert.equal(targets[1].startMs, Date.parse('2026-10-20T12:30:00Z'));
  assert.notEqual(targets[0].targetMs, targets[1].targetMs);
});

// 复用仓库依赖，但隔离源码、配置、状态和自动打开浏览器的动作。
async function serverFixture(t, initial = {}) {
  const root = mkdtempSync(path.join(repo, '.scheduler-test-'));
  cpSync(path.join(repo, 'src'), path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'config'));
  const settingsPath = path.join(root, 'config/settings.json');
  writeFileSync(settingsPath, JSON.stringify({ minIntervalMs: 1, maxIntervalMs: 2, ...initial }));
  writeFileSync(path.join(root, 'config/accounts.json'), '[]');
  const serverPath = path.join(root, 'src/server.js');
  writeFileSync(serverPath, readFileSync(serverPath, 'utf8').replace("import open from 'open';", 'const open = async () => {};'));
  const load = file => import(pathToFileURL(path.join(root, 'src', file)));
  let server;
  t.after(async () => {
    if (server) {
      (await load('controller.js')).stop();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    if (path.dirname(root) === repo && path.basename(root).startsWith('.scheduler-test-')) rmSync(root, { recursive: true, force: true });
  });
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const previous = process.env.PORT;
  process.env.PORT = String(port);
  try {
    ({ server } = await load('server.js'));
    if (!server.listening) await once(server, 'listening');
  } finally {
    if (previous === undefined) delete process.env.PORT;
    else process.env.PORT = previous;
  }
  return {
    load, settingsPath,
    read: () => JSON.parse(readFileSync(settingsPath, 'utf8')),
    put: (url, body) => fetch(`http://127.0.0.1:${port}${url}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
    status: async () => (await fetch(`http://127.0.0.1:${port}/api/status`)).json(),
  };
}

const groupUrl = name => `/api/phone-groups/${encodeURIComponent(name)}/timezone`;

test('分组接口：无效时区、空分组和未分组返回400，文件逐字保持不变', async t => {
  const f = await serverFixture(t, settings);
  const before = readFileSync(f.settingsPath, 'utf8');
  for (const [name, body] of [
    [groupName, { timezone: 'Not/A_Timezone' }], [groupName, { timezone: '   ' }],
    [groupName, {}], [groupName, { timezone: null }], [groupName, { timezone: 123 }],
    ['   ', { timezone: jakarta }], [' 未分组 ', { timezone: jakarta }], ['未分组', { timezone: '' }],
  ]) {
    const res = await f.put(groupUrl(name), body);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /时区|分组/);
    assert.equal(readFileSync(f.settingsPath, 'utf8'), before);
  }
});

test('分组接口：有效时区按trim后的名称写入，保留磁盘最新的其它字段和分组', async t => {
  const f = await serverFixture(t, settings);
  const latest = { ...f.read(), custom: { keep: true }, concurrency: 7,
    phoneGroupTimezones: { ...settings.phoneGroupTimezones, '菲律宾手机': manila } };
  writeFileSync(f.settingsPath, JSON.stringify(latest));
  const res = await f.put(groupUrl(`  ${groupName}  `), { timezone: jakarta });
  assert.equal(res.status, 200);
  const expected = { ...latest.phoneGroupTimezones, [groupName]: jakarta };
  assert.deepEqual(await res.json(), { ok: true, phoneGroupTimezones: expected });
  assert.deepEqual(f.read(), { ...latest, phoneGroupTimezones: expected });
});

test('分组接口：空字符串只删除该分组，账号立即回到全局时区', async t => {
  const f = await serverFixture(t, settings);
  (await f.load('config.js')).saveAccounts([{ name: '墨西哥账号', phoneGroup: groupName }]);
  assert.equal((await f.status()).accounts[0].timezone, mexico);
  const res = await f.put(groupUrl(groupName), { timezone: '' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, phoneGroupTimezones: { '印尼1号机': jakarta } });
  assert.deepEqual(f.read().phoneGroupTimezones, { '印尼1号机': jakarta });
  const account = (await f.status()).accounts[0];
  assert.equal(account.timezone, manila);
  assert.equal(account.timezoneSource, 'global');
});

test('全局设置接口：遗漏或携带旧分组时区都保留磁盘最新值，不能注入分组配置', async t => {
  const f = await serverFixture(t);
  const stale = { ...f.read(), phoneGroupTimezones: { [groupName]: jakarta } };
  // 磁盘原本没有分组表时，全局接口也不能创建它。
  assert.equal((await f.put('/api/settings', stale)).status, 200);
  assert.equal(Object.hasOwn(f.read(), 'phoneGroupTimezones'), false);
  assert.equal((await f.put(groupUrl(groupName), { timezone: mexico })).status, 200);
  assert.equal((await f.put(groupUrl('印尼1号机'), { timezone: jakarta })).status, 200);
  const expected = { [groupName]: mexico, '印尼1号机': jakarta };
  for (const body of [{ minIntervalMs: 3, maxIntervalMs: 4 }, { ...stale, timezone: 'Asia/Tokyo' }]) {
    assert.equal((await f.put('/api/settings', body)).status, 200);
    assert.deepEqual(f.read().phoneGroupTimezones, expected);
    assert.equal(f.read().minIntervalMs, body.minIntervalMs);
  }
});

test('状态接口：各账号返回实际时区和来源，今日额度、节点和产品计数按分组跨日', async t => {
  const f = await serverFixture(t, settings);
  const accounts = [
    { name: '墨西哥账号', phoneGroup: ` ${groupName} ` },
    { name: '印尼账号', phoneGroup: '印尼1号机' },
    { name: '单独设置', phoneGroup: groupName, timezone: manila },
    { name: '未分组账号' },
  ];
  (await f.load('config.js')).saveAccounts(accounts);
  const { getState, setState } = await f.load('stateStore.js');
  for (const account of accounts) setState(account.name, {
    ...getState(account.name), items: [{ productId: '100' }], doneIndex: -1,
    publishDayKey: '2026-10-19', publishedToday: 2, publishedProductIdsToday: ['100'],
    missedSlotsDayKey: '2026-10-19', missedSlotsToday: ['11:30'], slotsUsedToday: ['11:30'],
  });
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const status = await f.status();
    assert.equal(status.settingsError, null);
    assert.deepEqual(status.accounts.map(a => [a.timezone, a.timezoneSource]), [
      [mexico, 'group'], [jakarta, 'group'], [manila, 'account'], [manila, 'global'],
    ]);
    assert.deepEqual(status.accounts.map(a => a.publishedToday), [2, 0, 0, 0]);
    assert.deepEqual(status.accounts.map(a => a.missedSlotsToday), [1, 0, 0, 0]);
    assert.deepEqual(status.accounts.map(a => a.slotsUsedToday), [1, 0, 0, 0]);
    assert.deepEqual(status.accounts.map(a => a.productLimitReached), [true, false, false, false]);
    assert.equal((await f.put(groupUrl(groupName), { timezone: manila })).status, 200);
    const updated = (await f.status()).accounts[0];
    assert.equal(updated.timezone, manila);
    assert.equal(updated.publishedToday, 0);
  } finally {
    Date.now = originalNow;
  }
});

let browser;
after(async () => { await browser?.close(); });

// 使用真实控制台JS和独立匿名浏览器；全部API在页面内模拟，不读取或写入用户数据。
async function consoleFixture(t) {
  if (!browser) {
    const executablePath = process.env.CHROMIUM_PATH || [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ].find(existsSync);
    browser = await chromium.launch(executablePath ? { executablePath } : {});
  }
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(instant => {
    window.fixtureNow = instant;
    Date.now = () => window.fixtureNow;
    // 每项测试主动刷新状态，避免后台轮询影响正在验证的交互。
    window.setInterval = () => 0;
  }, now);
  let config = { ...JSON.parse(readFileSync(path.join(repo, 'config/settings.example.json'), 'utf8')),
    ...settings, phoneGroupTimezones: { ...settings.phoneGroupTimezones, '别名机': 'Asia/Ho_Chi_Minh' } };
  const accounts = [
    { name: '墨西哥账号', phoneGroup: `  ${groupName}  ` },
    { name: '账号单独设置', phoneGroup: groupName, timezone: manila },
    { name: '印尼账号', phoneGroup: '印尼1号机' },
    { name: '全局账号', phoneGroup: '' },
    { name: '别名账号', phoneGroup: '别名机' },
  ].map(account => ({ browser: 'bitbrowser', videoFolder: 'C:/fixture', ...account }));
  const calls = [];
  let failSave = false;
  await page.route('http://group-timezone.test/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (['/', '/app.js', '/style.css'].includes(pathname)) {
      const file = pathname === '/' ? 'index.html' : pathname.slice(1);
      return route.fulfill({ body: readFileSync(path.join(repo, 'public', file), 'utf8'),
        contentType: pathname === '/' ? 'text/html' : pathname.endsWith('.js') ? 'text/javascript' : 'text/css' });
    }
    if (pathname === '/api/logs/stream') return route.fulfill({ body: '', contentType: 'text/event-stream' });
    let value = [];
    if (pathname === '/api/settings') value = config;
    if (pathname === '/api/accounts') value = accounts;
    if (pathname === '/api/status') value = { running: false, accounts: accounts.map(account => ({
      name: account.name, timezone: resolveTimezone(config, account), timezoneSource: resolveTimezoneSource(config, account),
      total: 0, doneIndex: -1, remaining: 0,
    })) };
    if (pathname.startsWith('/api/phone-groups/')) {
      const body = request.postDataJSON();
      calls.push({ pathname, name: decodeURIComponent(pathname.slice('/api/phone-groups/'.length, -'/timezone'.length)), method: request.method(), body });
      if (failSave) return route.fulfill({ status: 400, json: { error: '模拟时区保存失败' } });
      const name = calls.at(-1).name;
      const timezones = { ...config.phoneGroupTimezones };
      if (body.timezone === '') delete timezones[name];
      else timezones[name] = body.timezone;
      config = { ...config, phoneGroupTimezones: timezones };
      value = { ok: true, phoneGroupTimezones: timezones };
    }
    return route.fulfill({ json: value });
  });
  await page.goto('http://group-timezone.test/');
  await page.waitForFunction(() => document.querySelectorAll('.account-card').length === 5);
  const group = page.locator('.phone-group').filter({ has: page.getByText(groupName, { exact: true }) });
  return { page, group, calls, errors, failSave: () => { failSave = true; } };
}

test('真实控制台JS：分组标题有共享时区选项和当地时间，未分组只显示全局时间', async t => {
  const { page, group, errors } = await consoleFixture(t);
  const select = group.locator('summary select');
  assert.equal(await select.inputValue(), mexico);
  assert.equal(await select.locator('option').first().textContent(), `沿用全局（${manila}）`);
  const options = await select.locator('option').evaluateAll(els => els.slice(1).map(el => [el.value, el.textContent]));
  assert.deepEqual(options, await page.locator('#s-timezone option').evaluateAll(els => els.map(el => [el.value, el.textContent])));
  assert.match(await group.locator('.group-local-time').innerText(), /^当地 12:00$/);
  const ungrouped = page.locator('.phone-group').filter({ has: page.getByText('未分组', { exact: true }) });
  assert.equal(await ungrouped.locator('select').count(), 0);
  assert.equal(await ungrouped.locator('.group-local-time').innerText(), `沿用全局 ${manila} · 当地 02:00`);
  assert.equal(await page.getByLabel('别名机的时区').inputValue(), 'Asia/Ho_Chi_Minh');
  assert.deepEqual(errors, []);
});

test('真实控制台JS：改选立即调用编码后的分组接口并刷新状态，空选项恢复全局', async t => {
  const { page, group, calls } = await consoleFixture(t);
  await group.locator('select').selectOption(jakarta);
  await page.waitForFunction(name => currentSettings.phoneGroupTimezones[name] === 'Asia/Jakarta' &&
    statusData.accounts.find(a => a.name === '墨西哥账号').timezone === 'Asia/Jakarta', groupName);
  assert.deepEqual(calls[0], { pathname: groupUrl(groupName), name: groupName, method: 'PUT', body: { timezone: jakarta } });
  assert.equal(await group.locator('select').inputValue(), jakarta);
  assert.equal(await group.locator('.group-local-time').innerText(), '当地 01:00');
  await group.locator('select').selectOption('');
  await page.waitForFunction(name => !Object.hasOwn(currentSettings.phoneGroupTimezones, name) &&
    statusData.accounts.find(a => a.name === '墨西哥账号').timezone === 'Asia/Manila', groupName);
  assert.deepEqual(calls[1].body, { timezone: '' });
  assert.equal(await group.locator('select').inputValue(), '');
  assert.equal(await group.locator('.group-local-time').innerText(), '当地 02:00');
});

test('真实控制台JS：点击和键盘操作下拉框不会切换分组折叠状态或冒泡到summary', async t => {
  const { page, group } = await consoleFixture(t);
  const select = group.locator('select');
  await group.locator('summary').evaluate(summary => {
    window.summaryEvents = [];
    for (const event of ['click', 'pointerdown', 'keydown', 'change']) summary.addEventListener(event, e => window.summaryEvents.push(e.type));
  });
  await select.click();
  await select.press('Escape');
  await select.press('Space');
  await select.press('Escape');
  await select.selectOption(jakarta);
  await page.waitForFunction(name => currentSettings.phoneGroupTimezones[name] === 'Asia/Jakarta', groupName);
  assert.equal(await group.evaluate(el => el.open), true);
  assert.deepEqual(await page.evaluate(() => window.summaryEvents), []);
  await group.locator('summary > span').click();
  assert.equal(await group.evaluate(el => el.open), false, '分组标题本身仍能正常折叠');
});

test('真实控制台JS：保存失败显示现有错误提示并恢复原值，状态刷新也不丢原设置', async t => {
  const { page, group, failSave } = await consoleFixture(t);
  failSave();
  await group.locator('select').selectOption(jakarta);
  await page.waitForFunction(() => document.querySelector('#global-error').textContent.includes('模拟时区保存失败'));
  assert.equal(await group.locator('select').inputValue(), mexico);
  assert.equal(await group.locator('select').isDisabled(), false);
  assert.equal(await page.evaluate(name => currentSettings.phoneGroupTimezones[name], groupName), mexico);
  await page.evaluate(() => refreshStatus());
  assert.equal(await group.locator('select').inputValue(), mexico);
});

test('真实控制台JS：每张账号卡片显示实际时区和当地时间，账号覆盖有说明，刷新会更新时间', async t => {
  const { page, group, errors } = await consoleFixture(t);
  const badge = name => page.locator('.account-card').filter({ has: page.getByText(name, { exact: true }) }).locator('.account-timezone');
  assert.equal(await badge('墨西哥账号').innerText(), '墨西哥（墨西哥城） 12:00');
  assert.equal(await badge('印尼账号').innerText(), '印尼西部 WIB（雅加达） 01:00');
  assert.equal(await badge('账号单独设置').innerText(), '菲律宾（马尼拉） 02:00 · 账号单独设置');
  assert.equal(await badge('别名账号').innerText(), 'Asia/Ho_Chi_Minh 01:00');
  await page.evaluate(() => { window.fixtureNow += 3600000; });
  await page.evaluate(() => refreshStatus());
  assert.equal(await badge('墨西哥账号').innerText(), '墨西哥（墨西哥城） 13:00');
  assert.equal(await group.locator('.group-local-time').innerText(), '当地 13:00');
  assert.deepEqual(errors, []);
});

test('真实控制台JS：下拉框正在操作时，3秒一次的状态刷新不能重建它（否则正在选的下拉框会被关掉）', async t => {
  const { page, group, errors } = await consoleFixture(t);
  const select = group.locator('select');
  await select.focus();
  await select.evaluate(el => { el.dataset.marker = 'kept'; });
  await page.evaluate(() => { window.fixtureNow += 60000; });
  await page.evaluate(() => refreshStatus());
  assert.equal(await group.locator('select[data-marker="kept"]').count(), 1, '聚焦中的下拉框被刷新重建了');
  await select.evaluate(el => el.blur());
  await page.evaluate(() => refreshStatus());
  assert.equal(await group.locator('.group-local-time').innerText(), '当地 12:01', '失去焦点后恢复正常刷新');
  assert.deepEqual(errors, []);
});
