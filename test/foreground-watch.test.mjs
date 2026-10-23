// 前台窗口记录：发布期间把"最前面的窗口"每次变化记进账号日志，用来查谁把游戏切出去。
// 这里守住：脚本本身写对（UTF-8、不占用 $pid）、只在 Windows 上启动且隐藏窗口、
// 多个账号共用一个记录进程、没人发布时自动退出、移回收站的 PowerShell 也隐藏窗口。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  FOREGROUND_WATCH_SCRIPT,
  parseForegroundLine,
  describeForeground,
  createForegroundWatch,
} from '../src/foregroundWatch.js';
import { moveToTrash } from '../src/trash.js';

function fakeSpawn() {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.written = [];
    proc.stdin = { destroyed: false, on() {}, write: (text) => { proc.written.push(text); return true; } };
    proc.killed = false;
    proc.kill = () => { proc.killed = true; proc.emit('exit', 0); };
    calls.push({ file, args, options, proc });
    return proc;
  };
  return { calls, spawnImpl };
}

function memoryLog() {
  const lines = [];
  return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
}

const tick = () => new Promise((r) => setImmediate(r));

test('PowerShell 脚本先切 UTF-8 再输出，不把 $pid 当普通变量用', () => {
  const enc = FOREGROUND_WATCH_SCRIPT.indexOf('[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false');
  const write = FOREGROUND_WATCH_SCRIPT.indexOf('[Console]::Out.WriteLine');
  assert.ok(enc >= 0 && write > enc, '必须先设 UTF-8 输出');
  assert.ok(FOREGROUND_WATCH_SCRIPT.includes('GetForegroundWindow'));
  assert.ok(FOREGROUND_WATCH_SCRIPT.includes('[Console]::Out.Flush()'), '每行都要立刻刷出去，否则会攒着不报');
  assert.ok(!/\$pid\b/i.test(FOREGROUND_WATCH_SCRIPT), '$pid 是 PowerShell 只读自带变量');
  // [Console]::In 的 ReadLineAsync 在 Windows PowerShell 里是同步的，会卡死整个循环。
  assert.ok(!/\[Console\]::In\b/.test(FOREGROUND_WATCH_SCRIPT));
  assert.ok(FOREGROUND_WATCH_SCRIPT.includes('[Console]::OpenStandardInput()'));
  assert.ok(FOREGROUND_WATCH_SCRIPT.includes('ReadLineAsync()'));
  assert.ok(FOREGROUND_WATCH_SCRIPT.includes('if ($null -eq $cmd) { break }'), '标准输入断开时必须退出，不留孤儿进程');
  for (const api of ['AttachThreadInput', 'IsGUIThread', 'SetForegroundWindow', 'SwitchToThisWindow', 'IsIconic']) {
    assert.ok(FOREGROUND_WATCH_SCRIPT.includes(api), `切回窗口需要 ${api}`);
  }
  assert.ok(FOREGROUND_WATCH_SCRIPT.includes("'^restore (\\d+)$'"), '只接受 restore <数字句柄> 这一种命令');
});

test('解析一行输出：正常 JSON、带 BOM、乱七八糟的行', () => {
  assert.deepEqual(
    parseForegroundLine('\uFEFF{"event":"foreground","hwnd":"1234","pid":88,"name":"r5apex","title":"Apex Legends","path":"D:\\\\Games\\\\r5apex.exe","started":""}'),
    { event: 'foreground', hwnd: '1234', pid: 88, name: 'r5apex', title: 'Apex Legends', path: 'D:\\Games\\r5apex.exe', started: '' },
  );
  assert.deepEqual(parseForegroundLine('{"event":"restore","target":"1234","result":"ok"}'),
    { event: 'restore', target: '1234', result: 'ok' });
  assert.equal(parseForegroundLine('Add-Type : 出错了'), null);
  assert.equal(parseForegroundLine('{坏的'), null);
});

test('窗口描述：程序名、标题、位置；没有前台窗口时说清楚', () => {
  assert.equal(
    describeForeground({ hwnd: '9', pid: 5, name: 'chrome', title: 'TikTok Studio', path: 'C:\\BitBrowser\\chrome.exe' }),
    'chrome「TikTok Studio」，程序位置：C:\\BitBrowser\\chrome.exe',
  );
  assert.equal(describeForeground({ hwnd: '9', pid: 5, name: 'powershell', title: '', path: '' }), 'powershell（无标题）');
  assert.match(describeForeground({ hwnd: '0', pid: 0, name: '', title: '', path: '' }), /没有任何窗口在最前面/);
});

test('非 Windows 或手动关闭时什么都不启动', () => {
  const { calls, spawnImpl } = fakeSpawn();
  const linux = createForegroundWatch({ platform: 'linux', spawnImpl });
  linux.track('A', memoryLog())();
  const win = createForegroundWatch({ platform: 'win32', spawnImpl });
  win.track('A', memoryLog(), { enabled: false })();
  assert.equal(calls.length, 0);
});

test('Windows 上：隐藏窗口启动一次，变化记进所有正在发布的账号日志，全部结束后自动退出', async () => {
  const { calls, spawnImpl } = fakeSpawn();
  const fallback = memoryLog();
  const watch = createForegroundWatch({ platform: 'win32', spawnImpl, graceMs: 20, fallbackLog: fallback });
  const logA = memoryLog();
  const logB = memoryLog();

  const stopA = watch.track('A', logA);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'powershell.exe');
  assert.equal(calls[0].options.windowsHide, true, '记录进程自己不能弹窗口');
  assert.ok(calls[0].args.includes('-EncodedCommand'));
  const proc = calls[0].proc;

  proc.stdout.write('{"hwnd":"11","pid":1,"name":"r5apex","title":"Apex Legends","path":""}\n');
  await tick();
  assert.match(logA.lines.at(-1), /\[前台窗口\].*r5apex「Apex Legends」/);

  const stopB = watch.track('B', logB);
  assert.equal(calls.length, 1, '多个账号共用一个记录进程');
  assert.match(logB.lines.at(-1), /开始记录.*r5apex/, '后加入的账号先记一下当前前台是谁');

  proc.stdout.write('{"hwnd":"22","pid":2,"name":"chrome","title":"TikTok Studio","path":"C:\\\\BitBrowser\\\\chrome.exe"}\n');
  await tick();
  assert.match(logA.lines.at(-1), /chrome「TikTok Studio」/);
  assert.match(logB.lines.at(-1), /chrome「TikTok Studio」/);

  stopA();
  stopB();
  assert.equal(proc.killed, false, '刚结束时再多记一会儿收尾动作');
  proc.stdout.write('{"hwnd":"33","pid":3,"name":"powershell","title":"","path":""}\n');
  await tick();
  assert.match(fallback.lines.at(-1), /powershell/, '收尾阶段的变化记到调度器日志');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(proc.killed, true, '没人发布后自动退出');
  assert.equal(watch.isRunning(), false);

  watch.track('C', memoryLog())();
  assert.equal(calls.length, 2, '下次有账号发布时重新启动');
  watch.stop();
});

test('记录进程启动失败不影响发布流程', () => {
  const watch = createForegroundWatch({ platform: 'win32', spawnImpl: () => { throw new Error('找不到 powershell'); } });
  const stop = watch.track('A', memoryLog());
  assert.equal(typeof stop, 'function');
  stop();
});

test('移到回收站用的 PowerShell 隐藏窗口启动', async () => {
  let seen;
  await moveToTrash('C:\\videos\\a.mp4', {
    platform: 'win32',
    run: (file, args, options, cb) => { seen = { file, options }; cb(null, '', ''); },
  });
  assert.equal(seen.file, 'powershell.exe');
  assert.equal(seen.options.windowsHide, true);
});

// ---------- 防抢前台：比特浏览器打开窗口时抢走最前面，立刻切回原来的窗口 ----------

const GAME = { event: 'foreground', hwnd: '1001', pid: 50, name: 'r5apex', title: 'Apex Legends', path: 'D:\\Games\\r5apex.exe', started: '2026-10-01T00:00:00.000Z' };
const BIT_KERNEL = { event: 'foreground', hwnd: '2002', pid: 777, name: 'chrome', title: 'TikTok Studio', path: 'C:\\Users\\a\\AppData\\Roaming\\BitBrowser\\chrome-core\\chrome.exe', started: '2026-10-01T00:00:00.000Z' };
const OTHER_KERNEL = { ...BIT_KERNEL, hwnd: '2003', pid: 888, path: 'C:\\SomeKernel\\chrome.exe' };
const WECHAT = { event: 'foreground', hwnd: '3003', pid: 60, name: 'WeChat', title: '微信', path: 'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe', started: '2026-10-01T00:00:00.000Z' };

async function startedWatch(options = {}) {
  const { calls, spawnImpl } = fakeSpawn();
  const watch = createForegroundWatch({ platform: 'win32', spawnImpl, graceMs: 10, ...options });
  const log = memoryLog();
  const stopTracking = watch.track('A', log);
  const proc = calls[0].proc;
  const emit = async (o) => { proc.stdout.write(`${JSON.stringify(o)}\n`); await tick(); };
  return { watch, log, proc, emit, stopTracking };
}

test('比特窗口抢到最前面时，立刻发命令切回打开前的窗口，并把结果记进日志', async () => {
  const { watch, log, proc, emit } = await startedWatch();
  await emit(GAME);
  const guard = await watch.guardOpen(log);
  await emit(BIT_KERNEL); // 打开过程中比特窗口跳到最前面
  assert.deepEqual(proc.written, ['restore 1001\n'], '按程序位置认出是比特，马上切回游戏');
  assert.ok(log.lines.some((l) => /\[防抢前台\].*正在切回原来的窗口：r5apex「Apex Legends」/.test(l)));
  await emit({ event: 'restore', target: '1001', result: 'ok' });
  assert.match(log.lines.at(-1), /\[防抢前台\] 已切回/);
  await emit(GAME); // 切回后游戏重新在最前面，不再动作
  guard.opened({ pid: 777 });
  assert.equal(proc.written.length, 1);
  watch.stop();
});

test('程序位置认不出时，用比特返回的进程号认出刚打开的窗口', async () => {
  const { watch, log, proc, emit } = await startedWatch();
  await emit(GAME);
  const guard = await watch.guardOpen(log);
  await emit(OTHER_KERNEL);
  assert.equal(proc.written.length, 0, '还不知道比特内核的进程号，先不动');
  guard.opened({ pid: 888 });
  assert.deepEqual(proc.written, ['restore 1001\n'], '拿到进程号后认出就是它，切回');
  watch.stop();
});

test('打开期间新启动的程序抢到最前面也切回（进程号拿不到时的兜底）', async () => {
  const { watch, log, proc, emit } = await startedWatch();
  await emit(GAME);
  const guard = await watch.guardOpen(log);
  guard.opened({});
  await emit({ ...OTHER_KERNEL, started: new Date().toISOString() });
  assert.deepEqual(proc.written, ['restore 1001\n']);
  watch.stop();
});

test('你自己切到别的程序（不是比特、也不是新启动的）不会被拽回去', async () => {
  const { watch, log, proc, emit } = await startedWatch();
  await emit(GAME);
  const guard = await watch.guardOpen(log);
  guard.opened({ pid: 777 });
  await emit(WECHAT);
  await emit(WECHAT);
  assert.equal(proc.written.length, 0);
  assert.equal(log.lines.filter((l) => /不是比特浏览器，不处理/.test(l)).length, 1, '只记一次，方便排查');
  watch.stop();
});

test('只在打开后的一段时间内保护；过时之后比特窗口在前面也不再切回', async () => {
  const { watch, log, proc, emit } = await startedWatch();
  await emit(GAME);
  const guard = await watch.guardOpen(log, { windowMs: 20 });
  guard.opened({ pid: 777 });
  await new Promise((r) => setTimeout(r, 40));
  await emit(BIT_KERNEL);
  assert.equal(proc.written.length, 0);
  watch.stop();
});

test('最多切回几次，不和比特来回抢个没完', async () => {
  const { watch, log, proc, emit } = await startedWatch();
  await emit(GAME);
  const guard = await watch.guardOpen(log, { maxRestores: 2 });
  guard.opened({ pid: 777 });
  for (let i = 0; i < 4; i += 1) { await emit(BIT_KERNEL); await emit(GAME); }
  assert.equal(proc.written.length, 2);
  watch.stop();
});

test('原来最前面就是比特窗口（你在看某个号）时，不做任何切回', async () => {
  const { watch, log, proc, emit } = await startedWatch();
  await emit(BIT_KERNEL);
  const guard = await watch.guardOpen(log);
  guard.opened({ pid: 999 });
  await emit({ ...BIT_KERNEL, hwnd: '4004', pid: 999 });
  assert.equal(proc.written.length, 0);
  watch.stop();
});

test('记录进程迟迟没报出前台窗口时不卡住打开流程，也不切回', async () => {
  const { watch, log, proc } = await startedWatch();
  const t0 = Date.now();
  const guard = await watch.guardOpen(log, { readyTimeoutMs: 30 });
  assert.ok(Date.now() - t0 < 1000);
  guard.opened({ pid: 777 });
  assert.equal(proc.written.length, 0);
  watch.stop();
});

test('打开失败时可以安全结束保护；非 Windows 或关闭开关时什么都不做', async () => {
  const { watch, log, proc, emit } = await startedWatch();
  await emit(GAME);
  const guard = await watch.guardOpen(log);
  guard.stop();
  await emit(BIT_KERNEL);
  assert.equal(proc.written.length, 0);
  assert.equal(typeof (await watch.guardOpen(log, { enabled: false })).opened, 'function');
  watch.stop();
  const linux = createForegroundWatch({ platform: 'linux' });
  const g = await linux.guardOpen(log);
  g.opened({ pid: 1 }); g.stop();
});
