import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// 前台窗口记录（只在 Windows 上工作）。
//
// 用户反馈：打游戏时自动发布还是会把游戏切出去。在干净 Chrome 上逐个动作测过，
// 清标题、点话题这些页面操作都抢不到前台（连旧的 bringToFront 都被 Windows 拦下了），
// 所以抢前台的多半是页面之外的东西：指纹浏览器客户端、新开的窗口、一闪而过的命令行窗口……
// 光靠猜定位不了，这里在真实发布时把"最前面的窗口"每次变化都记进正在发布的账号日志：
// 哪个程序、窗口标题、程序位置、发生时间。被切出游戏后翻日志，看紧挨着的那一步就知道是谁。
//
// 实现：发布期间开一个隐藏的 PowerShell，每 250 毫秒问一次 Windows 最前面的窗口是谁，
// 变了才输出一行 JSON。没有账号在发布时过一会儿自动退出，不常驻。
// 结论：抢前台的是比特浏览器打开环境窗口的那一刻（比特客户端的行为）。用户不需要自动切回，
// 所以这里只保留记录功能，默认关闭；以后要排查时在 settings.json 里设 "foregroundWatch": true 开启。

export const FOREGROUND_WATCH_SCRIPT = [
  // 先把输出切成不带 BOM 的 UTF-8，否则中文窗口标题在中文 Windows 上会变乱码（同选择文件夹那次）。
  'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}',
  "$sig = '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); " +
    "[DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); " +
    "[DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);'",
  'Add-Type -MemberDefinition $sig -Name W -Namespace TkqForeground',
  "$last = ''",
  // 注意：$pid 是 PowerShell 自带的只读变量（自己的进程号），不能拿来存别的进程号。
  'while ($true) { ' +
    '$h = [TkqForeground.W]::GetForegroundWindow(); ' +
    '[uint32]$fgPid = 0; ' +
    '[void][TkqForeground.W]::GetWindowThreadProcessId($h, [ref]$fgPid); ' +
    '$key = "$h|$fgPid"; ' +
    'if ($key -ne $last) { ' +
      '$last = $key; ' +
      '$sb = New-Object System.Text.StringBuilder 512; ' +
      '[void][TkqForeground.W]::GetWindowText($h, $sb, 512); ' +
      '$p = Get-Process -Id $fgPid -ErrorAction SilentlyContinue; ' +
      '$o = [ordered]@{ hwnd = [string]$h; pid = [int]$fgPid; name = [string]$p.ProcessName; title = $sb.ToString(); path = [string]$p.Path }; ' +
      '[Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); ' +
      '[Console]::Out.Flush() ' +
    '}; ' +
    'Start-Sleep -Milliseconds 250 ' +
  '}',
].join('; ');

export function parseForegroundLine(line) {
  const text = String(line || '').replace(/^﻿/, '').trim();
  if (!text.startsWith('{')) return null;
  try {
    const o = JSON.parse(text);
    return {
      hwnd: String(o.hwnd ?? ''),
      pid: Number(o.pid) || 0,
      name: String(o.name || ''),
      title: String(o.title || ''),
      path: String(o.path || ''),
    };
  } catch {
    return null;
  }
}

export function describeForeground(fg) {
  if (!fg || fg.hwnd === '0' || (!fg.pid && !fg.name)) return '没有任何窗口在最前面（通常是正在切换窗口）';
  const name = fg.name || `进程号${fg.pid}`;
  const title = fg.title ? `「${fg.title}」` : '（无标题）';
  const where = fg.path ? `，程序位置：${fg.path}` : '';
  return `${name}${title}${where}`;
}

export function createForegroundWatch({
  platform = process.platform,
  spawnImpl = spawn,
  graceMs = 60000,
  fallbackLog = null,
} = {}) {
  const active = new Map(); // 账号名 -> 日志
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

  function start() {
    const encoded = Buffer.from(FOREGROUND_WATCH_SCRIPT, 'utf16le').toString('base64');
    let proc;
    try {
      proc = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return; // 记录只是辅助排查，起不来也绝不影响发布
    }
    child = proc;
    last = null;
    proc.on('error', () => { if (child === proc) child = null; });
    proc.on('exit', () => { if (child === proc) child = null; });
    if (proc.stdout && proc.stdout.setEncoding) proc.stdout.setEncoding('utf8');
    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const fg = parseForegroundLine(line);
      if (!fg) return;
      last = fg;
      report(fg);
    });
  }

  function stop() {
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    if (child) {
      const proc = child;
      child = null;
      try { proc.kill(); } catch { /* 已经退出 */ }
    }
    last = null;
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

  return { track, stop, isRunning: () => Boolean(child) };
}
