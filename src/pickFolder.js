import { execFile } from 'node:child_process';

// "选择文件夹"对话框借 Windows 自带的 PowerShell 弹出，选中的路径通过标准输出传回给程序。
// PowerShell 默认按这台电脑的系统编码输出（中文 Windows 常见 GBK/936），Node 按 UTF-8 读，
// 两边对不上时中文路径就会变成乱码；有的电脑系统编码恰好是 UTF-8 所以不出问题。
// 这里强制 PowerShell 用不带 BOM 的 UTF-8 输出，结果与电脑的语言/编码设置无关，也不改系统设置。
export const PICK_FOLDER_SCRIPT =
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; ' +
  'Add-Type -AssemblyName System.Windows.Forms; ' +
  '$f = New-Object System.Windows.Forms.FolderBrowserDialog; ' +
  "if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }";

// 返回用户选中的文件夹路径；用户点了取消就返回 null。
export function pickFolder({ run = execFile } = {}) {
  return new Promise((resolve, reject) => {
    run('powershell.exe', ['-NoProfile', '-Command', PICK_FOLDER_SCRIPT], { timeout: 120000, encoding: 'utf8' }, (err, stdout) => {
      if (err) return reject(err);
      // 个别 PowerShell 版本仍会在开头带一个 BOM，去掉以免混进路径。
      const selected = String(stdout || '').replace(/^﻿/, '').trim();
      resolve(selected || null);
    });
  });
}
