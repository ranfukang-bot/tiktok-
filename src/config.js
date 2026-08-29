import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(__dirname, '..', 'config');

function loadJson(name) {
  const real = path.join(CONFIG_DIR, `${name}.json`);
  const example = path.join(CONFIG_DIR, `${name}.example.json`);
  const target = existsSync(real) ? real : example;
  if (!existsSync(target)) {
    throw new Error(`找不到配置文件 ${name}.json（也没有 ${name}.example.json 可以兜底）`);
  }
  if (target === example) {
    console.warn(`⚠️ 未找到 config/${name}.json，暂时用 ${name}.example.json 里的占位值运行，请尽快复制一份出来改成你自己的配置。`);
  }
  return JSON.parse(readFileSync(target, 'utf-8'));
}

export function loadSettings() {
  const settings = loadJson('settings');
  if (!settings.minIntervalMs || !settings.maxIntervalMs) {
    throw new Error('settings.json 里必须配置 minIntervalMs / maxIntervalMs');
  }
  return settings;
}

export function loadAccounts() {
  const accounts = loadJson('accounts');
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('accounts.json 必须是非空数组');
  }
  return accounts.filter((a) => a.enabled !== false);
}

export function resolveText(settings, account) {
  return { ...settings.text, ...(account.textOverrides || {}) };
}

export function resolveHashtags(settings, account) {
  return account.hashtagKeywords || settings.hashtagKeywords;
}
