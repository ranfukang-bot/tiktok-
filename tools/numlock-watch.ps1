# 数字锁(NumLock)状态监控
#
# 用途：搞清楚"键盘数字锁自己变了"到底是谁干的。
# 每 0.5 秒读一次数字锁状态，一旦发生变化，就把【时间】和【当时的前台窗口标题】
# 记到 state\numlock.log 里。
#
# 它只【读】状态，不会去按任何键，也不会改你的键盘设置。
# 关掉这个窗口就停止。
#
# 怎么看结果：把日志里的翻转时间，和控制台里发布视频的时间对一下。
#   - 时间对不上（发布的时候不翻，不发布的时候反而翻）  -> 跟发布程序无关
#   - 每次翻转时前台窗口都是某个远程控制/虚拟机窗口     -> basically 就是它了
#   - 完全没规律，且窗口五花八门                        -> 优先怀疑键盘硬件/无线接收器

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms

# 取当前前台窗口的标题，用来判断翻转发生时你正在用什么
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FgWin {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  public static string Title() {
    StringBuilder sb = new StringBuilder(512);
    GetWindowText(GetForegroundWindow(), sb, 512);
    return sb.ToString();
  }
}
"@

$logDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'state'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir 'numlock.log'

function Read-NumLock {
  [System.Windows.Forms.Control]::IsKeyLocked([System.Windows.Forms.Keys]::NumLock)
}

function Write-Line([string]$text) {
  Write-Host $text
  Add-Content -Path $logFile -Value $text -Encoding UTF8
}

$state = Read-NumLock
$label = if ($state) { '开(能打数字)' } else { '关(打不出数字)' }

Write-Line ''
Write-Line "===== 开始监控 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') 当前状态：$label ====="
Write-Host  "日志文件：$logFile"
Write-Host  '让这个窗口一直开着。数字锁自己变了的时候，这里会打印一行。按 Ctrl+C 或直接关窗口即可停止。'
Write-Host  ''

while ($true) {
  Start-Sleep -Milliseconds 500
  $now = Read-NumLock
  if ($now -ne $state) {
    $state = $now
    $to = if ($now) { '开(能打数字)' } else { '关(打不出数字)' }
    $title = ''
    try { $title = [FgWin]::Title() } catch { $title = '(读不到窗口标题)' }
    if ([string]::IsNullOrWhiteSpace($title)) { $title = '(无标题窗口/桌面)' }
    Write-Line "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  数字锁变成了 $to   当时的前台窗口：$title"
  }
}
