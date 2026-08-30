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

// TikTok Studio 界面文案的唯一真值来源。
//
// 为什么必须有这一层：ensureConfigFiles() 只在 settings.json 不存在时才从示例文件
// 复制，已经跑过控制台的机器上那个文件是"创建时的形状"，往 settings.example.json
// 加新键根本同步不过去，运行时会读到 undefined 把现有配置弄坏。
//
// 值全部是印尼语——它是从真实界面扒下来、唯一经过验证的一套。
// 注意：uploadDoneMarkers / uploadingMarkers / prematureCheckMarkers 默认是空数组，
// 因为这三处在 injected.js 里保留了带数字/括号锚点的原正则(印尼语+英语)，
// 配置项是叠加上去给其它语言用的，留空才能保证印尼语路径跟改动前完全一致。
export const DEFAULT_PAGE_TEXT = {
  // —— 元素定位用的单条文字（必填，留空会导致匹配到任意元素）——
  nextButton: 'Berikutnya',
  searchProductPlaceholder: 'Cari produk',
  publishNowRadioLabel: 'Sekarang',
  addProductButton: 'Tambah',
  aiDisclosureLabel: 'Konten yang dihasilkan AI',
  // —— 按优先级排序的候选列表，第一个匹配上的胜出 ——
  productConfirmButtons: ['Berikutnya', 'Tambah', 'Tambahkan', 'Konfirmasi', 'Simpan'],
  showMoreButtons: ['Tampilkan lebih banyak', 'Tampilkan lainnya'],
  postButtonTexts: ['Posting', 'Post'],
  // —— 页面状态识别用的关键词（任一命中即可，除 appCrashMarkers 外）——
  productModalMarkers: ['Tambah tautan', 'Nama produk'],
  appCrashMarkers: ['Ada masalah', 'Coba lagi'], // 全部命中才算崩溃
  violationMarkers: ['Masalah hak cipta ditemukan', 'Pelanggaran terdeteksi', 'Video tidak dapat diposting'],
  checksPassedMarkers: ['Tidak ada masalah yang ditemukan', 'Tidak ditemukan masalah', 'Pemeriksaan selesai'],
  uploadDoneMarkers: [],
  uploadingMarkers: [],
  prematureCheckMarkers: ['Pemeriksaan'],
};

// 除印尼语之外的内置预设。
//
// 原则：【只放验证过的值，绝不编造没见过的界面的翻译】。
// 一个编错的 violationMarkers 比一个空的危险得多——空的会被拦下来逼你去填，
// 编错的会让你以为版权保护开着，其实它永远匹配不上、每条视频都"检测通过"。
// 所以英语预设里凡是没在真实界面上见过的安全项，一律留空。
const EN_PRESET_TEXT = {
  nextButton: 'Next',
  searchProductPlaceholder: 'Search products',
  publishNowRadioLabel: 'Now',
  addProductButton: 'Add',
  aiDisclosureLabel: 'AI-generated content',
  productConfirmButtons: ['Next', 'Add', 'Confirm', 'Save'],
  showMoreButtons: ['Show more'],
  postButtonTexts: ['Post'],
  appCrashMarkers: ['Something went wrong', 'Try again'],
  prematureCheckMarkers: ['Check'],
  // 下面两项是安全项，没见过真实英文界面，故意留空，由用户对照自己界面补：
  productModalMarkers: [],
  violationMarkers: [],
  // 非安全项，留空只是退化成等超时：
  checksPassedMarkers: [],
  uploadDoneMarkers: [],
  uploadingMarkers: [],
};

export const DEFAULT_TEXT_PRESET = 'id';

export const TEXT_PRESETS = {
  id: { label: '印尼语 Bahasa Indonesia（已验证）', verified: true, text: DEFAULT_PAGE_TEXT },
  en: { label: '英语 English（部分验证，安全项需自己补）', verified: false, text: EN_PRESET_TEXT },
  custom: {
    label: '其它语言（全部自己填）',
    verified: false,
    text: {}, // 故意是空的：选了它就什么都不继承，必须照着自己的界面从头填
  },
};

// 缺了会出事的文案键。分两类，报错时措辞不一样：
//
// safety = "配错/没配平时完全看不出来，但保护是关着的"。跑一百条正常视频都暴露不了，
//          直到某条真违规了才发现它被发出去了。这类必须当场拦住。
// 其余    = 缺了流程会直接卡住报错（requiredText 抛错，或候选列表为空导致等超时）。
//          虽然不会静默出事，但存一个注定跑不起来的账号没有意义，同样拦住。
export const SAFETY_CRITICAL_TEXT_KEYS = ['violationMarkers', 'productModalMarkers', 'searchProductPlaceholder'];

export const REQUIRED_TEXT_KEYS = [
  'nextButton',
  'searchProductPlaceholder',
  'publishNowRadioLabel',
  'addProductButton',
  'aiDisclosureLabel',
  'productConfirmButtons',
  'showMoreButtons',
  'productModalMarkers',
  'violationMarkers',
];

// 报错里给人看的中文名，比直接吐 violationMarkers 这种键名友好。
// 网页上那份带"去哪找这段字"的详细提示在 public/app.js 的 TEXT_FIELDS 里。
export const TEXT_KEY_LABELS = {
  nextButton: '"下一步"按钮',
  searchProductPlaceholder: '商品搜索框的提示文字',
  publishNowRadioLabel: '"立即发布"选项',
  addProductButton: '"添加商品"按钮',
  aiDisclosureLabel: 'AI声明开关',
  productConfirmButtons: '商品弹窗的确认按钮',
  showMoreButtons: '"展开更多"按钮',
  postButtonTexts: '最终发布按钮',
  productModalMarkers: '商品弹窗里必然出现的字',
  violationMarkers: '版权/违规提示',
  checksPassedMarkers: '"检查通过"提示',
  appCrashMarkers: '页面崩溃错误页上的字',
  prematureCheckMarkers: '"检查未完成仍要发布"确认框',
  uploadDoneMarkers: '上传完成提示',
  uploadingMarkers: '上传中提示',
};

export function textKeyLabel(key) {
  return TEXT_KEY_LABELS[key] || key;
}

// 空字符串/空数组一律当作"没填"，让它继续继承下一层的值。
// 不这么做的话，网页表单里一个没填的输入框会以 '' 的形式覆盖掉默认值，
// 而 '' 在 includes('') 里恒为真、findClickableByText('') 会点到随便一个空元素。
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

// 这个账号/这份全局设置声明的是哪种界面语言。没写就是印尼语——老配置里没有这个
// 字段，必须让它继续走原来那条路，否则现有账号一升级就全废了。
export function textPresetIdOf(obj) {
  const id = obj && typeof obj.textPreset === 'string' ? obj.textPreset.trim() : '';
  return id || DEFAULT_TEXT_PRESET;
}

function presetText(id) {
  const preset = TEXT_PRESETS[id];
  // 认不出来的预设名（手改过配置文件之类）不能拿印尼语来兜底——那正是"静默塞进
  // 一套别的语言的文字"。返回空对象，让下面的必填校验把它拦住。
  return preset ? preset.text : {};
}

/**
 * 合并出这个账号最终生效的界面文案。
 *
 * 关键点是【不同语言之间不互相兜底】：
 *   账号语言 == 全局语言  → 预设 + 全局 settings.text + 账号 textOverrides
 *   账号语言 != 全局语言  → 预设 + 账号 textOverrides（跳过 settings.text）
 *
 * 为什么必须跳过：settings.text 是印尼语的。如果一个英文账号能从它那里继承到
 * violationMarkers，那它就会拿着印尼语的"版权有问题"去英文界面上找，永远匹配不上，
 * 于是每条视频都"检测通过"——保护静默失效，而且校验还会显示一切正常。
 * 这正是这一层要防的事情，也是"必填校验"能真正生效的前提。
 */
export function resolveText(settings, account) {
  const globalId = textPresetIdOf(settings);
  const accountId = textPresetIdOf(account);
  const layers =
    accountId === globalId
      ? [presetText(accountId), settings && settings.text, account && account.textOverrides]
      : [presetText(accountId), account && account.textOverrides];
  return mergeText(...layers);
}

// 检查这个账号最终生效的文案里，必填项是否齐全。返回缺失的键名数组(空数组=没问题)。
// 服务端保存校验和运行前自检都用这一个函数，保证两处判断标准一致。
export function findMissingRequiredText(settings, account) {
  const text = resolveText(settings, account);
  return REQUIRED_TEXT_KEYS.filter((k) => isBlank(text[k]));
}

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
