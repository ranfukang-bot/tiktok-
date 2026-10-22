import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { pickFolder } from './pickFolder.js';
import open from 'open';
import {
  ensureConfigFiles,
  loadSettings,
  saveSettings,
  loadAllAccounts,
  saveAccounts,
  TEXT_PRESETS,
  DEFAULT_TEXT_PRESET,
  REQUIRED_TEXT_KEYS,
  SAFETY_CRITICAL_TEXT_KEYS,
  resolvePostingPlan,
  isValidTimezone,
} from './config.js';
import * as controller from './controller.js';
import { isAccountProcessing } from './orchestrator.js';
import { validateAccountNames, renameAccountStates } from './stateStore.js';
import { recentLogs, subscribe } from './logBus.js';
import { createAdapter } from './browserAdapters/index.js';
import { sendTestNotification } from './notifier.js';
import { screenProducts, loadVerdicts, saveVerdict } from './productScreen.js';
import { loadJoblist, saveJoblist, importFromCsv, mergeJoblist } from './joblist.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8765;

ensureConfigFiles();

const app = express();
const localHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const localOrigins = new Set([...localHosts].map(host => `http://${host}`));
app.use((req, res, next) => {
  if (!localHosts.has(req.headers.host)) {
    return res.status(403).json({ error: '控制台只允许本机地址访问' });
  }
  if (req.method !== 'GET' && req.headers.origin !== undefined && !localOrigins.has(req.headers.origin)) {
    return res.status(403).json({ error: '控制台拒绝来自非本机页面的操作' });
  }
  next();
});
// 选品表格用 base64 放在 JSON 里传，默认 100kb 不够，放宽到 2mb
app.use(express.json({ limit: '2mb' }));
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
    const window = settings.postingWindow;
    if (window && window.enabled && Number(window.startHour) >= Number(window.endHour)) {
      throw new Error('允许发布的时间段：开始时间必须早于结束时间，否则会一直卡在时间段外发不出去');
    }
    // 配错的节点宁可当场拒绝，也不要存进去——存进去之后每一轮tick都会抛错，
    // 表现成"所有账号都莫名其妙暂停"，比保存失败难查得多。
    if (settings.postingSlots && settings.postingSlots.enabled !== false) {
      resolvePostingPlan(settings); // 格式/顺序/重复都在这里校验，不合法直接抛
      if (!settings.postingSlots.slots || !settings.postingSlots.slots.length) {
        throw new Error('至少要留一个发布时间节点，否则永远不会发布');
      }
    }
    // 全局表单可能持有旧快照，分组时区只允许由专用接口更新。
    settings.phoneGroupTimezones = loadSettings().phoneGroupTimezones;
    saveSettings(settings);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

app.put('/api/phone-groups/:name/timezone', (req, res) => {
  try {
    const name = req.params.name.trim();
    if (!name) throw new Error('手机分组名不能为空');
    if (name === '未分组') throw new Error('未分组账号沿用全局时区，不能单独设置');
    const timezone = req.body?.timezone;
    if (timezone !== '' && !isValidTimezone(timezone)) {
      throw new Error('时区无效，请选择有效的 IANA 时区');
    }
    // 直接读取原始文件，只改分组时区，不把默认值或旧页面快照写回其它设置。
    const settings = JSON.parse(readFileSync(path.join(__dirname, '..', 'config', 'settings.json'), 'utf8'));
    const phoneGroupTimezones = { ...settings.phoneGroupTimezones, ...(timezone ? { [name]: timezone } : {}) };
    if (timezone === '') delete phoneGroupTimezones[name];
    settings.phoneGroupTimezones = phoneGroupTimezones;
    saveSettings(settings);
    controller.invalidateSchedule();
    res.json({ ok: true, phoneGroupTimezones });
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
    const accounts = Array.isArray(req.body) ? req.body : req.body?.accounts;
    if (!Array.isArray(accounts)) throw new Error('账号列表格式不对');

    const names = new Set();
    const warnings = [];
    for (const account of accounts) {
      if (!account.name || !account.name.trim()) throw new Error('每个账号都要填名称');
      if (names.has(account.name)) throw new Error(`账号名称重复: ${account.name}`);
      names.add(account.name);
      if (!account.videoFolder || !account.videoFolder.trim()) throw new Error(`账号 "${account.name}" 没有填视频文件夹路径`);
      if (account.browser === 'adspower' && !account.profileId) throw new Error(`账号 "${account.name}" 是AdsPower但没填环境ID`);
      if (account.browser === 'hubstudio' && !account.containerCode) throw new Error(`账号 "${account.name}" 是Hubstudio但没填环境ID`);
      if (account.browser === 'bitbrowser' && !account.browserId) throw new Error(`账号 "${account.name}" 是比特浏览器但没填环境ID`);
    }

    validateAccountNames(accounts);
    const previous = loadAllAccounts();
    const oldNames = new Set(previous.map(a => a.name));
    const removed = new Set(previous.filter(a => !names.has(a.name)).map(a => a.name));
    const added = new Set(accounts.filter(a => !oldNames.has(a.name)).map(a => a.name));
    const renames = Array.isArray(req.body) ? [] : (req.body.renames || []);
    if (!Array.isArray(renames)) throw new Error('改名信息格式不对');
    for (const rename of renames) {
      if (!rename || !removed.has(rename.from) || !added.has(rename.to)) {
        throw new Error('改名信息与账号列表不一致，请刷新后重试；新名称不能占用已有账号');
      }
      removed.delete(rename.from);
      added.delete(rename.to);
    }
    // 兼容旧客户端的单次改名，也不能靠不传 renames 绕过待确认保护。
    if (removed.size === 1 && added.size === 1) {
      renames.push({ from: [...removed][0], to: [...added][0] });
      removed.clear(); added.clear();
    }
    if (removed.size && added.size) throw new Error('无法确定多个账号的改名对应关系，请提供原名和新名');
    renameAccountStates(renames, { isProcessing: isAccountProcessing, commit: () => {
      try { saveAccounts(accounts); }
      catch (err) { saveAccounts(previous); throw err; }
    } });
    controller.invalidateSchedule();
    res.json({ ok: true, warnings });
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
    const result = await sendTestNotification(loadSettings());
    res.json({ ok: true, queued: Boolean(result?.queued) });
  } catch (err) {
    handleError(res, err);
  }
});

// 界面文案的预设和元信息统一由服务端提供，避免前端再抄一份键名清单(那会变成
// 第三处真值来源，迟早跟 config.js 对不上)。预设的值全部来自 src/config.js。
//
// 只提供【验证过】的预设：印尼语是从真实界面扒下来的；英语只填代码里本来就出现过
// 的英文词，安全项故意留空，不编造翻译——留空会被保存校验拦下来，逼着用户对照自己
// 的界面填，这比给一套看着像配好了、实际是错的翻译要好。
//
// globalPreset / globalText 是给前端复刻同一套合并规则用的：账号语言和全局语言不
// 一致时不继承 globalText，前端要能算出跟服务端一样的"实际生效值"。
app.get('/api/text-presets', (req, res) => {
  try {
    const settings = loadSettings();
    res.json({
      presets: TEXT_PRESETS,
      defaultPreset: DEFAULT_TEXT_PRESET,
      mode: 'dom',
      requiredKeys: REQUIRED_TEXT_KEYS,
      safetyCriticalKeys: SAFETY_CRITICAL_TEXT_KEYS,
      globalPreset: settings.textPreset || DEFAULT_TEXT_PRESET,
      globalText: settings.text || {},
    });
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
app.post('/api/pick-folder', async (req, res) => {
  if (process.platform !== 'win32') {
    return res.status(501).json({ error: '当前系统不支持自动弹出文件夹选择框，请直接把文件夹路径粘贴到输入框里' });
  }
  try {
    res.json({ path: await pickFolder() });
  } catch (err) {
    res.status(500).json({ error: `无法打开文件夹选择框: ${err.message}` });
  }
});

// ===== 品单 =====
// 一个品一行，商品ID当主键。收件箱靠它决定视频该送进哪个账号的文件夹。
app.get('/api/joblist', (req, res) => {
  try {
    res.json(loadJoblist());
  } catch (err) {
    handleError(res, err);
  }
});

app.put('/api/joblist', (req, res) => {
  try {
    res.json(saveJoblist(req.body));
  } catch (err) {
    handleError(res, err);
  }
});

// 把选品插件导出的 CSV 直接粘进来。已经存在的商品ID保留原有的账号设置，
// 不会因为重新导一次表就把你指好的账号清掉。
app.post('/api/joblist/import', (req, res) => {
  try {
    const { csvText, defaultAccount } = req.body || {};
    if (!csvText || !String(csvText).trim()) throw new Error('没有收到内容');
    const { items, skipped } = importFromCsv(csvText, { defaultAccount: defaultAccount || '' });
    const merged = mergeJoblist(loadJoblist(), items);
    res.json({ items: saveJoblist(merged.items), added: merged.added, kept: merged.kept, skipped });
  } catch (err) {
    handleError(res, err);
  }
});

// ===== 选品粗筛 =====
// 把 fastmoss 导出的榜单表读进来，按门槛筛一遍。
// 注意这一步替代不了扫码看详情——导出里没有广告佣金、库存和七天趋势。
app.post('/api/products/screen', (req, res) => {
  try {
    const { fileBase64, minCommission, minShopSales, requireCommission } = req.body || {};
    if (!fileBase64) throw new Error('没有收到文件');
    const buf = Buffer.from(fileBase64, 'base64');
    res.json(screenProducts(buf, {
      minCommission: Number(minCommission),
      minShopSales: Number(minShopSales),
      requireCommission,
    }));
  } catch (err) {
    handleError(res, err);
  }
});

// 记住"这个品我否决过/选用了"。榜单每次导出大量重复，没有这个记录
// 就会把同一个品反复扫码判断一遍——这是这个功能唯一比 Excel 强的地方。
app.get('/api/products/verdicts', (req, res) => {
  try {
    res.json(loadVerdicts());
  } catch (err) {
    handleError(res, err);
  }
});

app.post('/api/products/verdicts', (req, res) => {
  try {
    const { name, verdict, note } = req.body || {};
    res.json({ ok: true, saved: saveVerdict(name, verdict, note) });
  } catch (err) {
    handleError(res, err);
  }
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

export const server = app.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`TikTok 批量发布控制台已启动: ${url}`);
  open(url).catch(() => {
    console.log('没能自动打开浏览器，请手动访问上面这个地址');
  });
});

// 双击启动脚本时可能已有控制台在运行。确认是本应用后复用它，避免端口冲突崩溃。
server.on('error', async (err) => {
  const url = `http://127.0.0.1:${PORT}`;
  if (err.code === 'EADDRINUSE') {
    try {
      const response = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(3000) });
      const status = response.ok ? await response.json() : null;
      if (status && typeof status.running === 'boolean' && Array.isArray(status.accounts) &&
          Object.hasOwn(status, 'lastTickAt') && Object.hasOwn(status, 'settingsError')) {
        console.log(`控制台已经在运行，正在打开现有页面：${url}`);
        await open(url).catch(() => console.log(`请手动打开：${url}`));
        return;
      }
    } catch {
      // 端口可能由其它程序占用，不能把它误认成控制台。
    }
    console.error(`端口 ${PORT} 已被其它程序占用，无法启动控制台。`);
  } else {
    console.error(`控制台启动失败：${err.message}`);
  }
  process.exitCode = 1;
});
