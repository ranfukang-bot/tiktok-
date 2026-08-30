// 界面文案字段清单：键名 + 中文标签 + "去哪里找这段文字"的提示。
// 提示是给非技术用户看的，让人能对照自己的 TikTok Studio 界面把值抄下来。
// 键名本身跟 src/config.js 的 DEFAULT_PAGE_TEXT 一一对应；预设的【值】由服务端
// /api/text-presets 提供，前端不再自己抄一份，避免第三处真值来源。
const TEXT_FIELDS = [
  { key: 'searchProductPlaceholder', label: '商品搜索框的提示文字', type: 'string',
    hint: '挂商品时那个搜索框里的灰色提示字。填错了搜商品那步会当场失败，所以属于必填。' },
  { key: 'addProductButton', label: '"添加商品"按钮', type: 'string',
    hint: '编辑页"商品"那一栏里，用来添加商品的按钮上的字。' },
  { key: 'nextButton', label: '"下一步"按钮', type: 'string',
    hint: '挂商品的弹窗里，进入下一步的按钮上的字。' },
  { key: 'publishNowRadioLabel', label: '"立即发布"选项', type: 'string',
    hint: '发布时间那里，"现在发"这个选项旁边的字（另一个通常是"定时发布"）。' },
  { key: 'aiDisclosureLabel', label: 'AI声明开关', type: 'string',
    hint: '展开"更多设置"后，AI生成内容那个开关旁边的说明文字。' },
  { key: 'productConfirmButtons', label: '商品弹窗的确认按钮', type: 'list',
    hint: '商品弹窗里"确认/添加/保存"这类按钮。按优先级从前往后写，先匹配上的先点。' },
  { key: 'showMoreButtons', label: '"展开更多"按钮', type: 'list',
    hint: '编辑页底部展开高级设置那个按钮上的字。' },
  { key: 'postButtonTexts', label: '最终发布按钮', type: 'list',
    hint: '右下角真正发布那个按钮上的字。' },
  { key: 'productModalMarkers', label: '商品弹窗里必然出现的字', type: 'list',
    hint: '用来判断商品弹窗是不是还开着——开着就绝不能去点发布，否则会隔着弹窗误点到后面的页面。' +
          '填弹窗标题这类每次都会出现的词。跟上面的搜索框提示文字两项都空的话，这道闸门就等于没有，' +
          '所以属于必填。' },
  { key: 'violationMarkers', label: '版权/违规提示', type: 'list',
    hint: '视频被判定有版权或违规问题时，页面上会出现的提示。这项只在真出问题时才触发，' +
          '平时跑一百遍也验证不出配得对不对，所以必须认真填——填不上就等于这道保护没开。' },
  { key: 'checksPassedMarkers', label: '"检查通过"提示', type: 'list',
    hint: '版权检查完成且没问题时的提示。不填的话每条都要多等满45秒，不影响安全。' },
  { key: 'appCrashMarkers', label: '页面崩溃错误页上的字', type: 'list', all: true,
    hint: '⚠️ 这一项是"全部都要出现才算崩溃"，跟其它项不一样。TikTok自己崩溃时会显示一个' +
          '错误页，把上面的标题和按钮文字都填上（比如"出错了"+"重试"）。不填只会导致崩溃时' +
          '干等到超时，不会误判。' },
  { key: 'prematureCheckMarkers', label: '"检查未完成仍要发布"确认框', type: 'list',
    hint: '版权检查还没跑完就点了发布时，弹出来的那个确认框里的字。不填会退化成靠弹窗数量判断，' +
          '偏向于多报，是安全方向。' },
  { key: 'uploadDoneMarkers', label: '上传完成提示（可留空）', type: 'list',
    hint: '印尼语和英语已经内置在代码里了，这两种语言可以留空。其它语言填"已上传/上传完成"这类词。' },
  { key: 'uploadingMarkers', label: '上传中提示（可留空）', type: 'list',
    hint: '同上，印尼语英语已内置。填的话要填只在上传过程中出现的词（比如带倒计时的那种），' +
          '如果填了个在别处也会出现的词，会让程序以为一直在上传。' },
];

let accountsConfig = [];
let currentSettings = null;
let statusData = { running: false, accounts: [] };
let textPresets = null; // 由 /api/text-presets 提供
let safetyTextKeys = [];
let requiredTextKeys = [];

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
    } else if (runtime.retryAt && runtime.retryAt > Date.now()) {
      stateHtml = `<span class="state processing">出错重试中，${fmtRemaining(runtime.retryAt - Date.now())}</span>`;
    } else if (runtime.quotaExhausted) {
      const tz = runtime.timezone || 'Asia/Jakarta';
      stateHtml = `<span class="state paused">今日额度用完(${runtime.publishedToday}/${runtime.dailyLimit})，等 ${escapeHtml(tz)} 的明天</span>`;
    } else if (runtime.total === 0) {
      stateHtml = `<span class="state paused">还没检测到视频，点"立即扫描"看看</span>`;
    } else if (runtime.remaining === 0) {
      stateHtml = `<span class="state ok">队列已跑完，等待新视频</span>`;
    } else {
      stateHtml = `<span class="state ok">${fmtRemaining(runtime.nextTime - Date.now())}</span>`;
    }

    const progress = runtime ? `${runtime.doneIndex + 1 < 0 ? 0 : runtime.doneIndex + 1}/${runtime.total}` : '-';
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

    card.innerHTML = `
      <span class="name">${escapeHtml(account.name)}</span>
      <span class="tag">${{ adspower: 'AdsPower', hubstudio: 'Hubstudio', bitbrowser: 'BitBrowser' }[account.browser] || account.browser}</span>
      <span class="folder" title="${escapeAttr(account.videoFolder)}">${escapeHtml(account.videoFolder)}</span>
      <span class="progress">${progress}</span>
      ${quotaBadge}
      ${stateHtml}
      <span class="spacer"></span>
      <span class="actions">${actions.join('')}</span>
      ${runtime && runtime.paused && runtime.pauseReason ? `<div class="reason">${escapeHtml(runtime.pauseReason)}</div>` : ''}
      ${runtime && !runtime.paused && runtime.retryAt && runtime.retryAt > Date.now() && runtime.lastError
        ? `<div class="reason" style="color:var(--amber);">上次失败（已自动重试 ${runtime.consecutiveFailures} 次）：${escapeHtml(runtime.lastError)}</div>`
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

  // 用【合并后实际生效的值】回填，而不是只回填 account.textOverrides。
  // 这一点很关键：印尼语账号的 textOverrides 本来就是空的，如果按空值回填，
  // 用户只是进来改一下文件夹路径再保存，就会把一堆空字符串写成 textOverrides，
  // 而空字符串会让 findClickableByText('') 匹配到页面上任意一个空元素并点下去。
  document.getElementById('a-preset-pick').value = presetIdOf(account);
  updatePresetHint();
  fillTextFields(effectiveTextFor(account));

  updateBrowserFields();
  modal.classList.remove('hidden');
}

// 跟服务端 src/config.js 的 mergeText 保持同样的语义：空字符串/空数组一律当"没填"，
// 继续继承下一层。数据(默认值)来自服务端，这里只是同一套合并规则的前端镜像。
function isBlankValue(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return !v.trim();
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim()).length === 0;
  return false;
}

// 这个账号声明的是哪种界面语言。没写就跟全局一致（老账号没有这个字段，
// 必须让它继续走原来那条印尼语的路）。
function presetIdOf(account) {
  const id = account && typeof account.textPreset === 'string' ? account.textPreset.trim() : '';
  return id || globalPresetId();
}

function globalPresetId() {
  return (textPresets && textPresets.globalPreset) || 'id';
}

// 服务端 src/config.js 的 resolveText 的前端镜像，规则必须一模一样，
// 否则网页上显示的"实际生效值"跟真正跑的时候不是一回事。
// 核心是：账号语言跟全局语言不一样时，【不继承】全局那套文案——
// 那是另一种语言的字，继承过来看着像配好了，实际永远匹配不上。
function effectiveTextFor(account) {
  const accountId = presetIdOf(account);
  const preset = (textPresets && textPresets.presets[accountId]) || null;
  const base = preset ? preset.text : {}; // 认不出的预设名不拿印尼语兜底
  const layers =
    accountId === globalPresetId()
      ? [base, (textPresets && textPresets.globalText) || {}, (account && account.textOverrides) || {}]
      : [base, (account && account.textOverrides) || {}];
  const out = {};
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer)) {
      if (k.startsWith('_') || isBlankValue(v)) continue;
      out[k] = v;
    }
  }
  return out;
}

// 按 TEXT_FIELDS 动态生成输入框，HTML 里不再硬编码键名
function renderTextFields() {
  const box = document.getElementById('a-text-fields');
  if (!box || box.dataset.rendered) return;
  box.dataset.rendered = '1';
  box.innerHTML = TEXT_FIELDS.map((f) => {
    // 两种徽标要分开：安全项配错了平时完全看不出来(保护静默关掉)，
    // 其它必填项缺了会当场卡住报错，危险程度不是一回事。
    const badge = safetyTextKeys.includes(f.key)
      ? '<span class="tag" style="background:#fdecea;color:var(--red);">必填 · 安全</span> '
      : requiredTextKeys.includes(f.key)
        ? '<span class="tag" style="background:#fdecea;color:var(--red);">必填</span> '
        : '';
    const multi = f.type === 'list' ? '（多个用逗号分隔）' : '';
    return `
      <div class="field span2">
        <label>${badge}${escapeHtml(f.label)}${multi}</label>
        <input type="text" id="a-t-${f.key}" data-text-key="${f.key}">
        <div class="hint">${escapeHtml(f.hint)}</div>
      </div>`;
  }).join('');
}

function fillTextFields(text) {
  renderTextFields();
  for (const f of TEXT_FIELDS) {
    const el = document.getElementById(`a-t-${f.key}`);
    if (!el) continue;
    const v = text[f.key];
    el.value = Array.isArray(v) ? v.join(',') : v || '';
  }
}

// 只把"跟当前生效值不同"的项写进 textOverrides；空白项直接不写(表示继承)。
// 这样进来改个文件夹再保存，不会顺手把文案配置写死一份到这个账号上。
function collectTextOverrides(account) {
  // base 必须按【当前选中的预设】算，而不是按账号原来的预设算。用户刚把预设从
  // 印尼语切成英语时，继承来的底值已经变了，用旧底值比对会把该存的项当成
  // "跟继承的一样"给丢掉。
  const base = effectiveTextFor({ textPreset: account.textPreset });
  const overrides = {};
  for (const f of TEXT_FIELDS) {
    const el = document.getElementById(`a-t-${f.key}`);
    if (!el) continue;
    const raw = el.value;
    const value = f.type === 'list' ? splitList(raw) : raw.trim();
    if (isBlankValue(value)) continue; // 留空 = 继承，绝不写成空值覆盖
    if (JSON.stringify(value) === JSON.stringify(base[f.key])) continue; // 跟继承来的一样就不用存
    overrides[f.key] = value;
  }
  return Object.keys(overrides).length ? overrides : undefined;
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

// 选哪套预设，决定的不只是"往输入框里填什么"，还决定这个账号【继承谁】：
// 跟全局语言一致时才继承全局那套文案，不一致时只继承预设本身。所以换预设必须
// 连带把输入框重填一遍，否则框里显示的还是上一种语言的继承值，跟实际生效的对不上。
function currentPresetKey() {
  return document.getElementById('a-preset-pick').value;
}

function missingRequiredIn(text) {
  return requiredTextKeys.filter((k) => isBlankValue(text[k]));
}

function labelsFor(keys) {
  return keys.map((k) => (TEXT_FIELDS.find((f) => f.key === k) || {}).label || k);
}

function updatePresetHint() {
  const key = currentPresetKey();
  const preset = textPresets && textPresets.presets[key];
  const hintEl = document.getElementById('a-preset-hint');
  if (!preset) {
    hintEl.textContent = '';
    return;
  }
  const missing = missingRequiredIn(effectiveTextFor({ textPreset: key }));
  if (!missing.length) {
    hintEl.textContent = `「${preset.label}」是完整的，可以直接用，也可以按自己界面微调。`;
    return;
  }
  hintEl.innerHTML =
    `<b style="color:var(--red);">「${escapeHtml(preset.label)}」里 ${escapeHtml(labelsFor(missing).join('、'))} 这几项没有内置值</b>，` +
    '因为我们没有验证过这个语言的真实界面。编一个翻译给你反而更危险——会让你以为版权检测这类保护开着，' +
    '其实它永远匹配不上、每条视频都会被当成"检测通过"。请打开这个账号的 TikTok Studio 对照着填。';
}

function applyPreset() {
  fillTextFields(effectiveTextFor({ textPreset: currentPresetKey() }));
  updatePresetHint();
}

document.getElementById('a-preset-pick').addEventListener('change', applyPreset);
document.getElementById('a-preset-load').addEventListener('click', applyPreset);

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

  const account = {
    name: document.getElementById('a-name').value.trim(),
    browser,
    videoFolder: document.getElementById('a-folder').value.trim(),
    enabled: true,
    textPreset: currentPresetKey(),
    hashtagKeywords: splitList(document.getElementById('a-hashtags').value) || undefined,
  };
  account.textOverrides = collectTextOverrides(account);

  // 提交前先自查必填文案，把问题直接指到具体字段上，比等服务端返回一句话好懂。
  // 服务端还会再查一遍(这里能被绕过)，两边用的是同一份 requiredKeys。
  const effective = effectiveTextFor(account);
  const missing = missingRequiredIn(effective);
  if (missing.length) {
    const hasSafety = missing.some((k) => safetyTextKeys.includes(k));
    const el = document.getElementById('account-form-error');
    el.innerHTML =
      `还差这几项界面文案没填：<b>${escapeHtml(labelsFor(missing).join('、'))}</b>。` +
      (hasSafety
        ? '其中有关系到"这条视频有没有被判违规""商品弹窗是不是还开着"这类安全判断的项，缺了不会报错、但保护是关的，所以不能保存。'
        : '缺了这些跑到一半会卡住报错，所以不能保存。') +
      '请打开这个账号的 TikTok Studio 对照界面填上。';
    el.classList.remove('hidden');
    return;
  }

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
  document.getElementById('s-daily-limit').value = settings.dailyPublishLimit ?? 0;
  document.getElementById('s-timezone').value = settings.timezone || 'Asia/Jakarta';

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
  settings.dailyPublishLimit = Number(document.getElementById('s-daily-limit').value) || 0;
  settings.timezone = document.getElementById('s-timezone').value;
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
  // 预设要在打开账号弹窗之前就位——回填生效值和"载入预设"都依赖它
  try {
    textPresets = await api('GET', '/api/text-presets');
    safetyTextKeys = textPresets.safetyCriticalKeys || [];
    requiredTextKeys = textPresets.requiredKeys || [];
    document.getElementById('a-preset-pick').innerHTML = Object.entries(textPresets.presets)
      .map(([k, p]) => `<option value="${escapeAttr(k)}">${escapeHtml(p.label)}</option>`)
      .join('');
  } catch (err) {
    showGlobalError('读取界面文案预设失败: ' + err.message);
  }
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
