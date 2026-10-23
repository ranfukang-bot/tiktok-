// 自检："前台窗口记录"在这台 Windows 电脑上能不能用。
// 用法（在项目文件夹里）：node diagnostics/foreground-watch-check.mjs
// 运行 15 秒，启动后会先打印一次当前最前面的窗口；期间切换几个窗口，每次切换都应打印一行。
// 至少打印出 1 行就说明记录功能正常；一行都没有时会把 PowerShell 的报错原样打出来。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { FOREGROUND_WATCH_SCRIPT, parseForegroundLine, describeForeground } from '../src/foregroundWatch.js';

if (process.platform !== 'win32') {
  console.log('这个自检只能在 Windows 上运行。');
  process.exit(1);
}

const encoded = Buffer.from(FOREGROUND_WATCH_SCRIPT, 'utf16le').toString('base64');
const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
  windowsHide: true,
  // 标准输入必须是管道：脚本发现标准输入断开就会自己退出。
  stdio: ['pipe', 'pipe', 'pipe'],
});
proc.stdout.setEncoding('utf8');
proc.stderr.setEncoding('utf8');

let count = 0;
let errorText = '';
createInterface({ input: proc.stdout }).on('line', (line) => {
  const fg = parseForegroundLine(line);
  if (fg && fg.event === 'foreground') {
    count += 1;
    console.log(`${new Date().toLocaleTimeString()}  ${describeForeground(fg)}`);
  } else if (line.trim()) {
    console.log(`（无法识别的输出）${line}`);
  }
});
proc.stderr.on('data', (chunk) => { errorText += chunk; });
proc.on('error', (err) => { errorText += `启动 PowerShell 失败：${err.message}\n`; });

console.log('前台窗口记录自检：运行 15 秒，期间可以随便点几个不同的窗口……');
setTimeout(() => {
  proc.kill();
  console.log('');
  console.log(count > 0
    ? `正常：记录到 ${count} 次前台窗口（包括启动时的当前窗口）。`
    : '异常：一次都没记录到，前台窗口记录在这台电脑上没生效。');
  if (errorText.trim()) console.log(`PowerShell 报错：\n${errorText.trim()}`);
  process.exit(0);
}, 15000);
