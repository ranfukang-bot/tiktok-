// "处理完一条就关掉指纹浏览器窗口"的行为测试。
//
// 关窗口是省内存的关键：一个开着的指纹浏览器窗口要占一千多MB。最要紧的不是
// 成功路径，而是【失败路径】——页面出错、账号被暂停几个小时，窗口更不该一直
// 挂在那里。所以关窗口这一步放在 finally 里，这里就是盯着它别被挪出去。
//
// 用真实 Chromium 开一个带调试端口的空窗口冒充"指纹浏览器已经开好的环境"，
// 适配器是假的(只记录调用次数)，不碰任何真实账号，也不需要连得上 TikTok。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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

test('老配置没有这个键时，默认就关窗口', async () => {
  const calls = await runOnce(SETTINGS);
  assert.equal(calls.start, 1, '应该开过窗口');
  assert.equal(calls.stop, 1, '处理完应该把窗口关掉');
});

test('显式关掉这个功能时，窗口保持开着', async () => {
  const calls = await runOnce({ ...SETTINGS, closeProfileAfterCycle: false });
  assert.equal(calls.start, 1);
  assert.equal(calls.stop, 0, '用户明确要求一直开着，就不能自作主张关掉');
});

test('显式开启时关窗口', async () => {
  const calls = await runOnce({ ...SETTINGS, closeProfileAfterCycle: true });
  assert.equal(calls.stop, 1);
});

test('关窗口这一步自己失败，不能把整条流程带崩', async () => {
  // 关不掉只是没省下内存，不该因此让这一条视频算作发布失败、更不该暂停账号
  const calls = await runOnce(SETTINGS, { stopThrows: true });
  assert.equal(calls.stop, 1, '应该尝试过关闭');
});
