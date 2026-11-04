// 只依赖 Node 内置模块：首次安装依赖之前也能检查更新。
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

export const COMMIT_URL = 'https://api.github.com/repos/ranfukang-bot/tiktok-/commits/main';
export const REPO_URL = 'https://github.com/ranfukang-bot/tiktok-.git';
export const UPDATE_TIMEOUT_MS = 15_000;
export const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const exec = promisify(execFile);

export async function git(root, args, timeout = UPDATE_TIMEOUT_MS) {
  const { stdout } = await exec('git', args, {
    cwd: root, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

export function validVersion(value) {
  return value && /^[a-f0-9]{40}$/i.test(value.sha) &&
    typeof value.date === 'string' && Number.isFinite(Date.parse(value.date));
}

export async function localVersion(root, timeout = 3000) {
  if (existsSync(path.join(root, '.git'))) {
    try {
      const [sha, date] = (await git(root, ['log', '-1', '--format=%H%n%cI'], timeout)).split(/\r?\n/);
      if (validVersion({ sha, date })) return { sha, date };
    } catch { /* 没装 git 时仍可显示上次成功更新的版本。 */ }
  }
  try {
    const version = JSON.parse(readFileSync(path.join(root, '.update-version'), 'utf8'));
    if (validVersion(version)) return { sha: version.sha, date: version.date };
  } catch { /* 第一次从 ZIP 解压时没有版本记录。 */ }
  return { sha: null, date: null };
}

export async function latestVersion({ signal = AbortSignal.timeout(UPDATE_TIMEOUT_MS), request = fetch } = {}) {
  const response = await request(COMMIT_URL, {
    signal, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'tiktok-self-update' },
  });
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  const data = await response.json();
  const version = { sha: data.sha, date: data.commit?.committer?.date };
  if (!validVersion(version)) throw new Error('GitHub 返回的版本信息不完整');
  return version;
}

export function isConsoleStatus(status) {
  return status && typeof status.running === 'boolean' && Array.isArray(status.accounts) &&
    Object.hasOwn(status, 'lastTickAt') && Object.hasOwn(status, 'settingsError');
}

export async function consoleIsRunning(port = Number(process.env.PORT) || 8765) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1000) });
    return response.ok && Boolean(isConsoleStatus(await response.json()));
  } catch { return false; }
}

// 固定记录进程启动时的版本。运行中只读 GitHub，绝不调用更新器。
export function createVersionMonitor({ root, getLocal = localVersion, getLatest = latestVersion,
  schedule = setInterval, cancel = clearInterval } = {}) {
  let current = { sha: null, date: null }, latest = null, timer, checking;
  let initialized = Promise.resolve();
  async function check() {
    if (checking) return checking;
    checking = (async () => {
      try { latest = await getLatest(); } catch { /* 离线/限流保留上次成功结果。 */ }
    })();
    try { await checking; } finally { checking = null; }
  }
  return {
    async start() {
      initialized = getLocal(root).then(version => { current = version; });
      await initialized;
      void check();
      timer = schedule(check, CHECK_INTERVAL_MS);
      timer.unref?.();
    },
    stop() { if (timer) cancel(timer); },
    ready() { return initialized; },
    check,
    snapshot() { return { current, latest, updateAvailable: Boolean(current.sha && latest && current.sha !== latest.sha) }; },
  };
}
