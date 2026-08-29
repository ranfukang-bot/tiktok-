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

export function resolveText(settings, account) {
  return { ...settings.text, ...(account.textOverrides || {}) };
}

export function resolveHashtags(settings, account) {
  return account.hashtagKeywords || settings.hashtagKeywords;
}
