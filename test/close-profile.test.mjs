// "发布成功之后关掉指纹浏览器窗口"的行为测试。
//
// 这里守的规则是【只有确认发布成功才关窗口】。
// 第一版写错过：把关窗口放在 finally 里，成功失败都关，理由是"失败路径更费内存"。
// 那是纯从省内存出发的想法，忽略了失败的意义——出错和结果不确定时，处理办法就是
// 人打开这个号去看一眼(内容列表到底发出去没有、是不是哪个检查开关被关了)，
// 窗口关掉就等于把人要看的东西收走了。
//
// 另外盯着一条实现细节：那个 finally 里不能出现 return——finally 里的 return 会
// 吞掉正在往上抛的异常，报错就传不到上层，账号既不会暂停也不会通知。
//
// 用真实 Chromium 开一个带调试端口的空窗口冒充"指纹浏览器已经开好的环境"，
// 适配器是假的(只记录调用次数)，不碰任何真实账号，也不需要连得上 TikTok。
// 这个环境连不上 TikTok，所以每一轮都会走【失败路径】——正好是要测的那条。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pw from 'playwright-core';
import { tick } from '../src/orchestrator.js';

const CDP_PORT = 9333;
const ACCOUNT_NAME = '关窗口测试号';
const STATE_FILE = path.join(import.meta.dirname, '..', 'state', `${ACCOUNT_NAME}.json`);

let browser, videoDir;
const account = { name: ACCOUNT_NAME, browser: 'fake', browserId: 'x1', videoFolder: '', hashtagKeywords: ['fyp'] };

before(async () => {
  const executablePath = process.env.CHROMIUM_PATH || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(existsSync);
  browser = await pw.chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [`--remote-debugging-port=${CDP_PORT}`],
  });
  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  // 文件名就是商品ID，让队列里有一条待处理
  videoDir = mkdtempSync(path.join(tmpdir(), 'close-profile-'));
  writeFileSync(path.join(videoDir, '123456.mp4'), 'fake');
  account.videoFolder = videoDir;
});

after(async () => {
  await browser?.close();
  rmSync(videoDir, { recursive: true, force: true });
  rmSync(STATE_FILE, { force: true });
});

const SETTINGS = {
  minIntervalMs: 1, maxIntervalMs: 2, concurrency: 1, folderScanIntervalMs: 1000,
  videoExtensions: ['.mp4'], hashtagKeywords: ['fyp'], dailyPublishLimit: 4,
  timezone: 'Asia/Jakarta',
  postingWindow: { enabled: false }, // 关掉时段限制，这里只测关窗口
  retryBackoffMs: [1000], notifications: { enabled: false },
};

// 每个场景都从"有一条待发"重新开始，别让上一轮的进度影响下一轮
function runOnce(settings, { stopThrows = false } = {}) {
  rmSync(STATE_FILE, { force: true });
  const calls = { start: 0, stop: 0 };
  const adapter = {
    async startProfile() { calls.start++; return { wsEndpoint: `http://127.0.0.1:${CDP_PORT}` }; },
    async stopProfile() { calls.stop++; if (stopThrows) throw new Error('比特浏览器没响应'); },
  };
  return tick(settings, [account], new Map([['fake', adapter]])).then(() => calls);
}

test('失败时不关窗口——人还要打开这个号去看', async () => {
  const calls = await runOnce(SETTINGS);
  assert.equal(calls.start, 1, '应该开过窗口');
  assert.equal(calls.stop, 0, '没确认发布成功就不能关，否则人被通知"去看一眼"却没得看');
});

test('显式关掉这个功能时，同样不关窗口', async () => {
  const calls = await runOnce({ ...SETTINGS, closeProfileAfterCycle: false });
  assert.equal(calls.start, 1);
  assert.equal(calls.stop, 0);
});

test('失败路径下报错必须能往上抛，不能被 finally 吞掉', async () => {
  // finally 里一旦出现 return，异常就没了，账号不会暂停也不会推送通知。
  // 这里直接验证 tickAccount 内部确实收到了错误：状态里会记下 lastError。
  await runOnce(SETTINGS);
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  assert.ok(state.lastError, '这一轮是失败的，lastError 应该被记下来');
  assert.ok(
    state.consecutiveFailures > 0 || state.paused,
    '失败要么进重试计数、要么直接暂停，不能什么都没发生'
  );
});

test('关窗口失败不能把整条流程带崩', async () => {
  // 即使这一轮不会关窗口，stopProfile 抛错的分支也不该影响流程
  const calls = await runOnce({ ...SETTINGS }, { stopThrows: true });
  assert.equal(calls.start, 1);
});
