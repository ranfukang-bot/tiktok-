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
});

test('解析一行输出：正常 JSON、带 BOM、乱七八糟的行', () => {
  assert.deepEqual(
    parseForegroundLine('\uFEFF{"hwnd":"1234","pid":88,"name":"r5apex","title":"Apex Legends","path":"D:\\\\Games\\\\r5apex.exe"}'),
    { hwnd: '1234', pid: 88, name: 'r5apex', title: 'Apex Legends', path: 'D:\\Games\\r5apex.exe' },
  );
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
