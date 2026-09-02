let accountsConfig = [];
let currentSettings = null;
let statusData = { running: false, accounts: [] };

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) throw new Error((data && data.error) || `请求失败 (${res.status})`);
  return data;
}

// 保存账号列表。服务端对"这次没改动、但配置不合格"的老账号只发 warning 不拦截
// （否则一个坏账号会把人锁死，连修它删它都做不了），所以这些 warning 必须显示出来，
// 不然用户要等到那个账号真的跑不动了才知道。
async function putAccounts(next) {
  const res = await api('PUT', '/api/accounts', next);
  const warnings = (res && res.warnings) || [];
  showAccountWarnings(warnings);
  return res;
}

function showAccountWarnings(warnings) {
  const el = document.getElementById('accounts-warning');
  if (!el) return;
  if (!warnings.length) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.innerHTML =
    '<b>这些账号还不能跑：</b><ul style="margin:6px 0 0;padding-left:20px;">' +
    warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('') +
    '</ul>';
  el.classList.remove('hidden');
}

function showGlobalError(msg) {
  const el = document.getElementById('global-error');
  if (!msg) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.textContent = msg;
  el.classList.remove('hidden');
}

function fmtRemaining(ms) {
  if (ms <= 0) return '已到时间';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `还要 ${h} 小时 ${m} 分`;
  const s = Math.floor((ms % 60000) / 1000);
  return `还要 ${m} 分 ${s} 秒`;
}

// ===================== 账号列表渲染 =====================

// 顶部概览：进来第一眼要能回答"几个号在跑 / 今天发了多少 / 还剩多少没发 /
// 有没有事等我处理"。之前这些数字散在每张卡片里，得一张张看过去才拼得出来。
function renderStats() {
  const box = document.getElementById('stats');
  if (!box) return;

  const runtimes = statusData.accounts || [];
  const enabled = accountsConfig.filter((a) => a.enabled !== false).length;
  let publishedToday = 0;
  let quotaToday = 0;
  let pending = 0;
  let needsMe = 0;
  for (const r of runtimes) {
    publishedToday += r.publishedToday || 0;
    if (r.dailyLimit) quotaToday += r.dailyLimit;
    pending += r.remaining || 0;
    if (r.paused) needsMe += 1;
  }

  const tile = (k, v, unit, alert) =>
    `<div class="stat${alert ? ' alert' : ''}">
       <span class="k">${k}</span>
       <span class="v">${v}${unit ? `<small>${unit}</small>` : ''}</span>
     </div>`;

  box.innerHTML = [
    tile('启用中的账号', enabled, accountsConfig.length > enabled ? `/ 共 ${accountsConfig.length}` : ''),
    tile('今天已发布', publishedToday, quotaToday ? `/ ${quotaToday}` : ''),
    tile('待发布视频', pending, '条'),
    tile('需要你处理', needsMe, needsMe ? '个账号' : '', needsMe > 0),
  ].join('');
}

function renderAccounts() {
  const list = document.getElementById('accounts-list');
  const empty = document.getElementById('accounts-empty');
  list.innerHTML = '';
  if (accountsConfig.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  const statusByName = new Map(statusData.accounts.map((a) => [a.name, a]));

  accountsConfig.forEach((account, idx) => {
    const runtime = statusByName.get(account.name);
    const card = document.createElement('div');
    card.className = 'account-card';

    const enabled = account.enabled !== false;
    // state = 气泡样式(ok/paused/processing)，edge = 卡片左侧竖条颜色。
    // 分开是因为竖条要能区分"正常等着(绿)"和"正在处理(蓝)"，而气泡只有三种配色。
    let stateHtml = '';
    let edge = 'idle';
    // "已停用""尚未扫描"用中性色：它们不是出问题，标成红色只会白白抢走注意力
    if (!enabled) {
      stateHtml = `<span class="state off">已停用</span>`;
    } else if (!runtime) {
      stateHtml = `<span class="state off">尚未扫描</span>`;
    } else if (runtime.processing) {
      stateHtml = `<span class="state processing">正在处理…</span>`;
      edge = 'busy';
    } else if (runtime.paused) {
      stateHtml = `<span class="state paused">已暂停</span>`;
      edge = 'bad';
    } else if (runtime.retryAt && runtime.retryAt > Date.now()) {
      stateHtml = `<span class="state processing">出错重试中，${fmtRemaining(runtime.retryAt - Date.now())}</span>`;
      edge = 'warn';
    } else if (runtime.quotaExhausted) {
      const tz = runtime.timezone || 'Asia/Jakarta';
      stateHtml = `<span class="state paused">今日额度用完(${runtime.publishedToday}/${runtime.dailyLimit})，等 ${escapeHtml(tz)} 的明天</span>`;
      edge = 'idle';
    } else if (runtime.inPostingWindow === false) {
      const wait = runtime.nextWindowStart ? fmtRemaining(runtime.nextWindowStart - Date.now()) : '';
      stateHtml = `<span class="state paused">不在允许发布的时间段内，还要等${wait ? ' ' + wait : ''}</span>`;
      edge = 'idle';
    } else if (runtime.total === 0) {
      stateHtml = `<span class="state paused">还没检测到视频，点"立即扫描"看看</span>`;
      edge = 'warn';
    } else if (runtime.remaining === 0) {
      stateHtml = `<span class="state ok">队列已跑完，等待新视频</span>`;
      edge = 'ok';
    } else {
      stateHtml = `<span class="state ok">${fmtRemaining(runtime.nextTime - Date.now())}后发下一条</span>`;
      edge = 'ok';
    }
    card.dataset.state = edge;

    // 还没扫描过的账号没有进度可言，那一格整个不显示，别摆一个"已发 -"在那
    const progressHtml = runtime
      ? `<span class="progress">已发 ${runtime.doneIndex + 1 < 0 ? 0 : runtime.doneIndex + 1}/${runtime.total}</span>`
      : '';
    const quotaBadge =
      runtime && runtime.dailyLimit
        ? `<span class="tag" title="今日已发/每日上限">今日 ${runtime.publishedToday}/${runtime.dailyLimit}</span>`
        : '';

    const actions = [];
    if (enabled && runtime && runtime.paused && runtime.pauseCode === 'uncertain_publish') {
      actions.push(`<button data-action="resolve-published" data-name="${escapeAttr(account.name)}">确认已发布</button>`);
      actions.push(`<button data-action="resolve-retry" data-name="${escapeAttr(account.name)}">确认未发布，重试</button>`);
    } else if (enabled && runtime) {
      if (runtime.paused) {
        actions.push(`<button data-action="resume" data-name="${escapeAttr(account.name)}">继续</button>`);
      } else {
        actions.push(`<button data-action="pause" data-name="${escapeAttr(account.name)}">暂停</button>`);
      }
    }
    if (enabled) actions.push(`<button data-action="scan" data-name="${escapeAttr(account.name)}">立即扫描</button>`);
    actions.push(`<button data-action="edit" data-idx="${idx}">编辑</button>`);

    // 三层结构：账号名+状态一行(最显眼) / 路径进度这些细节一行(弱化) / 操作按钮一行
    card.innerHTML = `
      <div class="ac-head">
        <span class="name">${escapeHtml(account.name)}</span>
        <span class="tag">${{ adspower: 'AdsPower', hubstudio: 'Hubstudio', bitbrowser: 'BitBrowser' }[account.browser] || account.browser}</span>
        <span class="spacer"></span>
        ${stateHtml}
      </div>
      <div class="ac-meta">
        ${progressHtml}
        ${quotaBadge}
        ${progressHtml || quotaBadge ? '<span class="sep">·</span>' : ''}
        <span class="folder" title="${escapeAttr(account.videoFolder)}">${escapeHtml(account.videoFolder)}</span>
      </div>
      <div class="actions">${actions.join('')}</div>
      ${runtime && runtime.paused && runtime.pauseReason ? `<div class="reason">${escapeHtml(runtime.pauseReason)}</div>` : ''}
      ${runtime && !runtime.paused && runtime.retryAt && runtime.retryAt > Date.now() && runtime.lastError
        ? `<div class="reason" style="color:var(--amber);background:var(--amber-bg);border-color:color-mix(in srgb, var(--amber) 20%, transparent);">上次失败（已自动重试 ${runtime.consecutiveFailures} 次）：${escapeHtml(runtime.lastError)}</div>`
        : ''}
    `;
    list.appendChild(card);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

document.getElementById('accounts-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  try {
    if (action === 'edit') {
      openAccountModal(Number(btn.dataset.idx));
      return;
    }
    const name = btn.dataset.name;
    if (action === 'scan') {
      btn.disabled = true;
      btn.textContent = '扫描中…';
      try {
        const result = await api('POST', `/api/accounts/${encodeURIComponent(name)}/scan`);
        if (result.deferred) {
          alert('这个账号正等待上一条的发布结果确认，暂时不能扫描文件夹。');
        } else {
          alert(`扫描完成：新增 ${result.added ?? 0} 个，移除 ${result.removed ?? 0} 个，队列共 ${result.total ?? 0} 个视频。\n如果这里是0，说明程序没能在填的那个文件夹路径里找到视频文件，回去编辑账号核对一下路径。`);
        }
      } catch (err) {
        alert('扫描失败：' + err.message);
      }
      await refreshStatus();
      return;
    }
    if (action === 'pause') await api('POST', `/api/accounts/${encodeURIComponent(name)}/pause`);
    if (action === 'resume') await api('POST', `/api/accounts/${encodeURIComponent(name)}/resume`);
    if (action === 'resolve-published') await api('POST', `/api/accounts/${encodeURIComponent(name)}/resolve`, { decision: 'published' });
    if (action === 'resolve-retry') await api('POST', `/api/accounts/${encodeURIComponent(name)}/resolve`, { decision: 'retry' });
    await refreshStatus();
  } catch (err) {
    showGlobalError(err.message);
  }
});

// ===================== 账号编辑弹窗 =====================

const modal = document.getElementById('account-modal');
const accountForm = document.getElementById('account-form');

function openAccountModal(idx) {
  document.getElementById('account-form-error').classList.add('hidden');
  const isEdit = idx !== null && idx !== undefined;
  document.getElementById('account-modal-title').textContent = isEdit ? '编辑账号' : '添加账号';
  document.getElementById('a-delete-btn').style.display = isEdit ? 'inline-block' : 'none';

  const account = isEdit ? accountsConfig[idx] : {};
  document.getElementById('a-original-name').value = isEdit ? account.name : '';
  document.getElementById('a-name').value = account.name || '';
  document.getElementById('a-browser').value = account.browser || 'bitbrowser';
  document.getElementById('a-profileid').value = profileIdOf(account);
  document.getElementById('a-folder').value = account.videoFolder || '';
  document.getElementById('a-hashtags').value = (account.hashtagKeywords || ['fyp', 'tiktok', 'tiktokshop']).join(',');

  updateBrowserFields();
  modal.classList.remove('hidden');
}

function closeAccountModal() {
  modal.classList.add('hidden');
}

function profileIdOf(account) {
  if (account.browser === 'hubstudio') return account.containerCode || '';
  if (account.browser === 'bitbrowser') return account.browserId || '';
  return account.profileId || '';
}

const PROFILE_ID_LABELS = {
  adspower: '环境ID（AdsPower环境列表里的ID）',
  hubstudio: '环境ID（containerCode）',
  bitbrowser: '环境ID（比特浏览器窗口环境的id，可以从右边下拉框按名字选）',
};

let bitbrowserProfilesLoaded = false;

function updateBrowserFields() {
  const browser = document.getElementById('a-browser').value;
  document.getElementById('a-profileid-label').textContent = PROFILE_ID_LABELS[browser] || '环境ID';
  const picker = document.getElementById('a-bitbrowser-picker');
  const hint = document.getElementById('a-bitbrowser-hint');
  const isBit = browser === 'bitbrowser';
  picker.style.display = isBit ? 'inline-block' : 'none';
  hint.style.display = isBit ? 'block' : 'none';
  if (isBit && !bitbrowserProfilesLoaded) {
    bitbrowserProfilesLoaded = true;
    loadBitBrowserProfiles();
  }
}

async function loadBitBrowserProfiles() {
  const picker = document.getElementById('a-bitbrowser-picker');
  try {
    const profiles = await api('GET', '/api/bitbrowser/profiles');
    picker.innerHTML =
      '<option value="">从列表选择…</option>' +
      profiles.map((p) => `<option value="${escapeAttr(p.id)}">${escapeHtml(p.name || p.id)}${p.remark ? ' - ' + escapeHtml(p.remark) : ''}</option>`).join('');
  } catch (err) {
    picker.innerHTML = '<option value="">读取失败，手动填ID</option>';
    bitbrowserProfilesLoaded = false; // 允许下次重新尝试
  }
}

document.getElementById('a-bitbrowser-picker').addEventListener('change', (e) => {
  if (e.target.value) document.getElementById('a-profileid').value = e.target.value;
});

document.getElementById('a-browser').addEventListener('change', updateBrowserFields);
document.getElementById('btn-add-account').addEventListener('click', () => openAccountModal(null));
document.getElementById('a-cancel-btn').addEventListener('click', closeAccountModal);

document.getElementById('a-browse-btn').addEventListener('click', async () => {
  try {
    const data = await api('POST', '/api/pick-folder');
    if (data.path) document.getElementById('a-folder').value = data.path;
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('a-delete-btn').addEventListener('click', async () => {
  const originalName = document.getElementById('a-original-name').value;
  if (!confirm(`确定删除账号"${originalName}"吗？（不会删除本地视频文件，只是从列表里移除）`)) return;
  try {
    const next = accountsConfig.filter((a) => a.name !== originalName);
    await putAccounts(next);
    accountsConfig = next;
    closeAccountModal();
    renderAccounts();
  } catch (err) {
    const el = document.getElementById('account-form-error');
    el.textContent = err.message;
    el.classList.remove('hidden');
  }
});

function splitList(value) {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

accountForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const originalName = document.getElementById('a-original-name').value;
  const browser = document.getElementById('a-browser').value;

  // 保留旧配置和账号级额度/时区等字段，升级不覆写用户已有设置。
  const previous = accountsConfig.find((a) => a.name === originalName);
  const account = {
    ...(previous || {}),
    name: document.getElementById('a-name').value.trim(),
    browser,
    videoFolder: document.getElementById('a-folder').value.trim(),
    enabled: previous?.enabled !== false,
    hashtagKeywords: splitList(document.getElementById('a-hashtags').value),
  };
  if (browser === 'adspower') {
    account.profileId = document.getElementById('a-profileid').value.trim();
  } else if (browser === 'hubstudio') {
    account.containerCode = document.getElementById('a-profileid').value.trim();
  } else {
    account.browserId = document.getElementById('a-profileid').value.trim();
  }

  // 保留原有账号的启用状态等未在表单里出现的字段
  const existingIdx = accountsConfig.findIndex((a) => a.name === originalName);
  const next = [...accountsConfig];
  if (existingIdx >= 0) {
    account.enabled = accountsConfig[existingIdx].enabled;
    next[existingIdx] = { ...accountsConfig[existingIdx], ...account };
  } else {
    next.push(account);
  }

  try {
    await putAccounts(next);
    accountsConfig = next;
    closeAccountModal();
    renderAccounts();
    // 保存后马上扫一次文件夹，不用等启动自动发布或等30秒的定时扫描才知道路径填对没对。
    try {
      await api('POST', `/api/accounts/${encodeURIComponent(account.name)}/scan`);
    } catch {
      // 扫描失败不影响保存本身，账号卡片上的状态/日志区会体现出来
    }
    await refreshStatus();
  } catch (err) {
    const el = document.getElementById('account-form-error');
    el.textContent = err.message;
    el.classList.remove('hidden');
  }
});

// ===================== 全局设置 =====================

// 只显示当前选中那个推送渠道需要填的字段，其它藏起来
function updateNotifyFields() {
  const provider = document.getElementById('s-notify-provider').value;
  document.querySelectorAll('.notify-cfg').forEach((el) => {
    el.style.display = el.dataset.provider === provider ? 'grid' : 'none';
  });
}

document.getElementById('s-notify-provider').addEventListener('change', updateNotifyFields);

document.getElementById('btn-test-notify').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = '发送中…';
  try {
    await api('POST', '/api/notifications/test');
    alert('测试通知已发出，去看看收到没有。\n如果没收到，检查一下填的token/地址对不对。');
  } catch (err) {
    alert('发送失败：' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '发送一条测试通知';
  }
});

function fillSettingsForm(settings) {
  document.getElementById('s-min-hours').value = (settings.minIntervalMs / 3600000).toFixed(2);
  document.getElementById('s-max-hours').value = (settings.maxIntervalMs / 3600000).toFixed(2);
  document.getElementById('s-concurrency').value = settings.concurrency || 1;
  document.getElementById('s-scan-seconds').value = Math.round((settings.folderScanIntervalMs || 30000) / 1000);
  document.getElementById('s-delete-after-publish').checked = settings.deleteAfterPublish !== false;
  document.getElementById('s-close-profile').checked = settings.closeProfileAfterCycle !== false;
  document.getElementById('s-daily-limit').value = settings.dailyPublishLimit ?? 0;
  document.getElementById('s-timezone').value = settings.timezone || 'Asia/Jakarta';

  const window = settings.postingWindow || {};
  document.getElementById('s-window-enabled').checked = window.enabled !== false;
  document.getElementById('s-window-start').value = window.startHour ?? 12;
  document.getElementById('s-window-end').value = window.endHour ?? 24;

  const notif = settings.notifications || {};
  document.getElementById('s-notify-enabled').checked = Boolean(notif.enabled);
  document.getElementById('s-notify-provider').value = notif.provider || 'telegram';
  document.getElementById('s-notify-tg-token').value = (notif.telegram || {}).botToken || '';
  document.getElementById('s-notify-tg-chat').value = (notif.telegram || {}).chatId || '';
  document.getElementById('s-notify-wecom-url').value = (notif.wecom || {}).webhookUrl || '';
  document.getElementById('s-notify-bark-url').value = (notif.bark || {}).serverUrl || '';
  document.getElementById('s-notify-webhook-url').value = (notif.webhook || {}).url || '';
  updateNotifyFields();

  const bit = settings.bitbrowser || {};
  document.getElementById('s-bit-baseurl').value = bit.baseUrl || '';

  const ads = settings.adspower || {};
  document.getElementById('s-ads-baseurl').value = ads.baseUrl || '';
  document.getElementById('s-ads-apikey').value = ads.apiKey || '';

  const hub = settings.hubstudio || {};
  document.getElementById('s-hub-baseurl').value = hub.baseUrl || '';
  document.getElementById('s-hub-apikey').value = hub.apiKey || '';
  document.getElementById('s-hub-openpath').value = hub.openPath || '/api/v1/browser/start';
  document.getElementById('s-hub-closepath').value = hub.closePath || '/api/v1/browser/stop';
  document.getElementById('s-hub-idfield').value = hub.requestIdField || 'containerCode';
  document.getElementById('s-hub-portfield').value = hub.responseDebugPortField || 'debuggingPort';
}

document.getElementById('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const settings = { ...currentSettings };
  settings.minIntervalMs = Math.round(Number(document.getElementById('s-min-hours').value) * 3600000);
  settings.maxIntervalMs = Math.round(Number(document.getElementById('s-max-hours').value) * 3600000);
  settings.concurrency = Number(document.getElementById('s-concurrency').value);
  settings.folderScanIntervalMs = Number(document.getElementById('s-scan-seconds').value) * 1000;
  settings.deleteAfterPublish = document.getElementById('s-delete-after-publish').checked;
  settings.closeProfileAfterCycle = document.getElementById('s-close-profile').checked;
  settings.dailyPublishLimit = Number(document.getElementById('s-daily-limit').value) || 0;
  settings.timezone = document.getElementById('s-timezone').value;
  settings.postingWindow = {
    enabled: document.getElementById('s-window-enabled').checked,
    startHour: Number(document.getElementById('s-window-start').value),
    endHour: Number(document.getElementById('s-window-end').value),
  };
  settings.notifications = {
    ...(currentSettings.notifications || {}),
    enabled: document.getElementById('s-notify-enabled').checked,
    provider: document.getElementById('s-notify-provider').value,
    telegram: {
      botToken: document.getElementById('s-notify-tg-token').value.trim(),
      chatId: document.getElementById('s-notify-tg-chat').value.trim(),
    },
    wecom: { webhookUrl: document.getElementById('s-notify-wecom-url').value.trim() },
    bark: { serverUrl: document.getElementById('s-notify-bark-url').value.trim() },
    webhook: { url: document.getElementById('s-notify-webhook-url').value.trim() },
  };
  settings.bitbrowser = {
    baseUrl: document.getElementById('s-bit-baseurl').value.trim(),
  };
  settings.adspower = {
    baseUrl: document.getElementById('s-ads-baseurl').value.trim(),
    apiKey: document.getElementById('s-ads-apikey').value.trim(),
  };
  settings.hubstudio = {
    ...(currentSettings.hubstudio || {}),
    baseUrl: document.getElementById('s-hub-baseurl').value.trim(),
    apiKey: document.getElementById('s-hub-apikey').value.trim(),
    openPath: document.getElementById('s-hub-openpath').value.trim(),
    closePath: document.getElementById('s-hub-closepath').value.trim(),
    requestIdField: document.getElementById('s-hub-idfield').value.trim(),
    responseDebugPortField: document.getElementById('s-hub-portfield').value.trim(),
  };
  try {
    await api('PUT', '/api/settings', settings);
    currentSettings = settings;
    showGlobalError(null);
    alert('已保存');
  } catch (err) {
    showGlobalError(err.message);
  }
});

// ===================== 全局开始/停止 + 状态轮询 =====================

document.getElementById('btn-start').addEventListener('click', async () => {
  try {
    await api('POST', '/api/orchestrator/start');
    await refreshStatus();
  } catch (err) {
    showGlobalError(err.message);
  }
});
document.getElementById('btn-stop').addEventListener('click', async () => {
  try {
    await api('POST', '/api/orchestrator/stop');
    await refreshStatus();
  } catch (err) {
    showGlobalError(err.message);
  }
});

async function refreshStatus() {
  try {
    statusData = await api('GET', '/api/status');
    const badge = document.getElementById('status-badge');
    badge.textContent = statusData.running ? '运行中' : '已停止';
    badge.className = statusData.running ? 'running' : 'stopped';
    document.getElementById('btn-start').disabled = statusData.running;
    document.getElementById('btn-stop').disabled = !statusData.running;
    if (statusData.settingsError) showGlobalError(statusData.settingsError);
    renderStats();
    renderAccounts();
  } catch (err) {
    showGlobalError(err.message);
  }
}

// ===================== 日志 =====================

function appendLog(entry) {
  const panel = document.getElementById('log-panel');
  const line = document.createElement('div');
  const time = new Date(entry.time).toLocaleTimeString();
  line.className = entry.level;
  line.innerHTML = `<span class="t">${time}</span>[${escapeHtml(entry.account)}] ${escapeHtml(entry.message)}`;
  panel.appendChild(line);
  while (panel.childElementCount > 400) panel.removeChild(panel.firstChild);
  panel.scrollTop = panel.scrollHeight;
}

async function initLogs() {
  try {
    const logs = await api('GET', '/api/logs');
    logs.forEach(appendLog);
  } catch (err) {
    // 首次加载失败不阻塞其它功能
  }
  const source = new EventSource('/api/logs/stream');
  source.onmessage = (event) => appendLog(JSON.parse(event.data));
}

// ===================== 初始化 =====================

// 时区下拉：用完整的 IANA 列表，做哪个地区都能选到。
// 必须在 fillSettingsForm 之前填好选项，否则 select.value = 存量值 会静默失败、
// 下拉显示空白，用户一保存就把时区改没了。
const PINNED_TIMEZONES = [
  ['Asia/Jakarta', '印尼西部 WIB（雅加达）'],
  ['Asia/Makassar', '印尼中部 WITA'],
  ['Asia/Jayapura', '印尼东部 WIT'],
  ['Asia/Kuala_Lumpur', '马来西亚（吉隆坡）'],
  ['Asia/Manila', '菲律宾（马尼拉）'],
  ['Asia/Bangkok', '泰国（曼谷）'],
  // 越南要用 Asia/Saigon：Asia/Ho_Chi_Minh 虽然能用，但不在
  // Intl.supportedValuesOf('timeZone') 的返回值里，写它会和下面的完整列表对不上
  ['Asia/Saigon', '越南（胡志明市）'],
  ['Asia/Singapore', '新加坡'],
  ['Asia/Tokyo', '日本（东京）'],
  ['Asia/Shanghai', '中国大陆（北京时间）'],
  ['Europe/London', '英国（伦敦）'],
  ['America/New_York', '美国东部（纽约）'],
  ['America/Los_Angeles', '美国西部（洛杉矶）'],
];

function populateTimezones(currentValue) {
  const sel = document.getElementById('s-timezone');
  if (!sel) return;
  let all = [];
  try {
    all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  } catch {
    all = [];
  }
  const pinnedKeys = PINNED_TIMEZONES.map(([v]) => v);
  const rest = all.filter((z) => !pinnedKeys.includes(z));

  const opt = (v, label) => `<option value="${escapeAttr(v)}">${escapeHtml(label)}</option>`;
  let html =
    '<optgroup label="常用跨境地区">' + PINNED_TIMEZONES.map(([v, l]) => opt(v, `${l} — ${v}`)).join('') + '</optgroup>';
  if (rest.length) html += '<optgroup label="全部时区">' + rest.map((z) => opt(z, z)).join('') + '</optgroup>';
  // 存量值可能是别名(如 Asia/Ho_Chi_Minh)，不在完整列表里；补一个选项进去，
  // 否则赋值会静默落空、下拉变空白。
  if (currentValue && !pinnedKeys.includes(currentValue) && !rest.includes(currentValue)) {
    html += '<optgroup label="当前设置">' + opt(currentValue, currentValue) + '</optgroup>';
  }
  sel.innerHTML = html;
}

async function init() {
  try {
    currentSettings = await api('GET', '/api/settings');
    populateTimezones(currentSettings.timezone || 'Asia/Jakarta');
    fillSettingsForm(currentSettings);
  } catch (err) {
    showGlobalError('读取全局设置失败: ' + err.message);
  }
  try {
    accountsConfig = await api('GET', '/api/accounts');
  } catch (err) {
    showGlobalError('读取账号列表失败: ' + err.message);
  }
  await refreshStatus();
  initLogs();
  setInterval(refreshStatus, 3000);
}

init();
