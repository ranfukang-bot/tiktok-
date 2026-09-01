import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(__dirname, '..', 'config');
const SETTINGS_PATH = path.join(CONFIG_DIR, 'settings.json');
const ACCOUNTS_PATH = path.join(CONFIG_DIR, 'accounts.json');

// 网页控制台第一次启动时自动把默认设置落地成真实配置文件；账号列表从空数组开始，
// 不拿 accounts.example.json 里的占位账号来充数，避免非技术用户误以为已经配置好了。
export function ensureConfigFiles() {
  if (!existsSync(SETTINGS_PATH)) {
    copyFileSync(path.join(CONFIG_DIR, 'settings.example.json'), SETTINGS_PATH);
  }
  if (!existsSync(ACCOUNTS_PATH)) {
    writeFileSync(ACCOUNTS_PATH, '[]\n');
  }
}

function readJsonFile(file) {
  return JSON.parse(readFileSync(file, 'utf-8'));
}

export function loadSettings() {
  if (!existsSync(SETTINGS_PATH)) {
    throw new Error('找不到 config/settings.json，请先运行一次控制台或手动复制 settings.example.json');
  }
  const settings = readJsonFile(SETTINGS_PATH);
  if (!settings.minIntervalMs || !settings.maxIntervalMs) {
    throw new Error('settings.json 里必须配置 minIntervalMs / maxIntervalMs');
  }
  return settings;
}

export function saveSettings(settings) {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// 返回全部账号（包括被禁用的），供网页控制台展示/编辑用。
export function loadAllAccounts() {
  if (!existsSync(ACCOUNTS_PATH)) return [];
  const accounts = readJsonFile(ACCOUNTS_PATH);
  if (!Array.isArray(accounts)) throw new Error('accounts.json 必须是一个数组');
  return accounts;
}

export function saveAccounts(accounts) {
  if (!Array.isArray(accounts)) throw new Error('accounts 必须是数组');
  writeFileSync(ACCOUNTS_PATH, JSON.stringify(accounts, null, 2));
}

// 只返回启用中的账号，供调度器使用。
export function loadAccounts() {
  return loadAllAccounts().filter((a) => a.enabled !== false);
}

// 旧文案字段仍可读取，不再控制定位或发布安全。仅错误页诊断保留可选文字提示。
export const DEFAULT_PAGE_TEXT = { appCrashMarkers: ['Ada masalah', 'Coba lagi'] };
export const DEFAULT_TEXT_PRESET = 'id';
export const TEXT_PRESETS = {
  id: { label: '印尼语（旧版可选诊断）', text: DEFAULT_PAGE_TEXT },
  en: { label: '英语（旧版可选诊断）', text: { appCrashMarkers: ['Something went wrong', 'Try again'] } },
  custom: { label: '其它语言（无需填写）', text: {} },
};
// 保留兼容旧控制台API，所有语言的文案必填列表均为空。
export const REQUIRED_TEXT_KEYS = [];
export const SAFETY_CRITICAL_TEXT_KEYS = [];
export function textKeyLabel(key) { return key; }

// 旧配置合并时忽略空值及文档键。
function isBlank(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return !v.trim();
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim()).length === 0;
  return false;
}

function mergeText(...layers) {
  const out = {};
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    for (const [k, v] of Object.entries(layer)) {
      if (k.startsWith('_')) continue; // 跳过 _说明 这类文档键
      if (isBlank(v)) continue;
      out[k] = v;
    }
  }
  return out;
}

// 缺省预设仅影响可选错误页诊断，不影响通用DOM流程。
export function textPresetIdOf(obj) {
  const id = obj && typeof obj.textPreset === 'string' ? obj.textPreset.trim() : '';
  return id || DEFAULT_TEXT_PRESET;
}

function presetText(id) {
  const preset = TEXT_PRESETS[id];
  return preset ? preset.text : {};
}

// 保持旧配置的同语言继承规则，不修改账号文件，也不串入其它语言的诊断词。
export function resolveText(settings, account) {
  const globalId = textPresetIdOf(settings);
  const accountId = textPresetIdOf(account);
  const layers =
    accountId === globalId
      ? [presetText(accountId), settings && settings.text, account && account.textOverrides]
      : [presetText(accountId), account && account.textOverrides];
  return mergeText(...layers);
}

// 兼容原API调用方：不再要求任何界面翻译。
export function findMissingRequiredText() { return []; }

export function resolveHashtags(settings, account) {
  return account.hashtagKeywords || settings.hashtagKeywords;
}

// 账号自己可以覆盖每日额度/时区(accounts.json里手动加字段)，不填就用全局设置；
// 0/负数/非数字都当"不限"处理。网页目前只暴露全局设置，账号级覆盖是留给以后
// 需要"这几个账号跟其他的不一样"时用的，不用改代码。
export function resolveDailyLimit(settings, account) {
  const raw = account.dailyPublishLimit ?? settings.dailyPublishLimit;
  return Number.isFinite(raw) && raw > 0 ? raw : Infinity;
}

export function resolveTimezone(settings, account) {
  return account.timezone || settings.timezone || 'Asia/Jakarta';
}

// 允许发布的时间段(按小时,账号自己的时区)。默认中午12点到午夜0点(=24点)，
// 避免额度一到凌晨0点刷新就立刻发，堆积视频时会变成"凌晨连发4条"这种不像真人的节奏。
// 只做全局设置，没做成账号级覆盖：时段本身(几点到几点)跟地区无关，地区差异已经
// 由 resolveTimezone 处理了——同样的"中午到午夜"，套到账号自己的时区上就是当地时间。
export function resolvePostingWindow(settings) {
  const w = settings.postingWindow || {};
  const startHour = Number.isFinite(w.startHour) ? w.startHour : 12;
  const endHour = Number.isFinite(w.endHour) ? w.endHour : 24;
  return { enabled: w.enabled !== false, startHour, endHour };
}
