// 中文 Windows（GBK 代码页）上，.bat 里"chcp 65001 + UTF-8 中文"会让 cmd 读错行：
// 焦点检测的 bat 曾把 "cd /d" 读成 "/d"，中文提示也被拆成乱码命令。这里守住：
// 检测工具的 bat 只用英文字符、不切代码页、不依赖当前目录；.bat 检出时用 CRLF。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bat = readFileSync(new URL('../diagnostics/focus-check.bat', import.meta.url), 'latin1');

test('焦点检测 bat 只含英文字符，不切代码页，按自身位置启动脚本', () => {
  assert.ok(/^[\x00-\x7f]*$/.test(bat), 'bat 里不能有中文或其它非 ASCII 字符');
  const commands = bat.split(/\r?\n/).filter((line) => !/^\s*rem\b/i.test(line)).join('\n');
  assert.ok(!/chcp/i.test(commands), '不要在 bat 里切代码页');
  assert.ok(bat.includes('node "%~dp0focus-steal-check.mjs"'), '应按 bat 自身所在目录启动脚本');
});

test('.gitattributes 规定 .bat 检出为 CRLF', () => {
  const attrs = readFileSync(new URL('../.gitattributes', import.meta.url), 'utf8');
  assert.match(attrs, /^\*\.bat\s+text\s+eol=crlf\s*$/m);
});
