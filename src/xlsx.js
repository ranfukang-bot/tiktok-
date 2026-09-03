// 极简 xlsx 读取器：只做"把表格读成二维数组"这一件事。
//
// 为什么不用 SheetJS 这类现成库：我们只读 fastmoss 导出的这一种表，格式固定，
// 而 xlsx 本质就是 zip + XML，用 Node 自带的 zlib 就够了。少一个第三方依赖，
// 就少一处会因为版本升级、供应链问题而坏掉的地方——这个工具是给非技术用户
// 双击就用的，装不上依赖对他来说等于工具坏了。
//
// 代价是不支持公式、日期序列号转换、多工作表这些——我们也不需要。
// 遇到读不懂的文件会明确抛错，而不是给出一份错的数据。

import { inflateRawSync } from 'node:zlib';

// 从 zip 的中央目录读文件列表。不用顺序扫本地文件头，那种做法遇到
// 带数据描述符(streaming 写出)的 zip 会错位。
function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  if (eocd < 0) throw new Error('这个文件不是有效的 Excel(.xlsx) 文件');

  const count = buf.readUInt16LE(eocd + 10);
  const files = {};
  let p = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Excel 文件内部结构损坏，无法读取');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // 本地文件头里的 extra 长度经常跟中央目录里的不一样，必须按本地头重新算起点
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    files[name] = method === 0 ? raw : inflateRawSync(raw);

    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&'); // &amp; 必须最后处理，否则会把 &amp;lt; 二次解码
}

/**
 * 读第一个工作表，返回二维数组（第一行是表头）。
 * @param {Buffer} buf .xlsx 文件内容
 */
export function readSheet(buf) {
  const files = unzip(buf);

  // 字符串在 xlsx 里是共享的：单元格存的是下标，真正的文字在 sharedStrings 里
  const shared = [];
  const sst = files['xl/sharedStrings.xml'];
  if (sst) {
    for (const si of sst.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      // 一个 si 里可能有多段 <t>(富文本分段)，拼起来才是完整内容
      shared.push([...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1])).join(''));
    }
  }

  const sheetPath = Object.keys(files).find((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  if (!sheetPath) throw new Error('Excel 文件里没有找到工作表');
  const xml = files[sheetPath].toString('utf8');

  const rows = [];
  for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const c of row[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)) {
      // 按单元格地址(A/B/…/AA)定位列号，不能按出现顺序——空单元格在 XML 里是直接跳过的
      let col = 0;
      for (const ch of c[1]) col = col * 26 + (ch.charCodeAt(0) - 64);

      const inline = (c[3].match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1];
      const v = (c[3].match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      cells[col - 1] = inline !== undefined
        ? unescapeXml(inline)
        : v === undefined
          ? null
          : /t="s"/.test(c[2]) ? shared[Number(v)] : v;
    }
    rows.push(cells);
  }

  if (!rows.length) throw new Error('这个 Excel 文件是空的');
  return rows;
}
