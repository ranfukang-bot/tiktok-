// 比特窗口ID相关：打开失败时的诊断、编辑弹窗下拉框显示、重复ID提醒。全部用模拟数据，不连接真实比特浏览器。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import pw from 'playwright-core';
import { createBitBrowserAdapter } from '../src/browserAdapters/bitbrowser.js';
import { classifyError } from '../src/errorPolicy.js';

const NOT_FOUND = '服务调用成功，但没有找到相应数据!';
const response = data => ({ ok: true, async json() { return data; } });
function fixture(handler) {
  const calls = [];
  const adapter = createBitBrowserAdapter({ baseUrl: 'http://127.0.0.1:54345' }, {
    async request(url, options) {
      const call = { url, body: options.body ? JSON.parse(options.body) : null };
      calls.push(call);
      return response(await handler(call));
    },
    async delay() {},
  });
  return { adapter, calls };
}
const opens = calls => calls.filter(c => c.url.endsWith('/browser/open')).length;

test('打开报"没有找到相应数据"且列表里确实没有这个ID：明说ID不对，按配置错误立即停，不白白重试', async () => {
  const f = fixture(({ url }) => {
    if (url.endsWith('/browser/ports')) return { success: true, data: {} };
    if (url.endsWith('/browser/open') || url.endsWith('/browser/detail')) return { success: false, msg: NOT_FOUND };
    if (url.endsWith('/browser/list')) return { success: true, data: { list: [{ id: 'other-1', name: '菲律宾6号机1号' }, { id: 'other-2', name: '菲律宾6号机2号' }] } };
    throw new Error('unexpected ' + url);
  });
  const err = await f.adapter.startProfile({ name: '菲律宾7号机1号', browserId: 'stale-id' }).catch(e => e);
  assert.equal(err.code, 'BITBROWSER_PROFILE_NOT_FOUND');
  assert.match(err.message, /找不到环境ID「stale-id」/);
  assert.match(err.message, /重新选对应的比特窗口/);
  assert.equal(opens(f.calls), 1, '不对确定不存在的ID做短重试');
  assert.equal(classifyError(err).kind, 'config');
});

test('ID在比特里查得到但打开仍报没有数据：说明ID是对的、问题在比特那边，保持原来的可重试分类', async () => {
  const f = fixture(({ url }) => {
    if (url.endsWith('/browser/ports')) return { success: true, data: {} };
    if (url.endsWith('/browser/open')) return { success: false, msg: NOT_FOUND };
    if (url.endsWith('/browser/detail')) return { success: true, data: { id: 'real-id', seq: 112, name: '李燕菲律宾7号机1号' } };
    throw new Error('unexpected ' + url);
  });
  const err = await f.adapter.startProfile({ name: '菲律宾7号机1号', browserId: 'real-id' }).catch(e => e);
  assert.match(err.message, /没有找到相应数据/);
  assert.match(err.message, /环境ID是对的/);
  assert.match(err.message, /序号112「李燕菲律宾7号机1号」/);
  assert.notEqual(classifyError(err).kind, 'config');
});

test('detail 查不到但列表里有：同样认定ID存在', async () => {
  const f = fixture(({ url }) => {
    if (url.endsWith('/browser/ports')) return { success: true, data: {} };
    if (url.endsWith('/browser/open') || url.endsWith('/browser/detail')) return { success: false, msg: NOT_FOUND };
    return { success: true, data: [{ id: 'real-id', seq: 113, name: '李燕菲律宾7号机2号' }] };
  });
  const err = await f.adapter.startProfile({ browserId: 'real-id' }).catch(e => e);
  assert.match(err.message, /序号113「李燕菲律宾7号机2号」/);
  assert.notEqual(err.code, 'BITBROWSER_PROFILE_NOT_FOUND');
});

test('列表为空或读取失败时不下"ID不存在"的结论，保留比特原始报错', async () => {
  for (const list of [{ success: true, data: [] }, { success: false, msg: '未登录' }]) {
    const f = fixture(({ url }) => {
      if (url.endsWith('/browser/ports')) return { success: true, data: {} };
      if (url.endsWith('/browser/open') || url.endsWith('/browser/detail')) return { success: false, msg: NOT_FOUND };
      return list;
    });
    const err = await f.adapter.startProfile({ browserId: 'x' }).catch(e => e);
    assert.equal(err.message, `比特浏览器接口 /browser/open 返回错误: ${NOT_FOUND}`);
    assert.notEqual(classifyError(err).kind, 'config');
  }
});

test('其它打开错误不触发诊断查询', async () => {
  const f = fixture(({ url }) => url.endsWith('/browser/ports') ? { success: true, data: {} } : { success: false, msg: 'profile permission denied' });
  await assert.rejects(f.adapter.startProfile({ browserId: 'x' }), /permission denied/);
  assert.ok(!f.calls.some(c => c.url.endsWith('/browser/detail') || c.url.endsWith('/browser/list')));
});

// ---------- 真实控制台页面：编辑弹窗里的窗口下拉框 ----------
let browser, page;
before(async () => {
  const executablePath = process.env.CHROMIUM_PATH || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(existsSync);
  browser = await pw.chromium.launch(executablePath ? { executablePath } : {});
  page = await browser.newPage();
});
after(async () => { await browser?.close(); });

test('真实控制台JS：打开哪个账号，下拉框就显示哪个账号自己的窗口；ID不在列表里明确提示（模拟API）', async () => {
  const example = JSON.parse(readFileSync(new URL('../config/settings.example.json', import.meta.url), 'utf8'));
  const profiles = [
    { id: 'id-1', name: '李燕菲律宾7号机1号' },
    { id: 'id-2', name: '李燕菲律宾7号机2号' },
    { id: 'id-3', name: '李燕菲律宾7号机3号' },
  ];
  const acc = (name, browserId) => ({ name, browser: 'bitbrowser', browserId, videoFolder: `C:/fixture/${name}`, phoneGroup: '菲律宾7号机' });
  const accounts = [acc('菲律宾7号机1号', 'id-1'), acc('菲律宾7号机2号', 'id-2'), acc('菲律宾7号机3号', 'id-3'), acc('旧ID账号', 'deleted-id')];
  let profileReads = 0;
  await page.route('http://picker.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/' || path === '/app.js' || path === '/style.css') {
      const file = path === '/' ? 'index.html' : path.slice(1);
      const body = readFileSync(new URL('../public/' + file, import.meta.url), 'utf8');
      return route.fulfill({ body, contentType: path === '/' ? 'text/html' : path.endsWith('.js') ? 'text/javascript' : 'text/css' });
    }
    if (path === '/api/logs/stream') return route.fulfill({ body: '', contentType: 'text/event-stream' });
    let value = {};
    if (path === '/api/settings') value = example;
    if (path === '/api/accounts') value = accounts;
    if (path === '/api/status') value = { running: false, accounts: [] };
    if (path === '/api/bitbrowser/profiles') { profileReads += 1; value = profiles; }
    return route.fulfill({ json: value });
  });
  await page.goto('http://picker.test/');
  await page.waitForFunction(() => accountsConfig.length === 4);
  const picked = () => page.evaluate(() => {
    const s = document.getElementById('a-bitbrowser-picker');
    return s.options[s.selectedIndex]?.textContent;
  });
  const open = async (idx) => {
    const before = profileReads;
    await page.evaluate((i) => openAccountModal(i), idx);
    await page.waitForFunction(() => document.getElementById('a-bitbrowser-picker').options.length > 1);
    await page.waitForTimeout(50);
    return before;
  };

  // 3号机里选了3号窗口
  await open(2);
  await page.selectOption('#a-bitbrowser-picker', 'id-3');
  assert.equal(await page.inputValue('#a-profileid'), 'id-3');
  await page.evaluate(() => closeAccountModal());

  // 再打开1号、2号：显示各自的窗口，不是最后选过的3号
  await open(0);
  assert.equal(await picked(), '李燕菲律宾7号机1号');
  assert.equal(await page.inputValue('#a-profileid'), 'id-1');
  await page.evaluate(() => closeAccountModal());
  await open(1);
  assert.equal(await picked(), '李燕菲律宾7号机2号');
  await page.evaluate(() => closeAccountModal());

  // 每次打开都重新读列表（比特里新建的窗口马上能选到）
  const readsBefore = profileReads;
  await open(0);
  assert.ok(profileReads > readsBefore);

  // 下拉框显示的就是要选的窗口时，ID也确实是它的——选别的再选回来ID跟着变
  await page.selectOption('#a-bitbrowser-picker', 'id-2');
  assert.equal(await page.inputValue('#a-profileid'), 'id-2');
  await page.selectOption('#a-bitbrowser-picker', 'id-1');
  assert.equal(await page.inputValue('#a-profileid'), 'id-1');
  await page.evaluate(() => closeAccountModal());

  // 存的是列表里没有的ID（窗口删了重建/选错）：明确提示，不冒充成别的窗口
  await open(3);
  assert.match(await picked(), /比特列表里没有这个ID/);
  assert.equal(await page.inputValue('#a-profileid'), 'deleted-id');
  // 重新选一个窗口后提示消失
  await page.selectOption('#a-bitbrowser-picker', 'id-3');
  assert.equal(await page.inputValue('#a-profileid'), 'id-3');
  assert.equal(await page.locator('#a-bitbrowser-picker option[data-missing]').count(), 0);
  // 手动粘贴ID，下拉框跟着显示对应窗口名
  await page.fill('#a-profileid', 'id-2');
  assert.equal(await picked(), '李燕菲律宾7号机2号');
  await page.evaluate(() => closeAccountModal());

  // 新加账号：下拉框回到"从列表选择…"，不带上一个账号的窗口名
  await open(null);
  assert.equal(await picked(), '从列表选择…');
  assert.equal(await page.inputValue('#a-profileid'), '');
});
