import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// 前台窗口记录 + 防抢前台（只在 Windows 上工作）。
//
// 用户反馈：打游戏时自动发布会把游戏切出去。逐个排查后确认：页面里的点击/键盘操作抢不到前台，
// 是【比特浏览器打开环境窗口的那一刻】把新窗口提到了最前面（比特客户端的行为，接口没有"后台打开"选项）。
//
// 这里做两件事：
// 1. 记录：发布期间把"最前面的窗口"每次变化记进账号日志（程序名、窗口标题、程序位置）。
// 2. 防抢前台：打开比特窗口之前记下当时最前面的窗口（比如游戏）；打开后一小段时间内，
//    只要是刚打开的比特窗口（或比特客户端）抢到了最前面，立刻把最前面切回原来的窗口。
//    窗口本身照常打开、照常在后面跑自动发布，只是不再挡在游戏前面。
//
// 实现：发布期间开一个隐藏的 PowerShell，每 100 毫秒查一次最前面的窗口，变了就输出一行 JSON；
// 从标准输入接收 "restore <窗口句柄>" 命令执行切回。Node 这边退出时标准输入断开，PowerShell 跟着退出。
// 可在 settings.json 里设 "foregroundWatch": false 全部关闭，或 "keepForeground": false 只关防抢前台。

export const FOREGROUND_WATCH_SCRIPT = [
  // 先把输出切成不带 BOM 的 UTF-8，否则中文窗口标题在中文 Windows 上会变乱码（同选择文件夹那次）。
  'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}',
  "$sig = '" + [
    '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);',
    '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);',
    '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);',
    '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);',
    '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    '[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);',
    '[DllImport("user32.dll")] public static extern bool IsGUIThread(bool convert);',
    '[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);',
    '[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);',
    '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);',
    '[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
  ].join(' ') + "'",
  'Add-Type -MemberDefinition $sig -Name W -Namespace TkqForeground',
  'function Emit($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush() }',
  // 注意：$pid 是 PowerShell 自带的只读变量（自己的进程号），不能拿来存别的进程号。
  'function Get-Fg($h) { ' +
    '[uint32]$fgPid = 0; ' +
    '[void][TkqForeground.W]::GetWindowThreadProcessId($h, [ref]$fgPid); ' +
    '$sb = New-Object System.Text.StringBuilder 512; ' +
    '[void][TkqForeground.W]::GetWindowText($h, $sb, 512); ' +
    '$p = Get-Process -Id $fgPid -ErrorAction SilentlyContinue; ' +
    "$started = ''; " +
    "if ($p) { try { $started = $p.StartTime.ToUniversalTime().ToString('o') } catch {} }; " +
    "[ordered]@{ event = 'foreground'; hwnd = [string]$h; pid = [int]$fgPid; name = [string]$p.ProcessName; " +
      'title = $sb.ToString(); path = [string]$p.Path; started = $started } ' +
  '}',
  // 后台程序不能随便把别的窗口提到最前（Windows 的限制），依次试：
  // 挂到当前前台窗口的输入队列再切 -> SwitchToThisWindow -> 轻点一下 Alt（此时最前面是比特窗口，Alt 落在它身上）再切。
  'function Restore-Fg([long]$target) { ' +
    '$t = [IntPtr]$target; ' +
    "if (-not [TkqForeground.W]::IsWindow($t)) { return 'gone' }; " +
    '[void][TkqForeground.W]::IsGUIThread($true); ' +
    '$fg = [TkqForeground.W]::GetForegroundWindow(); ' +
    "if ($fg -eq $t) { return 'already' }; " +
    '[uint32]$tmp = 0; ' +
    '$fgThread = [TkqForeground.W]::GetWindowThreadProcessId($fg, [ref]$tmp); ' +
    '$me = [TkqForeground.W]::GetCurrentThreadId(); ' +
    '$attached = $false; ' +
    'if ($fgThread -ne 0 -and $fgThread -ne $me) { $attached = [TkqForeground.W]::AttachThreadInput($me, $fgThread, $true) }; ' +
    'try { ' +
      'if ([TkqForeground.W]::IsIconic($t)) { [void][TkqForeground.W]::ShowWindow($t, 9) }; ' +
      '[void][TkqForeground.W]::BringWindowToTop($t); ' +
      '[void][TkqForeground.W]::SetForegroundWindow($t) ' +
    '} finally { if ($attached) { [void][TkqForeground.W]::AttachThreadInput($me, $fgThread, $false) } }; ' +
    'Start-Sleep -Milliseconds 80; ' +
    "if ([TkqForeground.W]::GetForegroundWindow() -eq $t) { return 'ok' }; " +
    '[TkqForeground.W]::SwitchToThisWindow($t, $true); ' +
    'Start-Sleep -Milliseconds 150; ' +
    "if ([TkqForeground.W]::GetForegroundWindow() -eq $t) { return 'ok' }; " +
    '[TkqForeground.W]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); ' +
    '[TkqForeground.W]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero); ' +
    'if ([TkqForeground.W]::IsIconic($t)) { [void][TkqForeground.W]::ShowWindow($t, 9) }; ' +
    '[void][TkqForeground.W]::SetForegroundWindow($t); ' +
    'Start-Sleep -Milliseconds 150; ' +
    "if ([TkqForeground.W]::GetForegroundWindow() -eq $t) { return 'ok' }; " +
    "return 'failed' " +
  '}',
  // 不能用 [Console]::In.ReadLineAsync()：Windows PowerShell 里它其实是同步的，会把整个循环卡死。
  '$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput())',
  '$pending = $stdin.ReadLineAsync()',
  "$last = ''",
  'while ($true) { ' +
    'if ($pending.IsCompleted) { ' +
      '$cmd = $null; ' +
      'try { $cmd = $pending.Result } catch { $cmd = $null }; ' +
      // 标准输入断开 = Node 那边已经退出，跟着退出，不留孤儿进程。
      'if ($null -eq $cmd) { break }; ' +
      "if ($cmd -match '^restore (\\d+)$') { " +
        '$target = $Matches[1]; ' +
        '$r = Restore-Fg ([long]$target); ' +
        "Emit ([ordered]@{ event = 'restore'; target = $target; result = $r }) " +
      '}; ' +
      '$pending = $stdin.ReadLineAsync() ' +
    '}; ' +
    '$h = [TkqForeground.W]::GetForegroundWindow(); ' +
    '[uint32]$curPid = 0; ' +
    '[void][TkqForeground.W]::GetWindowThreadProcessId($h, [ref]$curPid); ' +
    '$key = "$h|$curPid"; ' +
    'if ($key -ne $last) { $last = $key; Emit (Get-Fg $h) }; ' +
    'Start-Sleep -Milliseconds 100 ' +
  '}',
].join('; ');

// 解析 PowerShell 输出的一行。前台变化返回 { event:'foreground', ... }，切回结果返回 { event:'restore', ... }。
export function parseForegroundLine(line) {
  const text = String(line || '').replace(/^﻿/, '').trim();
  if (!text.startsWith('{')) return null;
  let o;
  try { o = JSON.parse(text); } catch { return null; }
  if (o.event === 'restore') {
    return { event: 'restore', target: String(o.target ?? ''), result: String(o.result || '') };
  }
  return {
    event: 'foreground',
    hwnd: String(o.hwnd ?? ''),
    pid: Number(o.pid) || 0,
    name: String(o.name || ''),
    title: String(o.title || ''),
    path: String(o.path || ''),
    started: String(o.started || ''),
  };
}

export function describeForeground(fg) {
  if (!fg || fg.hwnd === '0' || (!fg.pid && !fg.name)) return '没有任何窗口在最前面（通常是正在切换窗口）';
  const name = fg.name || `进程号${fg.pid}`;
  const title = fg.title ? `「${fg.title}」` : '（无标题）';
  const where = fg.path ? `，程序位置：${fg.path}` : '';
  return `${name}${title}${where}`;
}

function shortName(fg) {
  if (!fg || fg.hwnd === '0') return '（无）';
  return `${fg.name || `进程号${fg.pid}`}${fg.title ? `「${fg.title}」` : ''}`;
}

// 比特浏览器的内核和客户端，程序位置里都带 BitBrowser。
export function looksLikeBitBrowser(fg) {
  return /bitbrowser|比特/i.test(`${fg?.path || ''} ${fg?.name || ''}`);
}

const RESTORE_RESULT_TEXT = {
  ok: '已切回',
  already: '已经在最前面了',
  gone: '原来的窗口已经不在了（可能被关掉了），没有切回',
  failed: '没能切回（Windows 拒绝了切换）',
};

const NOOP_GUARD = Object.freeze({ opened() {}, stop() {} });

export function createForegroundWatch({
  platform = process.platform,
  spawnImpl = spawn,
  graceMs = 60000,
  fallbackLog = null,
  now = () => Date.now(),
} = {}) {
  const active = new Map(); // 账号名 -> 日志
  const guards = new Set();
  const restoreWaiters = []; // 按顺序等切回结果的 { log }
  const readyWaiters = new Set();
  let child = null;
  let last = null;
  let stopTimer = null;

  function report(fg) {
    const text = `[前台窗口] 现在最前面的窗口：${describeForeground(fg)}`;
    if (active.size) {
      for (const log of active.values()) log.info(text);
    } else if (fallbackLog) {
      fallbackLog.info(text);
    }
  }

  function onLine(line) {
    const msg = parseForegroundLine(line);
    if (!msg) return;
    if (msg.event === 'restore') {
      const waiter = restoreWaiters.shift();
      const log = waiter?.log || fallbackLog;
      const text = RESTORE_RESULT_TEXT[msg.result] || `切回结果：${msg.result}`;
      if (log) (msg.result === 'failed' ? log.warn : log.info).call(log, `[防抢前台] ${text}`);
      return;
    }
    last = msg;
    report(msg);
    for (const resolve of readyWaiters) resolve(true);
    readyWaiters.clear();
    for (const guard of [...guards]) guard.evaluate(msg);
  }

  function start() {
    const encoded = Buffer.from(FOREGROUND_WATCH_SCRIPT, 'utf16le').toString('base64');
    let proc;
    try {
      proc = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      return; // 只是辅助功能，起不来也绝不影响发布
    }
    child = proc;
    last = null;
    const gone = () => {
      if (child !== proc) return;
      child = null;
      last = null;
      restoreWaiters.length = 0;
      for (const resolve of readyWaiters) resolve(false);
      readyWaiters.clear();
    };
    proc.on('error', gone);
    proc.on('exit', gone);
    if (proc.stdin && proc.stdin.on) proc.stdin.on('error', () => {}); // 进程已退出时写命令不能把 Node 搞崩
    if (proc.stdout && proc.stdout.setEncoding) proc.stdout.setEncoding('utf8');
    createInterface({ input: proc.stdout }).on('line', onLine);
  }

  function stop() {
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    for (const guard of [...guards]) guard.stop();
    if (child) {
      const proc = child;
      child = null;
      try { proc.kill(); } catch { /* 已经退出 */ }
    }
    last = null;
    restoreWaiters.length = 0;
  }

  // 等记录进程报出第一次"当前最前面的窗口"（PowerShell 启动要一两秒）。
  function ready(timeoutMs = 5000) {
    if (last) return Promise.resolve(true);
    if (!child) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { readyWaiters.delete(done); resolve(false); }, timeoutMs);
      function done(ok) { clearTimeout(timer); resolve(ok); }
      readyWaiters.add(done);
    });
  }

  function sendRestore(hwnd, log) {
    if (!child || !child.stdin || child.stdin.destroyed) return false;
    try {
      restoreWaiters.push({ log });
      child.stdin.write(`restore ${hwnd}\n`);
      return true;
    } catch {
      restoreWaiters.pop();
      return false;
    }
  }

  // 账号开始发布时调用，返回"结束记录"的函数。
  function track(accountName, log, { enabled = true } = {}) {
    if (platform !== 'win32' || !enabled) return () => {};
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    active.set(accountName, log);
    if (!child) start();
    else if (last) log.info(`[前台窗口] 开始记录，当前最前面的窗口：${describeForeground(last)}`);
    return () => {
      if (active.get(accountName) !== log) return;
      active.delete(accountName);
      if (!active.size && child && !stopTimer) {
        // 发布结束后再多记一会儿：关窗口、移回收站这些收尾动作也可能抢前台。
        stopTimer = setTimeout(stop, graceMs);
        if (stopTimer.unref) stopTimer.unref();
      }
    };
  }

  // 打开比特窗口前调用：记下现在最前面的窗口；opened() 之后 windowMs 内，
  // 刚打开的比特窗口（或比特客户端、或这段时间里新启动的程序）抢到最前面就切回去。
  async function guardOpen(log, { enabled = true, windowMs = 30000, maxRestores = 5, readyTimeoutMs = 5000 } = {}) {
    if (platform !== 'win32' || !enabled || !child) return NOOP_GUARD;
    if (!(await ready(readyTimeoutMs)) || !last) return NOOP_GUARD;
    const original = last;
    if (original.hwnd === '0' || !original.pid || looksLikeBitBrowser(original)) {
      // 原来最前面就是比特自己的窗口（比如你正在看某个号），没有需要保护的窗口。
      return NOOP_GUARD;
    }
    const startedAt = now();
    let browserPid = null;
    let openedAt = null;
    let restores = 0;
    let finished = false;
    let expireTimer = null;
    const ignored = new Set();

    const isOurs = (fg) => {
      if (browserPid && fg.pid === browserPid) return true;
      if (looksLikeBitBrowser(fg)) return true;
      // 打开窗口这段时间里刚启动的新程序（比特内核进程号拿不到时的兜底）。
      const started = Date.parse(fg.started);
      return fg.pid !== original.pid && Number.isFinite(started) && started >= startedAt - 2000;
    };

    const guard = {
      evaluate(fg) {
        if (finished) return;
        if (openedAt !== null && now() > openedAt + windowMs) { guard.stop(); return; }
        if (!fg || fg.hwnd === '0' || fg.hwnd === original.hwnd) return;
        if (!isOurs(fg)) {
          // 打开结果出来之前信息不全，先不下结论；之后只记一次，方便排查。
          if (openedAt !== null && !ignored.has(fg.hwnd)) {
            ignored.add(fg.hwnd);
            log.info(`[防抢前台] 最前面变成了 ${describeForeground(fg)}，看起来不是比特浏览器，不处理`);
          }
          return;
        }
        if (restores >= maxRestores) return;
        restores += 1;
        log.info(`[防抢前台] 比特浏览器窗口抢到了最前面（${shortName(fg)}），正在切回原来的窗口：${shortName(original)}`);
        if (!sendRestore(original.hwnd, log)) log.warn('[防抢前台] 前台记录进程已退出，这次没法切回');
      },
      opened({ pid } = {}) {
        if (finished) return;
        browserPid = Number.isInteger(pid) && pid > 0 ? pid : null;
        openedAt = now();
        expireTimer = setTimeout(() => guard.stop(), windowMs);
        if (expireTimer.unref) expireTimer.unref();
        guard.evaluate(last);
      },
      stop() {
        if (finished) return;
        finished = true;
        if (expireTimer) clearTimeout(expireTimer);
        guards.delete(guard);
      },
    };
    guards.add(guard);
    return guard;
  }

  return { track, guardOpen, ready, stop, isRunning: () => Boolean(child) };
}
