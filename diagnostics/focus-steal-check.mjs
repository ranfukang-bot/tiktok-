// 焦点检测：自动发布清除默认标题时，为什么会把你正在用的程序（比如游戏）切出去？
//
// 这个工具不碰任何账号、不打开 TikTok：它单独开一个临时的干净浏览器窗口，放一个仿 TikTok 文案框的测试页，
// 把清标题、点话题时的每个小动作逐个做一遍。每一步开始前，确保这个黑色命令行窗口在最前面；
// 做完后检查浏览器有没有把自己提到最前，最后列出到底是哪一步在抢焦点。
//
// 用法：双击 diagnostics\focus-check.bat。按窗口里的提示，被切走时点一下这个黑色窗口即可。
// 结果同时保存到 diagnostics\output\focus-check-result.txt（该目录不会被提交）。
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { cdpConnectOptions } from '../src/orchestrator.js';
import { BACKGROUND_SAFE_ARGS } from '../src/browserAdapters/bitbrowser.js';
import { installTkqInPage } from '../src/browser/injected.js';
import { fillCaption } from '../src/browser/tiktokStudio.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// FOCUS_CHECK_FAKE=1 只用于在非 Windows 环境里检查脚本本身能跑通，不代表检测结果。
const FAKE = process.env.FOCUS_CHECK_FAKE === '1';
const PORT = 9555;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.platform !== 'win32' && !FAKE) {
  console.log('这个检测只能在 Windows 上运行。');
  process.exit(1);
}

const FG_SCRIPT = [
  "$sig = '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); " +
    "[DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);'",
  'Add-Type -MemberDefinition $sig -Name FgWin -Namespace FocusCheck',
  '$h = [FocusCheck.FgWin]::GetForegroundWindow()',
  '[uint32]$procId = 0',
  '[void][FocusCheck.FgWin]::GetWindowThreadProcessId($h, [ref]$procId)',
  '(Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName',
].join('; ');

// 当前在最前面的窗口属于哪个程序（进程名）。
function foregroundProcess() {
  if (FAKE) return 'cmd';
  try {
    const encoded = Buffer.from(FG_SCRIPT, 'utf16le').toString('base64');
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim().toLowerCase();
  } catch {
    return 'unknown';
  }
}

const exe = process.env.CHROMIUM_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
if (!exe) {
  console.log('没找到 Chrome 或 Edge，无法检测。');
  process.exit(1);
}
const browserProcessName = path.basename(exe, '.exe').toLowerCase();

// 双击 bat 后最前面的就是这个黑色窗口：在打开浏览器之前记下它属于哪个程序，
// 之后每一步都和它比。不只看浏览器——中文输入法等其它程序的窗口跳到最前面，同样会把游戏切出去。
const consoleProcess = foregroundProcess();
if (!consoleProcess || consoleProcess === 'unknown' || consoleProcess === browserProcessName) {
  console.log(`读不到当前最前面的窗口（得到的是：${consoleProcess || '空'}），检测无法进行。`);
  console.log('请双击 focus-check.bat 后不要切换窗口，让这个黑色窗口保持在最前面再试一次。');
  process.exit(1);
}

const profile = mkdtempSync(path.join(os.tmpdir(), 'tkq-focus-check-'));
const child = spawn(exe, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--window-position=40,40', '--window-size=1000,700', ...BACKGROUND_SAFE_ARGS,
  ...(FAKE ? ['--headless=new', '--no-sandbox'] : []), 'about:blank',
], { stdio: 'ignore', detached: false });

const endpoint = `http://127.0.0.1:${PORT}`;
let browser;
for (let i = 0; i < 60 && !browser; i += 1) {
  await sleep(500);
  try {
    const res = await fetch(`${endpoint}/json/version`);
    if (res.ok) browser = await chromium.connectOverCDP(endpoint, cdpConnectOptions(endpoint));
  } catch { /* 浏览器还在启动 */ }
}
if (!browser) {
  console.log(`浏览器没有在 ${PORT} 端口启动成功，可能端口被占用。请关掉其它测试程序后重试。`);
  child.kill();
  process.exit(1);
}

const page = browser.contexts()[0].pages()[0] || await browser.contexts()[0].newPage();
const TEST_PAGE = `<title>焦点检测测试页</title>
  <div class="caption-editor"><div contenteditable="true" style="min-height:40px;border:1px solid #999;padding:6px">1737318339699312031</div></div>
  <div style="margin-top:20px">${['fyp', 'tiktok', 'tiktokshop'].map((t) =>
    `<span class="suggest-item" data-tag="${t}" style="display:inline-block;padding:8px;border:1px solid #ccc;margin-right:8px">#${t}</span>`).join('')}</div>
  <script>
    // 包在函数里：同一个窗口多次加载测试页时，顶层 const 会重复声明报错。
    (() => {
      const editor = document.querySelector('.caption-editor [contenteditable]');
      for (const chip of document.querySelectorAll('.suggest-item')) chip.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const cur = editor.textContent.trim();
        editor.textContent = (cur ? cur + ' ' : '') + '#' + chip.dataset.tag;
      });
    })();
  </script>`;
const config = { hashtagKeywords: ['fyp', 'tiktok', 'tiktokshop'], text: {} };
const log = { info() {}, warn() {}, error() {} };
async function freshPage() {
  await page.setContent(TEST_PAGE);
  await page.evaluate(installTkqInPage, config);
}
async function editorPoint() {
  return page.evaluate(() => {
    const r = document.querySelector('.caption-editor [contenteditable]').getBoundingClientRect();
    return { x: r.left + 40, y: r.top + r.height / 2 };
  });
}
async function chipPoint() {
  return page.evaluate(() => {
    const r = document.querySelector('.suggest-item').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

const steps = [
  ['对照组：旧版"把窗口提到最前"（page.bringToFront）。这一步应该会抢焦点', async () => { await page.bringToFront(); }],
  ['模拟鼠标点击文案框', async () => { const p = await editorPoint(); await page.mouse.click(p.x, p.y); }],
  ['模拟键盘 Ctrl+A（全选标题）', async () => { await page.keyboard.press('Control+A'); }],
  ['模拟键盘 Backspace（删除标题）', async () => { await page.keyboard.press('Backspace'); }],
  ['模拟鼠标点击话题标签', async () => { const p = await chipPoint(); await page.mouse.click(p.x, p.y); }],
  ['页面在文案框获得焦点时自己调用 window.focus()（模拟 TikTok 页面可能有的行为）', async () => {
    await page.evaluate(() => {
      const editor = document.querySelector('.caption-editor [contenteditable]');
      editor.blur();
      editor.addEventListener('focus', () => window.focus(), { once: true });
    });
    const p = await editorPoint();
    await page.mouse.click(p.x, p.y);
  }],
  ['不用鼠标，脚本直接让文案框获得焦点，再用键盘全选删除', async () => {
    await page.evaluate(() => document.querySelector('.caption-editor [contenteditable]').focus());
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
  }],
  ['完整跑一遍现在线上的清标题+点话题代码（fillCaption）', async () => { await fillCaption(page, config, log); }],
];

console.log('');
console.log('==================== 焦点检测 ====================');
console.log(`使用浏览器：${exe}`);
console.log('刚弹出的浏览器窗口是检测用的临时窗口，不会登录任何账号。');
console.log('每一步开始前，请确保这个黑色窗口在最前面（被切走就点一下这个黑色窗口）。');
console.log('检测过程中不需要做别的操作，大约 1～2 分钟。第 1 步是对照组，正常应该显示"抢走了焦点"；');
console.log('如果第 1 步显示"没有抢焦点"，说明这台电脑上检测本身没生效，结果不能用。');
console.log('==================================================');

async function waitUntilConsoleInFront() {
  let warned = false;
  for (;;) {
    const fg = foregroundProcess();
    if (fg === consoleProcess) return fg;
    if (!warned) { console.log(`  >> 现在最前面的是"${fg}"，请点一下这个黑色窗口，让它回到最前面…`); warned = true; }
    await sleep(800);
  }
}

const results = [];
await freshPage();
for (const [index, [name, run]] of steps.entries()) {
  if (index === steps.length - 1) await freshPage();
  console.log(`\n第 ${index + 1}/${steps.length} 步：${name}`);
  const before = await waitUntilConsoleInFront();
  await sleep(1500);
  let error = '';
  try { await run(); } catch (err) { error = String(err.message || err).split('\n')[0]; }
  await sleep(1500);
  const after = foregroundProcess();
  const stolen = after !== consoleProcess;
  const who = after === browserProcessName ? '浏览器' : `"${after}"`;
  results.push({ step: index + 1, name, before, after, stolen, error });
  console.log(`  结果：${stolen ? `【抢走了焦点】${who} 跑到了最前面` : '没有抢焦点'}${error ? `（这一步本身报错：${error}）` : ''}`);
}

const summary = [
  `焦点检测结果  ${new Date().toLocaleString()}`,
  `浏览器：${exe}`,
  `黑色窗口所属程序：${consoleProcess}`,
  ...results.map((r) => `第${r.step}步 ${r.stolen ? '【抢焦点】' : '不抢    '} ${r.name}${r.error ? `（报错：${r.error}）` : ''}  [之前前台:${r.before} 之后前台:${r.after}]`),
].join('\n');
console.log('\n==================== 汇总 ====================');
console.log(summary);
const outDir = path.join(repo, 'diagnostics', 'output');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'focus-check-result.txt'), summary + '\n', 'utf8');
console.log(`\n结果已保存到 ${path.join(outDir, 'focus-check-result.txt')}，把上面"汇总"这几行复制发给 Claude 即可。`);

await browser.close().catch(() => {});
child.kill();
await sleep(1000);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* 浏览器还没完全退出时删不掉，不影响 */ }
process.exit(0);
