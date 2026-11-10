import { spawn, execFile } from 'node:child_process';
import { createWriteStream, existsSync, lstatSync, readdirSync, readFileSync, writeFileSync,
  mkdirSync, mkdtempSync, rmSync, rmdirSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { consoleIsRunning, git, latestVersion, localVersion, REPO_URL, UPDATE_TIMEOUT_MS } from '../src/updateInfo.js';

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_PENDING = '.update-install-pending';

export function protectedPath(relative) {
  const name = relative.replaceAll('\\', '/').toLowerCase();
  const parts = name.split('/');
  return ['.git', 'node_modules', 'state', 'logs', 'log'].includes(parts[0]) ||
    name === 'config/settings.json' || name === 'config/accounts.json' ||
    name === 'diagnostics/output' || name.startsWith('diagnostics/output/') ||
    parts.some(part => /\.log(?:\.|$)/.test(part)) ||
    name === '.update-version' || name === INSTALL_PENDING;
}

export async function downloadArchive(version, destination, signal) {
  // 固定为刚查到的 main 提交，避免下载期间 main 前进导致版本记录与代码不一致。
  const response = await fetch(`https://codeload.github.com/ranfukang-bot/tiktok-/tar.gz/${version.sha}`, { signal });
  if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination), { signal });
}

export async function extractArchive(archive, destination, timeout) {
  const windowsTar = process.platform === 'win32' && process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : null;
  const useWindowsTar = windowsTar && existsSync(windowsTar);
  // GitHub tar 包的文件名是 UTF-8；Windows 自带 bsdtar 默认可能用系统代码页读文件名。
  const encoding = useWindowsTar ? ['--options', 'hdrcharset=UTF-8'] : [];
  await exec(useWindowsTar ? windowsTar : 'tar',
    [...encoding, '-xzf', archive, '-C', destination, '--strip-components=1'], { timeout, windowsHide: true });
}

function filesUnder(directory, prefix = '') {
  const files = [];
  for (const name of readdirSync(path.join(directory, prefix))) {
    const relative = prefix ? `${prefix}/${name}` : name;
    if (protectedPath(relative)) continue;
    const stat = lstatSync(path.join(directory, relative));
    if (stat.isSymbolicLink()) throw new Error(`更新包包含链接：${relative}`);
    if (stat.isDirectory()) files.push(...filesUnder(directory, relative));
    else if (stat.isFile()) files.push(relative);
    else throw new Error(`更新包包含特殊文件：${relative}`);
  }
  return files;
}

function checkTarget(root, relative) {
  let target = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    target = path.join(target, parts[i]);
    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
        throw new Error(`本地路径不能安全覆盖：${relative}`);
      }
      if (i === parts.length - 1 && !(stat.mode & 0o222)) throw new Error(`本地文件只读：${relative}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function lockContents(root) {
  try { return readFileSync(path.join(root, 'package-lock.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// 下载、解压、文件检查和备份全部完成后才写入。覆盖失败也回滚已有文件。
export function applyArchive(root, staged, backup, version, { copyFile = copyFileSync } = {}) {
  JSON.parse(readFileSync(path.join(staged, 'package.json'), 'utf8'));
  for (const required of ['src/server.js', 'start.bat', 'start.command']) {
    if (!lstatSync(path.join(staged, required)).isFile()) throw new Error(`更新包缺少 ${required}`);
  }
  const files = filesUnder(staged);
  const lockChanged = lockContents(root) !== lockContents(staged);
  writeFileSync(path.join(staged, '.update-version'), JSON.stringify(version) + '\n');
  files.push('.update-version');
  if (lockChanged) {
    writeFileSync(path.join(staged, INSTALL_PENDING), 'npm install\n');
    files.push(INSTALL_PENDING);
  }
  const originals = new Set();
  for (const relative of files) {
    checkTarget(root, relative);
    // 提前读完整文件，坏文件不会等覆盖一半才发现。
    readFileSync(path.join(staged, relative));
    if (existsSync(path.join(root, relative))) {
      mkdirSync(path.dirname(path.join(backup, relative)), { recursive: true });
      copyFileSync(path.join(root, relative), path.join(backup, relative));
      chmodSync(path.join(backup, relative), lstatSync(path.join(root, relative)).mode & 0o777);
      originals.add(relative);
    }
  }
  const touched = [], createdDirs = [];
  try {
    for (const relative of files) {
      const destination = path.join(root, relative);
      const missing = [];
      let parent = path.dirname(destination);
      while (!existsSync(parent)) { missing.push(parent); parent = path.dirname(parent); }
      for (const dir of missing.reverse()) { mkdirSync(dir); createdDirs.push(dir); }
      touched.push(relative);
      copyFile(path.join(staged, relative), destination);
      chmodSync(destination, lstatSync(path.join(staged, relative)).mode & 0o777);
    }
  } catch (error) {
    for (const relative of touched.reverse()) {
      const destination = path.join(root, relative);
      if (originals.has(relative)) {
        copyFileSync(path.join(backup, relative), destination);
        chmodSync(destination, lstatSync(path.join(backup, relative)).mode & 0o777);
      } else rmSync(destination, { force: true });
    }
    for (const dir of createdDirs.reverse()) rmdirSync(dir);
    throw error;
  }
}

export async function installDependencies(root) {
  await new Promise((resolve, reject) => {
    // Windows 的 npm.cmd 必须经 cmd 启动；命令固定，不拼接路径或远程文本。
    const child = process.platform === 'win32'
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm install'], { cwd: root, stdio: 'inherit', windowsHide: true })
      : spawn('npm', ['install'], { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`npm install 退出码 ${code}`)));
  });
}

export async function selfUpdate({ root = ROOT, isRunning = consoleIsRunning, getLatest = latestVersion,
  getLocal = localVersion, runGit = git, download = downloadArchive, extract = extractArchive,
  install = installDependencies, timeoutMs = UPDATE_TIMEOUT_MS, log = console.log } = {}) {
  if (await isRunning()) {
    log('控制台已经在运行，跳过更新并打开现有控制台。');
    return { status: 'running' };
  }
  let temp, status = 'skipped';
  const beforeLock = lockContents(root);
  const deadline = Date.now() + timeoutMs;
  const signal = AbortSignal.timeout(timeoutMs);
  const remaining = () => {
    const ms = deadline - Date.now();
    if (signal.aborted || ms <= 0) throw new Error('更新检查超过 15 秒');
    return ms;
  };
  try {
    const version = await getLatest({ signal });
    const current = await getLocal(root, Math.min(3000, remaining()));
    remaining();
    if (current.sha === version.sha) {
      status = 'current';
    } else if (existsSync(path.join(root, '.git'))) {
      // 先获取并检查目标提交，再从本地拉取同一个提交，避免第二次联网时 main 变化。
      await runGit(root, ['fetch', '--no-tags', REPO_URL, 'main'], remaining());
      const changed = await runGit(root, ['diff', '--name-only', '-z', 'HEAD', version.sha], remaining());
      if (changed.split('\0').filter(Boolean).some(protectedPath)) throw new Error('新版本涉及本地数据保护路径，已跳过');
      if (await isRunning()) return { status: 'running' };
      await runGit(root, ['pull', '--ff-only', '.', version.sha], remaining());
      writeFileSync(path.join(root, '.update-version'), JSON.stringify(version) + '\n');
      status = 'updated';
    } else {
      temp = mkdtempSync(path.join(tmpdir(), 'tiktok-update-'));
      const archive = path.join(temp, 'main.tar.gz');
      const staged = path.join(temp, 'unpacked');
      mkdirSync(staged);
      await download(version, archive, signal);
      await extract(archive, staged, remaining());
      remaining();
      // 在耗时的下载/解压后再检查一次，运行中的控制台永远不被更新。
      if (await isRunning()) return { status: 'running' };
      remaining();
      applyArchive(root, staged, path.join(temp, 'backup'), version);
      status = 'updated';
    }
    if (status === 'updated') log(`已更新到 ${version.sha.slice(0, 7)}（${version.date.slice(0, 10)}）。`);
  } catch (error) {
    log(`暂未更新（网络不可用、超时或本地改动等：${error.message.split(/\r?\n/)[0]}），使用本地版本继续启动。`);
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
  if (beforeLock !== lockContents(root)) writeFileSync(path.join(root, INSTALL_PENDING), 'npm install\n');
  if (!existsSync(path.join(root, 'node_modules')) || existsSync(path.join(root, INSTALL_PENDING))) {
    log('正在安装依赖，请稍等…');
    try {
      // 安装失败时保留标记，下次启动必须重试，不能运行依赖不完整的新代码。
      writeFileSync(path.join(root, INSTALL_PENDING), 'npm install\n');
      await install(root);
      rmSync(path.join(root, INSTALL_PENDING), { force: true });
    } catch (error) {
      log(`依赖安装失败：${error.message}\n请把错误截图给开发者`);
      return { status: 'install-failed', exitCode: 1 };
    }
  }
  return { status, exitCode: 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = (await selfUpdate()).exitCode || 0; }
  catch (error) { console.error(error.message + '\n请把错误截图给开发者'); process.exitCode = 1; }
}
