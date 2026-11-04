import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { selfUpdate, applyArchive } from '../tools/self-update.mjs';

const oldVersion = { sha: 'a'.repeat(40), date: '2026-10-01T00:00:00Z' };
const newVersion = { sha: 'b'.repeat(40), date: '2026-11-04T00:00:00Z' };
function put(root, file, content) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
}
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tiktok-update-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'installed');
  const source = path.join(dir, 'snapshot');
  for (const target of [root, source]) {
    put(target, 'package.json', '{"type":"module"}');
    put(target, 'package-lock.json', '{"lockfileVersion":3}');
    put(target, 'src/server.js', target === root ? 'old code' : 'new code');
    put(target, 'start.bat', '@echo off\r\n');
    put(target, 'start.command', '#!/bin/bash\n');
    for (const name of ['config/settings.json', 'config/accounts.json', 'state/a.json', 'state/nested/progress',
      'diagnostics/output/report.json', 'node_modules/module/file', 'logs/console.txt', 'app.log', 'app.log.1']) {
      put(target, name, target === root ? `user data: ${name}` : 'must not replace user data');
    }
  }
  put(root, '.update-version', JSON.stringify(oldVersion));
  const archive = path.join(dir, 'fixture.tar.gz');
  const options = {
    root, isRunning: async () => false, getLatest: async () => newVersion, log: () => {},
    download: async (_version, destination) => {
      execFileSync('tar', ['-czf', archive, '-C', dir, 'snapshot'], { windowsHide: true });
      copyFileSync(archive, destination);
    },
    install: async () => { throw new Error('unexpected npm install'); },
  };
  return { dir, root, source, options };
}
function snapshot(root, prefix = '') {
  const result = {};
  for (const entry of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, { [name + '/']: 'directory' }, snapshot(root, name));
    else result[name] = readFileSync(path.join(root, name)).toString('base64');
  }
  return result;
}

test('真实 tar 覆盖代码，但完整保留配置、状态、诊断、依赖和日志', async t => {
  const f = fixture(t);
  const before = snapshot(f.root);
  assert.equal((await selfUpdate(f.options)).status, 'updated');
  assert.equal(readFileSync(path.join(f.root, 'src/server.js'), 'utf8'), 'new code');
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.root, '.update-version'))), newVersion);
  const after = snapshot(f.root);
  for (const [file, value] of Object.entries(before)) {
    if (!['src/server.js', '.update-version'].includes(file)) assert.equal(after[file], value, file);
  }
});

test('下载中断、真实 tar 解压失败、部分解压失败：本地所有文件和版本原样保留', async t => {
  for (const failure of ['download', 'tar', 'partial-extract']) {
    const f = fixture(t);
    const before = snapshot(f.root);
    if (failure === 'download') f.options.download = async (_v, destination) => {
      writeFileSync(destination, 'partial download'); throw new Error('offline');
    };
    if (failure === 'tar') f.options.download = async (_v, destination) => writeFileSync(destination, 'not a tar.gz');
    if (failure === 'partial-extract') f.options.extract = async (_archive, destination) => {
      put(destination, 'src/server.js', 'partial new code'); throw new Error('tar stopped halfway');
    };
    assert.equal((await selfUpdate(f.options)).status, 'skipped', failure);
    assert.deepEqual(snapshot(f.root), before, failure);
  }
});

test('更新包缺少必要文件：校验失败时本地文件不变', async t => {
  const f = fixture(t);
  rmSync(path.join(f.source, 'src/server.js'));
  const before = snapshot(f.root);
  assert.equal((await selfUpdate(f.options)).status, 'skipped');
  assert.deepEqual(snapshot(f.root), before);
});

test('本地路径冲突在覆盖前发现，已有代码保持原样', async t => {
  const f = fixture(t);
  put(f.source, 'new-folder/code.js', 'new file');
  put(f.root, 'new-folder', 'local file, not directory');
  const before = snapshot(f.root);
  assert.equal((await selfUpdate(f.options)).status, 'skipped');
  assert.deepEqual(snapshot(f.root), before);
});

test('覆盖中途写入失败：恢复被覆盖文件、移除新增文件，版本和配置不变', t => {
  const f = fixture(t);
  put(f.source, 'aaa-new-folder/new-file.js', 'new code');
  put(f.source, 'package-lock.json', '{"lockfileVersion":3,"changed":true}');
  const before = snapshot(f.root);
  let copies = 0;
  assert.throws(() => applyArchive(f.root, f.source, path.join(f.dir, 'backup'), newVersion, {
    copyFile(source, destination) {
      copyFileSync(source, destination);
      if (++copies === 3) throw new Error('simulated disk failure after partial write');
    },
  }), /simulated disk failure/);
  assert.deepEqual(snapshot(f.root), before);
});

test('版本相同不下载；已运行的控制台连 GitHub 和 npm 都不访问', async t => {
  const f = fixture(t);
  f.options.download = async () => assert.fail('must not download');
  f.options.getLatest = async () => oldVersion;
  const before = snapshot(f.root);
  assert.equal((await selfUpdate(f.options)).status, 'current');
  f.options.isRunning = async () => true;
  f.options.getLatest = async () => assert.fail('must not check GitHub');
  assert.equal((await selfUpdate(f.options)).status, 'running');
  assert.deepEqual(snapshot(f.root), before);
});

test('下载过程中控制台启动：解压后再次检查，不覆盖运行中的代码', async t => {
  const f = fixture(t);
  let calls = 0;
  f.options.isRunning = async () => ++calls > 1;
  const before = snapshot(f.root);
  assert.equal((await selfUpdate(f.options)).status, 'running');
  assert.deepEqual(snapshot(f.root), before);
});

test('断网或总预算超时：跳过更新并允许旧版启动', async t => {
  for (const timeout of [false, true]) {
    const f = fixture(t);
    const before = snapshot(f.root);
    f.options.timeoutMs = 30;
    f.options.getLatest = async ({ signal }) => {
      if (!timeout) throw new Error('offline');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 2000);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
    };
    const start = Date.now();
    assert.equal((await selfUpdate(f.options)).exitCode, 0);
    assert.ok(Date.now() - start < 1500);
    assert.deepEqual(snapshot(f.root), before);
  }
});

test('锁文件变化安装依赖；安装失败停止并保留标记，下一次必须重试', async t => {
  const f = fixture(t);
  put(f.source, 'package-lock.json', '{"lockfileVersion":3,"packages":{}}');
  let calls = 0;
  const messages = [];
  f.options.log = message => messages.push(message);
  f.options.install = async () => { calls++; throw new Error('install failed'); };
  assert.equal((await selfUpdate(f.options)).exitCode, 1);
  assert.ok(messages.join('\n').includes('请把错误截图给开发者'));
  assert.ok(snapshot(f.root)['.update-install-pending']);
  f.options.install = async () => { calls++; };
  assert.equal((await selfUpdate(f.options)).exitCode, 0);
  assert.equal(calls, 2);
  assert.equal(snapshot(f.root)['.update-install-pending'], undefined);
});

test('首次离线启动缺少 node_modules 仍安装依赖', async t => {
  const f = fixture(t);
  rmSync(path.join(f.root, 'node_modules'), { recursive: true });
  f.options.getLatest = async () => { throw new Error('offline'); };
  let installed = false;
  f.options.install = async () => { installed = true; mkdirSync(path.join(f.root, 'node_modules')); };
  assert.equal((await selfUpdate(f.options)).exitCode, 0);
  assert.equal(installed, true);
});

function runGit(root, args) {
  return execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, '.missing-global-gitconfig') },
    stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function gitFixture(t) {
  const f = fixture(t);
  const remote = path.join(f.dir, 'remote');
  mkdirSync(remote);
  runGit(remote, ['init', '-b', 'main']);
  for (const root of [remote, f.root]) {
    if (root === f.root) runGit(root, ['init', '-b', 'main']);
    runGit(root, ['config', 'user.email', 'fixture@example.invalid']);
    runGit(root, ['config', 'user.name', 'Fixture']);
  }
  put(remote, 'src/server.js', 'old code');
  put(remote, 'package-lock.json', '{"lockfileVersion":3}');
  runGit(remote, ['add', '.']); runGit(remote, ['commit', '-m', 'initial']);
  runGit(f.root, ['fetch', remote, 'main']);
  runGit(f.root, ['reset', '--mixed', 'FETCH_HEAD']);
  // 本地数据保持未跟踪，模拟正常安装。
  put(remote, 'src/server.js', 'git new code');
  runGit(remote, ['add', '.']); runGit(remote, ['commit', '-m', 'new code']);
  const version = () => {
    const [sha, date] = runGit(remote, ['log', '-1', '--format=%H%n%cI']).split(/\r?\n/);
    return { sha, date };
  };
  f.options.getLatest = async () => version();
  f.options.runGit = async (root, args) => {
    // 测试只访问本机 git 仓库，绝不访问 GitHub。
    if (args[0] === 'fetch') args = ['fetch', '--no-tags', remote, 'main'];
    return runGit(root, args);
  };
  return { ...f, remote, version };
}

test('真实本地 git 仓库通过 pull --ff-only 更新，配置不变', async t => {
  const f = gitFixture(t);
  const messages = [];
  f.options.log = message => messages.push(message);
  const settings = readFileSync(path.join(f.root, 'config/settings.json'), 'utf8');
  assert.equal((await selfUpdate(f.options)).status, 'updated', messages.join('\n'));
  assert.equal(runGit(f.root, ['rev-parse', 'HEAD']), f.version().sha);
  assert.equal(readFileSync(path.join(f.root, 'src/server.js'), 'utf8'), 'git new code');
  assert.equal(readFileSync(path.join(f.root, 'config/settings.json'), 'utf8'), settings);
});

test('git 本地代码改动阻止拉取：不覆盖改动，用旧版启动', async t => {
  const f = gitFixture(t);
  put(f.root, 'src/server.js', 'local modification');
  const head = runGit(f.root, ['rev-parse', 'HEAD']);
  assert.equal((await selfUpdate(f.options)).exitCode, 0);
  assert.equal(runGit(f.root, ['rev-parse', 'HEAD']), head);
  assert.equal(readFileSync(path.join(f.root, 'src/server.js'), 'utf8'), 'local modification');
});

test('git 目标提交涉及受保护路径则拒绝拉取', async t => {
  const f = gitFixture(t);
  put(f.remote, 'config/settings.json', 'remote data');
  runGit(f.remote, ['add', '.']); runGit(f.remote, ['commit', '-m', 'protected path']);
  const head = runGit(f.root, ['rev-parse', 'HEAD']);
  const settings = readFileSync(path.join(f.root, 'config/settings.json'), 'utf8');
  assert.equal((await selfUpdate(f.options)).status, 'skipped');
  assert.equal(runGit(f.root, ['rev-parse', 'HEAD']), head);
  assert.equal(readFileSync(path.join(f.root, 'config/settings.json'), 'utf8'), settings);
});

test('Windows 启动脚本被更新器替换后仍能完成启动；安装失败则停止', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  const launcher = readFileSync(new URL('../start.bat', import.meta.url), 'utf8').replace(/\r?\n/g, '\r\n');
  const npmShim = path.join(f.root, 'npm.cmd');
  writeFileSync(npmShim, '@echo off\r\n>started.txt echo started\r\nexit /b 0\r\n');
  const env = { ...process.env, PATH: `${f.root};${process.env.PATH}` };
  for (const fail of [false, true]) {
    writeFileSync(path.join(f.root, 'start.bat'), launcher);
    put(f.root, 'tools/self-update.mjs', `
      import { writeFileSync } from 'node:fs';
      writeFileSync('start.bat', '@echo off\\r\\nexit /b 9\\r\\n');
      process.exitCode = ${fail ? 1 : 0};
    `);
    if (fail) rmSync(path.join(f.root, 'started.txt'));
    const execute = () => execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start.bat'], {
      cwd: f.root, env, input: '\r\n', timeout: 5000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (fail) {
      try { execute(); } catch (error) { assert.equal(error.status, 1); }
      assert.equal(snapshot(f.root)['started.txt'], undefined);
    } else {
      execute();
      assert.ok(snapshot(f.root)['started.txt']);
    }
  }
});
