import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', 'state');

function slug(accountName) {
  return accountName.replace(/[^a-zA-Z0-9_\-一-龥]/g, '_');
}

function statePath(accountName) {
  return path.join(STATE_DIR, `${slug(accountName)}.json`);
}

function defaultState() {
  return {
    items: [],
    doneIndex: -1,
    pendingIndex: null,
    pendingSince: null,
    nextTime: Date.now(),
    paused: false,
    pauseReason: '',
    pauseCode: '',
    updatedAt: Date.now(),
  };
}

export function getState(accountName) {
  const file = statePath(accountName);
  if (!existsSync(file)) return defaultState();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    return { ...defaultState(), ...raw };
  } catch (err) {
    throw new Error(`账号 ${accountName} 的状态文件损坏(${file})：${err.message}`);
  }
}

export function setState(accountName, state) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  state.updatedAt = Date.now();
  writeFileSync(statePath(accountName), JSON.stringify(state, null, 2));
}

export function pause(accountName, reason, code = 'runtime') {
  const state = getState(accountName);
  state.paused = true;
  state.pauseReason = reason || '自动发布已暂停';
  state.pauseCode = code;
  setState(accountName, state);
  return state;
}

export function resume(accountName) {
  const state = getState(accountName);
  state.paused = false;
  state.pauseReason = '';
  state.pauseCode = '';
  setState(accountName, state);
  return state;
}
