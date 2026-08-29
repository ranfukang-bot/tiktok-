import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';
import open from 'open';
import {
  ensureConfigFiles,
  loadSettings,
  saveSettings,
  loadAllAccounts,
  saveAccounts,
} from './config.js';
import * as controller from './controller.js';
import { recentLogs, subscribe } from './logBus.js';
import { createAdapter } from './browserAdapters/index.js';
import { sendTestNotification } from './notifier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8765;

ensureConfigFiles();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

function handleError(res, err) {
  console.error(err);
  res.status(400).json({ error: err.message });
}

app.get('/api/status', (req, res) => {
  try {
    res.json(controller.getStatus());
  } catch (err) {
    handleError(res, err);
  }
});

app.post('/api/orchestrator/start', (req, res) => {
  try {
    controller.start();
    res.json({ running: controller.isRunning() });
  } catch (err) {
    handleError(res, err);
  }
});

app.post('/api/orchestrator/stop', (req, res) => {
  controller.stop();
  res.json({ running: controller.isRunning() });
});

app.get('/api/settings', (req, res) => {
  try {
    res.json(loadSettings());
  } catch (err) {
    handleError(res, err);
  }
});

app.put('/api/settings', (req, res) => {
  try {
    const settings = req.body;
    if (!settings || typeof settings !== 'object') throw new Error('设置内容格式不对');
    if (!settings.minIntervalMs || !settings.maxIntervalMs) throw new Error('必须填写发布间隔的最小值和最大值');
    if (settings.minIntervalMs > settings.maxIntervalMs) throw new Error('间隔最小值不能大于最大值');
    saveSettings(settings);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

app.get('/api/accounts', (req, res) => {
  try {
    res.json(loadAllAccounts());
  } catch (err) {
    handleError(res, err);
  }
});

app.put('/api/accounts', (req, res) => {
  try {
    const accounts = req.body;
    if (!Array.isArray(accounts)) throw new Error('账号列表格式不对');
    const names = new Set();
    for (const account of accounts) {
      if (!account.name || !account.name.trim()) throw new Error('每个账号都要填名称');
      if (names.has(account.name)) throw new Error(`账号名称重复: ${account.name}`);
      names.add(account.name);
      if (!account.videoFolder || !account.videoFolder.trim()) throw new Error(`账号 "${account.name}" 没有填视频文件夹路径`);
      if (account.browser === 'adspower' && !account.profileId) throw new Error(`账号 "${account.name}" 是AdsPower但没填环境ID`);
      if (account.browser === 'hubstudio' && !account.containerCode) throw new Error(`账号 "${account.name}" 是Hubstudio但没填环境ID`);
      if (account.browser === 'bitbrowser' && !account.browserId) throw new Error(`账号 "${account.name}" 是比特浏览器但没填环境ID`);
    }
    saveAccounts(accounts);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

app.post('/api/accounts/:name/scan', async (req, res) => {
  try {
    const result = await controller.scanAccountNow(req.params.name);
    res.json({ ok: true, ...(result || {}) });
  } catch (err) {
    handleError(res, err);
  }
});

app.post('/api/accounts/:name/pause', (req, res) => {
  try {
    controller.setAccountPaused(req.params.name, true);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

app.post('/api/accounts/:name/resume', (req, res) => {
  try {
    controller.setAccountPaused(req.params.name, false);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

app.post('/api/accounts/:name/resolve', async (req, res) => {
  try {
    const { decision } = req.body || {};
    if (decision !== 'published' && decision !== 'retry') throw new Error('decision 必须是 published 或 retry');
    await controller.resolveUncertain(req.params.name, decision);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

// "发送测试通知"按钮：故意把错误原样抛给前端，方便用户看出是哪里填错了
app.post('/api/notifications/test', async (req, res) => {
  try {
    await sendTestNotification(loadSettings());
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

// 供添加账号弹窗里"从比特浏览器读取环境列表"用，这样不用手动去找/抄环境ID。
app.get('/api/bitbrowser/profiles', async (req, res) => {
  try {
    const settings = loadSettings();
    const adapter = createAdapter('bitbrowser', settings);
    const profiles = await adapter.listProfiles();
    res.json(profiles);
  } catch (err) {
    handleError(res, err);
  }
});

// 打开系统原生的"选择文件夹"对话框（目前只支持 Windows；其它系统请直接把路径粘贴进输入框）。
app.post('/api/pick-folder', (req, res) => {
  if (process.platform !== 'win32') {
    return res.status(501).json({ error: '当前系统不支持自动弹出文件夹选择框，请直接把文件夹路径粘贴到输入框里' });
  }
  const script =
    'Add-Type -AssemblyName System.Windows.Forms; ' +
    '$f = New-Object System.Windows.Forms.FolderBrowserDialog; ' +
    "if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }";
  execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 120000 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: `无法打开文件夹选择框: ${err.message}` });
    const selected = stdout.trim();
    res.json({ path: selected || null });
  });
});

app.get('/api/logs', (req, res) => {
  res.json(recentLogs());
});

app.get('/api/logs/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const unsubscribe = subscribe((entry) => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  });
  req.on('close', unsubscribe);
});

app.listen(PORT, () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`TikTok 批量发布控制台已启动: ${url}`);
  open(url).catch(() => {
    console.log('没能自动打开浏览器，请手动访问上面这个地址');
  });
});
