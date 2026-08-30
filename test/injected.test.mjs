// 注入脚本(src/browser/injected.js)在真实浏览器里的行为测试。
//
// 重点是几个"静默失效"的坑 —— 它们出问题时从外部行为上完全看不出来：
//   · 空配置注入不能抛错（抛在发布点击之后会被判成"发布结果不确定"，
//     视频其实发成功了，账号却被暂停并推送通知）
//   · 空列表的崩溃检测不能恒为真（[].every() 恒真，会让每轮第一次等待就误报崩溃）
//   · 商品弹窗闸门没配文案时必须【停下】，不能"检测不到就当没弹窗"往下点
//
// 需要一个本地 Chromium。没有的话会跳过（用户机器上通常没有——那边是靠 CDP
// 连指纹浏览器的，不下载浏览器），不算失败。
import pw from 'playwright-core';
import { installTkqInPage } from '../src/browser/injected.js';
import { resolveText, DEFAULT_PAGE_TEXT } from '../src/config.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra); }
};

let browser;
try {
  browser = await pw.chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
  );
} catch (err) {
  console.log('⏭️  跳过：本机没有可用的 Chromium。');
  console.log('   （需要的话装一个再跑：npx playwright install chromium，或用 CHROMIUM_PATH 指定路径）');
  console.log('   原因:', err.message.split('\n')[0]);
  process.exit(0);
}

const page = await browser.newPage();
await page.setContent('<body><div>正常页面，什么提示都没有</div></body>');

console.log('\n[1] 空配置注入 —— 绝不能抛错');
{
  let threw = null;
  try { await page.evaluate(installTkqInPage, {}); } catch (e) { threw = e.message; }
  ok('installTkqInPage({}) 不抛错', threw === null, threw || '');
  ok('window.__tkq 装上了', await page.evaluate(() => typeof window.__tkq === 'object'));
}

console.log('\n[2] 空配置 —— 崩溃检测不能误报');
{
  const r = await page.evaluate(() => {
    try { window.__tkq.checkForAppCrash(); return 'no-crash'; } catch (e) { return 'THREW: ' + e.message; }
  });
  ok('正常页面不误报崩溃', r === 'no-crash', r);
}

console.log('\n[3] 空配置 —— 商品弹窗闸门必须"停下"而不是"放行"');
{
  const r = await page.evaluate(() => {
    try { window.__tkq.assertProductPickerClosed('点击Posting'); return 'PASSED-THROUGH'; } catch (e) { return e.message; }
  });
  ok('抛出了明确的配置缺失错误', r.includes('界面文案配置缺失') && r.includes('商品弹窗'), r);
  ok('绝对没有静默放行', r !== 'PASSED-THROUGH');
}

console.log('\n[4] 印尼语完整配置 —— 行为跟改动前一致');
await page.evaluate(installTkqInPage, { text: resolveText({}, {}) });
{
  ok('闸门不再报配置缺失', await page.evaluate(() => {
    try { window.__tkq.assertProductPickerClosed('x'); return true; } catch (e) { return e.message; }
  }) === true);

  // 崩溃检测是"两个词都出现才算"，不是"任一出现"——单独一个"Ada masalah"
  // 很容易出现在别的提示里，会误判成页面崩溃
  await page.evaluate(() => { document.body.innerHTML = '<div>Ada masalah dengan koneksi</div>'; });
  ok('只命中一个词不算崩溃', await page.evaluate(() => {
    try { window.__tkq.checkForAppCrash(); return true; } catch (e) { return e.message; }
  }) === true);

  await page.evaluate(() => { document.body.innerHTML = '<div>Ada masalah</div><button>Coba lagi</button>'; });
  const r = await page.evaluate(() => {
    try { window.__tkq.checkForAppCrash(); return 'NOT-DETECTED'; } catch (e) { return e.message; }
  });
  ok('两个词都命中才报崩溃', r.includes('TikTok页面自己崩溃'), r);

  // Chrome 的 innerText 会把 CSS text-transform 算进去，TikTok 有按钮是用CSS转大写的
  await page.evaluate(() => {
    document.body.innerHTML = '<div style="text-transform:uppercase">ada masalah</div><button>COBA LAGI</button>';
  });
  ok('大小写无关', (await page.evaluate(() => {
    try { window.__tkq.checkForAppCrash(); return 'NOT-DETECTED'; } catch (e) { return e.message; }
  })).includes('崩溃'));
}

console.log('\n[5] 英文账号 —— 认英文界面，且证明换语言必须重配');
{
  const enText = resolveText({}, { textPreset: 'en', textOverrides: {
    violationMarkers: ['Copyright issue found'], productModalMarkers: ['Add link'] } });
  await page.evaluate(() => {
    document.body.innerHTML =
      '<div role="dialog" style="width:200px;height:100px"><h2>Add link</h2><input placeholder="Search products"></div>';
  });
  await page.evaluate(installTkqInPage, { text: enText });
  const r1 = await page.evaluate(() => {
    try { window.__tkq.assertProductPickerClosed('点击Posting'); return 'PASSED-THROUGH'; } catch (e) { return e.message; }
  });
  ok('英文弹窗被认出来并拦住', r1.includes('商品流程弹窗仍然打开'), r1);
  ok('用的不是印尼语文案', !JSON.stringify(enText).includes('Tambah tautan'));

  // 反向对照：印尼语配置面对同一个英文弹窗认不出来。
  // 这正是"跨语言必须重新配、不能靠默认值兜底"的证明。
  await page.evaluate(installTkqInPage, { text: resolveText({}, {}) });
  const r2 = await page.evaluate(() => {
    try { window.__tkq.assertProductPickerClosed('x'); return 'PASSED-THROUGH'; } catch (e) { return e.message; }
  });
  ok('印尼语配置认不出英文弹窗', r2 === 'PASSED-THROUGH', r2);
}

console.log('\n[6] 文案里含引号/反斜杠 —— 不能让 querySelector 抛 SyntaxError');
{
  await page.evaluate(installTkqInPage, { text: { ...DEFAULT_PAGE_TEXT, searchProductPlaceholder: 'Ara "ürün" \\ ara' } });
  await page.evaluate(() => { document.body.innerHTML = '<div>正常页面</div>'; });
  const r = await page.evaluate(() => {
    try { window.__tkq.assertProductPickerClosed('x'); return 'ok'; } catch (e) { return e.message; }
  });
  ok('特殊字符不炸', r === 'ok', r);
}

await browser.close();
console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
