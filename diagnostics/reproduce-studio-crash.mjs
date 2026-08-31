import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { installTkqInPage } from '../src/browser/injected.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(dirname, '..');
const outputDir = path.join(dirname, 'output');
const uploadUrl = 'https://www.tiktok.com/tiktokstudio/upload?from=upload';
const accountName = process.argv[2] || '1号机印尼1号';

const settings = JSON.parse(readFileSync(path.join(projectRoot, 'config', 'settings.json'), 'utf8'));
const accounts = JSON.parse(readFileSync(path.join(projectRoot, 'config', 'accounts.json'), 'utf8'));
const account = accounts.find((candidate) => candidate.name === accountName);
if (!account) throw new Error(`找不到账号：${accountName}`);
if (account.browser !== 'bitbrowser') throw new Error(`诊断脚本当前只支持比特浏览器，实际为：${account.browser}`);

const slug = account.name.replace(/[^a-zA-Z0-9_\-一-龥]/g, '_');
const state = JSON.parse(readFileSync(path.join(projectRoot, 'state', `${slug}.json`), 'utf8'));
const item = state.items[state.doneIndex + 1];
if (!item) throw new Error(`账号 ${account.name} 没有待处理视频`);

const videoPath = path.join(account.videoFolder, item.relativePath.split('/').join(path.sep));
const config = {
  text: { ...settings.text, ...(account.textOverrides || {}) },
  hashtagKeywords: account.hashtagKeywords || settings.hashtagKeywords,
};

mkdirSync(outputDir, { recursive: true });
const runStartedAt = new Date();
const runId = runStartedAt.toISOString().replace(/[:.]/g, '-');
const outputPath = path.join(outputDir, `${slug}-${runId}.json`);

const events = [];
const jsErrors = [];
const probeNetwork = [];
const requests = new Map();
let requestSequence = 0;
let crash = null;
let lastSuccessfulStep = '尚未开始自动化';

function now() {
  return new Date().toISOString();
}

function safeText(value, limit = 500) {
  return String(value ?? '').slice(0, limit);
}

function record(type, detail = {}) {
  const entry = { at: now(), type, ...detail };
  events.push(entry);
  console.log(`[DIAG] ${entry.at} ${type} ${JSON.stringify(detail)}`);
  return entry;
}

function requestSnapshot(request) {
  const existing = requests.get(request);
  if (existing) return existing;
  const entry = {
    sequence: ++requestSequence,
    startedAt: now(),
    completedAt: null,
    method: request.method(),
    url: request.url(),
    resourceType: request.resourceType(),
    status: null,
    failure: null,
  };
  requests.set(request, entry);
  return entry;
}

function latestRequestsBefore(epochMs, limit = 10) {
  return Array.from(requests.values())
    .filter((entry) => Date.parse(entry.startedAt) <= epochMs)
    .sort((a, b) => Date.parse(b.completedAt || b.startedAt) - Date.parse(a.completedAt || a.startedAt))
    .slice(0, limit)
    .reverse();
}

function installDiagnosticProbe() {
  if (window.__ttStudioDiag?.installed) return window.__ttStudioDiag;

  const network = [];
  const errors = [];
  const maxRecords = 200;
  const emit = (type, detail) => {
    const entry = { at: new Date().toISOString(), epochMs: Date.now(), type, ...detail };
    if (type.startsWith('network:')) {
      network.push(entry);
      if (network.length > maxRecords) network.shift();
    } else if (type === 'js:error' || type === 'js:unhandledrejection') {
      errors.push(entry);
      if (errors.length > maxRecords) errors.shift();
    }
    console.error('[TT-DIAG] ' + JSON.stringify(entry));
    try {
      const pending = window.__ttDiagEmit?.(entry);
      if (pending?.catch) pending.catch(() => {});
    } catch {}
    return entry;
  };

  const errorDetails = (value) => {
    if (value instanceof Error) {
      return { message: value.message || String(value), stack: value.stack || '' };
    }
    if (value && typeof value === 'object') {
      let serialized = '';
      try {
        serialized = JSON.stringify(value);
      } catch {
        serialized = String(value);
      }
      return { message: serialized, stack: value.stack || '' };
    }
    return { message: String(value), stack: '' };
  };

  window.addEventListener(
    'error',
    (event) => {
      const details = errorDetails(event.error || event.message);
      emit('js:error', {
        message: event.message || details.message,
        stack: details.stack,
        filename: event.filename || '',
        lineno: event.lineno || 0,
        colno: event.colno || 0,
      });
    },
    true
  );

  window.addEventListener('unhandledrejection', (event) => {
    emit('js:unhandledrejection', errorDetails(event.reason));
  });

  const originalFetch = window.fetch;
  window.fetch = async function patchedFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    try {
      const response = await originalFetch.apply(this, arguments);
      if (!response.ok) {
        let body = '';
        try {
          body = (await response.clone().text()).slice(0, 500);
        } catch (bodyError) {
          body = `[读取响应体失败: ${bodyError?.message || bodyError}]`;
        }
        emit('network:fetch-non2xx', { url, method, status: response.status, body });
      }
      return response;
    } catch (error) {
      const details = errorDetails(error);
      emit('network:fetch-exception', { url, method, status: null, body: '', ...details });
      throw error;
    }
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    this.__ttDiagRequest = { method: String(method || 'GET').toUpperCase(), url: String(url) };
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function patchedSend() {
    const meta = this.__ttDiagRequest || { method: 'GET', url: '' };
    this.addEventListener('loadend', () => {
      if (this.status >= 200 && this.status < 300) return;
      let body = '';
      try {
        if (!this.responseType || this.responseType === 'text') body = String(this.responseText || '').slice(0, 500);
        else if (this.responseType === 'json') body = JSON.stringify(this.response).slice(0, 500);
        else body = `[responseType=${this.responseType}]`;
      } catch (bodyError) {
        body = `[读取响应体失败: ${bodyError?.message || bodyError}]`;
      }
      emit('network:xhr-non2xx', { ...meta, status: this.status, body });
    });
    this.addEventListener('error', () =>
      emit('network:xhr-exception', { ...meta, status: this.status || null, body: '', message: 'XMLHttpRequest error' })
    );
    this.addEventListener('abort', () =>
      emit('network:xhr-exception', { ...meta, status: this.status || null, body: '', message: 'XMLHttpRequest abort' })
    );
    this.addEventListener('timeout', () =>
      emit('network:xhr-exception', { ...meta, status: this.status || null, body: '', message: 'XMLHttpRequest timeout' })
    );
    try {
      return xhrSend.apply(this, arguments);
    } catch (error) {
      const details = errorDetails(error);
      emit('network:xhr-exception', { ...meta, status: this.status || null, body: '', ...details });
      throw error;
    }
  };

  let crashReported = false;
  let checkScheduled = false;
  const checkBody = () => {
    checkScheduled = false;
    if (crashReported) return;
    const text = document.body?.innerText || '';
    if (!text.includes('Ada masalah')) return;
    crashReported = true;
    emit('ui:ada-masalah', {
      url: location.href,
      lastNetworkRecords: network.slice(-10),
      bodyExcerpt: text.slice(0, 1000),
    });
  };
  const observer = new MutationObserver(() => {
    if (checkScheduled || crashReported) return;
    checkScheduled = true;
    setTimeout(checkBody, 25);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  checkBody();

  window.__ttStudioDiag = {
    installed: true,
    installedAt: new Date().toISOString(),
    network,
    errors,
    observer,
    dump: () => ({ installedAt: window.__ttStudioDiag.installedAt, network: [...network], errors: [...errors] }),
  };
  emit('probe:installed', { url: location.href });
  return { installed: true, installedAt: window.__ttStudioDiag.installedAt };
}

const baseUrl = (settings.bitbrowser?.baseUrl || 'http://127.0.0.1:54345').replace(/\/$/, '');
const openResponse = await fetch(`${baseUrl}/browser/open`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: account.browserId }),
});
if (!openResponse.ok) throw new Error(`比特浏览器 /browser/open 返回 HTTP ${openResponse.status}`);
const openJson = await openResponse.json();
if (!openJson.success) throw new Error(`比特浏览器打开环境失败：${openJson.msg || JSON.stringify(openJson)}`);
const wsEndpoint = openJson.data?.ws || (openJson.data?.http ? `http://${openJson.data.http}` : null);
if (!wsEndpoint) throw new Error('比特浏览器没有返回 CDP 地址');

record('run:start', { account: account.name, video: item.relativePath, hashtags: config.hashtagKeywords });
const browser = await chromium.connectOverCDP(wsEndpoint);
let page;

try {
  const context = browser.contexts()[0];
  page = context.pages().find((candidate) => candidate.url().includes('/tiktokstudio/')) || context.pages()[0] || (await context.newPage());

  await page.exposeFunction('__ttDiagEmit', (entry) => {
    record('probe:event', { entry });
    if (entry.type?.startsWith('network:')) probeNetwork.push(entry);
    if (entry.type === 'js:error' || entry.type === 'js:unhandledrejection') jsErrors.push(entry);
    if (entry.type === 'ui:ada-masalah' && !crash) {
      crash = {
        ...entry,
        lastRequests: latestRequestsBefore(entry.epochMs, 10),
        lastSuccessfulStep,
      };
    }
  });

  page.on('request', (request) => requestSnapshot(request));
  page.on('response', async (response) => {
    const request = response.request();
    const entry = requestSnapshot(request);
    entry.completedAt = now();
    entry.status = response.status();
    if (response.status() < 200 || response.status() >= 300) {
      let body = '';
      try {
        body = safeText(await response.text());
      } catch (error) {
        body = `[读取响应体失败: ${error?.message || error}]`;
      }
      entry.body = body;
      record('playwright:non2xx', { request: { ...entry } });
    }
  });
  page.on('requestfailed', (request) => {
    const entry = requestSnapshot(request);
    entry.completedAt = now();
    entry.failure = request.failure()?.errorText || 'unknown request failure';
    record('playwright:requestfailed', { request: { ...entry } });
  });
  page.on('pageerror', (error) => {
    const entry = { at: now(), type: 'playwright:pageerror', message: error.message, stack: error.stack || '' };
    jsErrors.push(entry);
    record('playwright:pageerror', entry);
  });
  page.on('console', (message) => {
    const text = message.text();
    if (text.startsWith('[TT-DIAG]') || text.startsWith('[TKQ]') || /VideoFrame|itsgonnafail|unload/i.test(text)) {
      record('browser:console', { level: message.type(), text: safeText(text, 4000) });
    }
  });
  page.on('dialog', (dialog) => dialog.accept().catch(() => {}));

  record('navigation:start', { url: uploadUrl });
  await page.goto(uploadUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('body').waitFor({ state: 'attached', timeout: 30000 });
  record('navigation:complete', { url: page.url() });

  const probeResult = await page.evaluate(installDiagnosticProbe);
  record('probe:ready', probeResult);
  await page.evaluate(installTkqInPage, config);
  lastSuccessfulStep = '诊断探针与自动化函数已注入';
  record('step:success', { step: lastSuccessfulStep });

  const fileInput = page.locator('input[type="file"][accept="video/*"]').first();
  await fileInput.waitFor({ state: 'attached', timeout: 30000 });
  await fileInput.setInputFiles(videoPath);
  lastSuccessfulStep = '已选择并上传同一视频文件';
  record('step:success', { step: lastSuccessfulStep, video: item.relativePath });

  await page.evaluate(([filename]) => window.__tkq.waitForUploadComplete(filename), [item.filename]);
  lastSuccessfulStep = '视频上传完成，TikTok 默认标题已出现';
  record('step:success', { step: lastSuccessfulStep });

  record('step:start', { step: '清空默认标题' });
  const captionPos = await page.evaluate(() => window.__tkq.locateCaptionEditor());
  if (!captionPos) throw new Error('没有找到可见的标题编辑框');
  record('step:detail', { step: '定位标题编辑框', pos: captionPos });
  await page.mouse.click(captionPos.x, captionPos.y);
  await page.keyboard.press('Control+A');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const selectedText = await page.evaluate(() => window.__tkq.getCaptionSelectionText());
  if (captionPos.text && !selectedText) throw new Error('真实 Ctrl+A 没有选中标题');
  await page.keyboard.press('Backspace');
  const captionCleared = await page.evaluate(() => window.__tkq.waitForCaptionCleared());
  if (!captionCleared) throw new Error('真实键盘清空后标题没有稳定保持为空');
  lastSuccessfulStep = '默认标题已用真实 Ctrl+A + Backspace 成功清空';
  record('step:success', { step: lastSuccessfulStep });

  await new Promise((resolve) => setTimeout(resolve, 1600));
  for (const keyword of config.hashtagKeywords) {
    record('step:start', { step: `点击历史话题 #${keyword}` });
    const pos = await page.evaluate(([value]) => window.__tkq.locateHashtagChip(value), [keyword]);
    if (!pos) throw new Error(`没有找到历史话题 #${keyword}`);
    record('step:detail', { step: `定位历史话题 #${keyword}`, pos });
    await page.mouse.move(pos.x, pos.y);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await page.mouse.click(pos.x, pos.y);
    await page.evaluate(([value]) => window.__tkq.confirmHashtagInserted(value), [keyword]);
    lastSuccessfulStep = `已点击并确认历史话题 #${keyword}`;
    record('step:success', { step: lastSuccessfulStep });
    await new Promise((resolve) => setTimeout(resolve, 650));
  }

  lastSuccessfulStep = '三个历史话题均已成功插入（诊断脚本按设计停止，未挂商品、未发布）';
  record('run:automatic-complete', { lastSuccessfulStep });
} catch (error) {
  record('run:error', { message: error.message, stack: error.stack || '', lastSuccessfulStep });
  await new Promise((resolve) => setTimeout(resolve, 2500));
} finally {
  let pageState = null;
  let probeDump = null;
  if (page) {
    try {
      pageState = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        bodyExcerpt: (document.body?.innerText || '').slice(0, 2000),
      }));
    } catch (error) {
      pageState = { readError: error.message, url: page.url() };
    }
    try {
      probeDump = await page.evaluate(() => window.__ttStudioDiag?.dump?.() || null);
    } catch (error) {
      probeDump = { readError: error.message };
    }
  }

  if (!crash && pageState?.bodyExcerpt?.includes('Ada masalah')) {
    const epochMs = Date.now();
    crash = {
      at: now(),
      epochMs,
      type: 'ui:ada-masalah-final-state',
      url: pageState.url,
      bodyExcerpt: pageState.bodyExcerpt,
      lastRequests: latestRequestsBefore(epochMs, 10),
      lastSuccessfulStep,
    };
  }

  const report = {
    runId,
    startedAt: runStartedAt.toISOString(),
    finishedAt: now(),
    account: account.name,
    video: { relativePath: item.relativePath, productId: item.productId, absolutePath: videoPath },
    hashtags: config.hashtagKeywords,
    lastSuccessfulStep,
    crash,
    jsErrors,
    probeNetwork,
    lastTwentyRequests: latestRequestsBefore(Date.now(), 20),
    pageState,
    probeDump,
    events,
  };
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`DIAGNOSTIC_REPORT=${outputPath}`);
  console.log(`DIAGNOSTIC_CRASH=${crash ? 'yes' : 'no'}`);
  console.log(`DIAGNOSTIC_LAST_SUCCESS=${lastSuccessfulStep}`);
  await browser.close().catch(() => {});
}
