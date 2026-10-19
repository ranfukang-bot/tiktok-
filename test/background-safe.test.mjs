// 自动发布在后台运行时不能抢走用户前台程序（例如全屏游戏）的焦点。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createBitBrowserAdapter, BACKGROUND_SAFE_ARGS } from '../src/browserAdapters/bitbrowser.js';
import { fillCaption } from '../src/browser/tiktokStudio.js';
import { installTkqInPage } from '../src/browser/injected.js';

const repo = path.resolve(import.meta.dirname, '..');

test('比特浏览器打开环境时带上关闭后台限速的启动参数', async () => {
  const bodies = [];
  const adapter = createBitBrowserAdapter({ baseUrl: 'http://127.0.0.1:54345' }, {
    async request(url, options) {
      const body = options.body ? JSON.parse(options.body) : null;
      if (url.endsWith('/browser/ports')) return { ok: true, async json() { return { success: true, data: {} }; } };
      bodies.push(body);
      return { ok: true, async json() { return { success: true, data: { ws: 'ws://127.0.0.1:1/devtools/browser/x' } }; } };
    },
    async delay() {},
  });
  await adapter.startProfile({ name: '夹具', browserId: 'abc' });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].id, 'abc');
  for (const flag of ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']) {
    assert.ok(bodies[0].args.includes(flag), `缺少启动参数 ${flag}`);
  }
  assert.deepEqual(bodies[0].args, BACKGROUND_SAFE_ARGS);
});

test('源码里不能有把浏览器窗口提到前台的调用', () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.js')) files.push(full);
    }
  };
  walk(path.join(repo, 'src'));
  for (const file of files) {
    const code = readFileSync(file, 'utf8').split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    assert.ok(!/bringToFront\s*\(|Target\.activateTarget/.test(code), `${path.relative(repo, file)} 会把窗口提到前台`);
  }
});

let browser;
after(async () => { await browser?.close(); });

test('页面不在前台时，清空默认标题并点选历史话题照样完成，且全程不把窗口提到前台', async () => {
  const executablePath = process.env.CHROMIUM_PATH || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(existsSync);
  browser = await chromium.launch(executablePath ? { executablePath } : {});
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(`
    <div class="caption-editor"><div contenteditable="true" style="min-height:40px;border:1px solid #999">1737318339699312031</div></div>
    <div id="chips" style="margin-top:20px">
      <span class="suggest-item" data-tag="fyp" style="display:inline-block;padding:6px">#fyp</span>
      <span class="suggest-item" data-tag="tiktok" style="display:inline-block;padding:6px">#tiktok</span>
      <span class="suggest-item" data-tag="tiktokshop" style="display:inline-block;padding:6px">#tiktokshop</span>
    </div>
    <script>
      const editor = document.querySelector('.caption-editor [contenteditable]');
      for (const chip of document.querySelectorAll('.suggest-item')) {
        chip.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const current = editor.textContent.trim();
          editor.textContent = (current ? current + ' ' : '') + '#' + chip.dataset.tag;
        });
      }
    </script>`);
  // 另开一个页面放到前面，模拟自动发布的页面不在前台
  const other = await context.newPage();
  await other.bringToFront();
  let raised = 0;
  page.bringToFront = async () => { raised += 1; };
  const config = { hashtagKeywords: ['fyp', 'tiktok', 'tiktokshop'], text: {} };
  await page.evaluate(installTkqInPage, config);
  const log = { info() {}, warn() {}, error() {} };
  const caption = await fillCaption(page, config, log);
  assert.equal(raised, 0, '不能调用 bringToFront');
  assert.equal(caption.replace(/\s+/g, ' ').trim(), '#fyp #tiktok #tiktokshop');
});
