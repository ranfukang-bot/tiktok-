import { execFile } from 'node:child_process';

// 把文件送进回收站，而不是永久删除——万一删错了还能从回收站捞回来。
// 目前只在 Windows 上实现（用户的运行环境是 Windows）；其它系统上直接拒绝，
// 调用方看到失败就不会删文件，而不是退化成 fs.unlink 永久删除——那样就
// 违背了"要有退路"这个初衷。
export function moveToTrash(absolutePath) {
  if (process.platform !== 'win32') {
    return Promise.reject(
      new Error(`当前系统(${process.platform})暂不支持"移到回收站"，为了安全没有执行永久删除，请手动清理这个文件`)
    );
  }
  return new Promise((resolve, reject) => {
    // PowerShell字符串字面量里的单引号要写成两个单引号转义
    const psPath = absolutePath.replace(/'/g, "''");
    const script =
      'Add-Type -AssemblyName Microsoft.VisualBasic; ' +
      `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${psPath}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
    // 用 -EncodedCommand 而不是 -Command 直接拼字符串，绕开Windows那一层shell/cmd的
    // 参数转义坑，路径里有空格、括号这些常见字符都不用担心。
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message || '').trim() || 'PowerShell执行失败'));
        resolve();
      }
    );
  });
}
