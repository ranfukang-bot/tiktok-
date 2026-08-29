const EN_PRESET = {
  nextButton: 'Next',
  searchProductPlaceholder: 'Search product',
  publishNowRadioLabel: 'Now',
  productConfirmButtons: ['Next', 'Add', 'Confirm', 'Save'],
  addProductButton: 'Add',
  aiDisclosureLabel: 'AI-generated content',
  showMoreButtons: ['Show more'],
  postButtonTexts: ['Post'],
};

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
    let stateHtml = '';
    if (!enabled) {
      stateHtml = `<span class="state paused">已停用</span>`;
    } else if (!runtime) {
      stateHtml = `<span class="state paused">尚未扫描</span>`;
    } else if (runtime.processing) {
      stateHtml = `<span class="state processing">正在处理…</span>`;
    } else if (runtime.paused) {
      stateHtml = `<span class="state paused">已暂停</span>`;
    } else if (runtime.total === 0) {
      stateHtml = `<span class="state paused">还没检测到视频，点"立即扫描"看看</span>`;
    } else if (runtime.remaining === 0) {
      stateHtml = `<span class="state ok">队列已跑完，等待新视频</span>`;
    } else {
      stateHtml = `<span class="state ok">${fmtRemaining(runtime.nextTime - Date.now())}</span>`;
    }

    const progress = runtime ? `${runtime.doneIndex + 1 < 0 ? 0 : runtime.doneIndex + 1}/${runtime.total}` : '-';

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

    card.innerHTML = `
      <span class="name">${escapeHtml(account.name)}</span>
      <span class="tag">${account.browser === 'adspower' ? 'AdsPower' : 'Hubstudio'}</span>
      <span class="folder" title="${escapeAttr(account.videoFolder)}">${escapeHtml(account.videoFolder)}</span>
      <span class="progress">${progress}</span>
      ${stateHtml}
      <span class="spacer"></span>
      <span class="actions">${actions.join('')}</span>
      ${runtime && runtime.paused && runtime.pauseReason ? `<div class="reason">${escapeHtml(runtime.pauseReason)}</div>` : ''}
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
  document.getElementById('a-browser').value = account.browser || 'adspower';
  document.getElementById('a-profileid').value = account.browser === 'hubstudio' ? account.containerCode || '' : account.profileId || '';
  document.getElementById('a-groupcode').value = account.groupCode || '';
  document.getElementById('a-folder').value = account.videoFolder || '';
  document.getElementById('a-hashtags').value = (account.hashtagKeywords || ['fyp', 'tiktok', 'tiktokshop']).join(',');

  let preset = account.textPreset || (account.textOverrides ? 'custom' : 'id');
  document.getElementById('a-locale').value = preset;
  const t = account.textOverrides || {};
  document.getElementById('a-t-next').value = t.nextButton || '';
  document.getElementById('a-t-now').value = t.publishNowRadioLabel || '';
  document.getElementById('a-t-search').value = t.searchProductPlaceholder || '';
  document.getElementById('a-t-addproduct').value = t.addProductButton || '';
  document.getElementById('a-t-ai').value = t.aiDisclosureLabel || '';
  document.getElementById('a-t-post').value = (t.postButtonTexts || []).join(',');
  document.getElementById('a-t-confirm').value = (t.productConfirmButtons || []).join(',');
  document.getElementById('a-t-more').value = (t.showMoreButtons || []).join(',');

  updateBrowserFields();
  updateLocaleFields();
  modal.classList.remove('hidden');
}

function closeAccountModal() {
  modal.classList.add('hidden');
}

function updateBrowserFields() {
  const browser = document.getElementById('a-browser').value;
  document.getElementById('a-profileid-label').textContent = browser === 'hubstudio' ? '环境ID（containerCode）' : '环境ID（AdsPower环境列表里的ID）';
  document.getElementById('a-groupcode-field').style.display = browser === 'hubstudio' ? 'flex' : 'none';
}

function updateLocaleFields() {
  document.getElementById('a-custom-text').style.display = document.getElementById('a-locale').value === 'custom' ? 'block' : 'none';
}

document.getElementById('a-browser').addEventListener('change', updateBrowserFields);
document.getElementById('a-locale').addEventListener('change', updateLocaleFields);
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
    await api('PUT', '/api/accounts', next);
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
  const locale = document.getElementById('a-locale').value;

  let textOverrides;
  if (locale === 'en') textOverrides = { ...EN_PRESET };
  else if (locale === 'custom') {
    textOverrides = {
      nextButton: document.getElementById('a-t-next').value.trim(),
      publishNowRadioLabel: document.getElementById('a-t-now').value.trim(),
      searchProductPlaceholder: document.getElementById('a-t-search').value.trim(),
      addProductButton: document.getElementById('a-t-addproduct').value.trim(),
      aiDisclosureLabel: document.getElementById('a-t-ai').value.trim(),
      postButtonTexts: splitList(document.getElementById('a-t-post').value),
      productConfirmButtons: splitList(document.getElementById('a-t-confirm').value),
      showMoreButtons: splitList(document.getElementById('a-t-more').value),
    };
  } else {
    textOverrides = undefined;
  }

  const account = {
    name: document.getElementById('a-name').value.trim(),
    browser,
    videoFolder: document.getElementById('a-folder').value.trim(),
    enabled: true,
    hashtagKeywords: splitList(document.getElementById('a-hashtags').value) || undefined,
    textPreset: locale,
    textOverrides,
  };
  if (browser === 'adspower') {
    account.profileId = document.getElementById('a-profileid').value.trim();
  } else {
    account.containerCode = document.getElementById('a-profileid').value.trim();
    const groupCode = document.getElementById('a-groupcode').value.trim();
    if (groupCode) account.groupCode = groupCode;
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
    await api('PUT', '/api/accounts', next);
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

function fillSettingsForm(settings) {
  document.getElementById('s-min-hours').value = (settings.minIntervalMs / 3600000).toFixed(2);
  document.getElementById('s-max-hours').value = (settings.maxIntervalMs / 3600000).toFixed(2);
  document.getElementById('s-concurrency').value = settings.concurrency || 1;
  document.getElementById('s-scan-seconds').value = Math.round((settings.folderScanIntervalMs || 30000) / 1000);

  const ads = settings.adspower || {};
  document.getElementById('s-ads-baseurl').value = ads.baseUrl || '';
  document.getElementById('s-ads-apikey').value = ads.apiKey || '';

  const hub = settings.hubstudio || {};
  document.getElementById('s-hub-baseurl').value = hub.baseUrl || '';
  document.getElementById('s-hub-groupcode').value = hub.groupCode || '';
  document.getElementById('s-hub-openpath').value = hub.openPath || '/api/v1/browser/open';
  document.getElementById('s-hub-closepath').value = hub.closePath || '/api/v1/browser/close';
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
  settings.adspower = {
    baseUrl: document.getElementById('s-ads-baseurl').value.trim(),
    apiKey: document.getElementById('s-ads-apikey').value.trim(),
  };
  settings.hubstudio = {
    ...(currentSettings.hubstudio || {}),
    baseUrl: document.getElementById('s-hub-baseurl').value.trim(),
    groupCode: document.getElementById('s-hub-groupcode').value.trim(),
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

async function init() {
  try {
    currentSettings = await api('GET', '/api/settings');
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
