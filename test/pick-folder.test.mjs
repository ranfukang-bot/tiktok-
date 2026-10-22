// "选择文件夹"在部分 Windows 电脑上把中文路径读成乱码：PowerShell 按系统编码输出，程序按 UTF-8 读。
// 这里守住两点：PowerShell 一定先切成 UTF-8 再输出路径；程序按 UTF-8 读、去掉可能出现的 BOM。
import test from 'node:test';
import assert from 'node:assert/strict';
import { PICK_FOLDER_SCRIPT, pickFolder } from '../src/pickFolder.js';

test('PowerShell 脚本在输出路径之前就把输出编码切成不带 BOM 的 UTF-8', () => {
  const setEncoding = PICK_FOLDER_SCRIPT.indexOf('[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false');
  const output = PICK_FOLDER_SCRIPT.indexOf('Write-Output $f.SelectedPath');
  assert.ok(setEncoding >= 0, '缺少 UTF-8 输出设置');
  assert.ok(output > setEncoding, '必须先设编码再输出路径');
});

test('按 UTF-8 读取 PowerShell 输出，中文路径原样返回，BOM 和换行被去掉', async () => {
  let seen;
  const run = (file, args, options, callback) => {
    seen = { file, args, options };
    callback(null, '\uFEFFC:\\Users\\ranfukang\\Desktop\\印尼1号机1号\r\n');
  };
  assert.equal(await pickFolder({ run }), 'C:\\Users\\ranfukang\\Desktop\\印尼1号机1号');
  assert.equal(seen.file, 'powershell.exe');
  assert.equal(seen.options.encoding, 'utf8');
  assert.deepEqual(seen.args, ['-NoProfile', '-Command', PICK_FOLDER_SCRIPT]);
});

test('用户点取消（没有输出）返回 null；PowerShell 出错则报错', async () => {
  assert.equal(await pickFolder({ run: (f, a, o, cb) => cb(null, '\r\n') }), null);
  await assert.rejects(pickFolder({ run: (f, a, o, cb) => cb(new Error('powershell 不可用'), '') }), /powershell 不可用/);
});
