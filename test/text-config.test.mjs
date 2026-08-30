// 界面文案合并规则的回归测试。
//
// 这里守的是两条底线，一条都不能破：
//   1. 现有印尼账号零改动继续工作（用户机器上的 settings.json 是"创建时那个形状"，
//      缺后来新增的键，必须靠默认值层兜住）。
//   2. 换了语言的账号【绝不】继承印尼语的安全文案。继承了的话，它会拿着印尼语的
//      "版权有问题"去英文界面上找，永远匹配不上 → 每条视频都"检测通过" →
//      保护静默关掉，而且校验还会显示一切正常。
//
// 全部是纯函数，不读写 config/ 下的任何文件，跑它不会动你的真实配置。
import {
  resolveText, findMissingRequiredText, DEFAULT_PAGE_TEXT,
  TEXT_PRESETS, REQUIRED_TEXT_KEYS, SAFETY_CRITICAL_TEXT_KEYS,
} from '../src/config.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra); }
};

// 模拟用户机器上【已存在的、缺新键的】老 settings.json —— 最重要的回归场景
const OLD_SETTINGS = { text: {
  nextButton: 'Berikutnya', searchProductPlaceholder: 'Cari produk',
  publishNowRadioLabel: 'Sekarang', addProductButton: 'Tambah',
  aiDisclosureLabel: 'Konten yang dihasilkan AI',
  productConfirmButtons: ['Berikutnya', 'Tambah', 'Tambahkan', 'Konfirmasi', 'Simpan'],
  showMoreButtons: ['Tampilkan lebih banyak', 'Tampilkan lainnya'],
  postButtonTexts: ['Posting', 'Post'],
} };

console.log('\n[1] 老 settings.json + 老印尼账号(无 textPreset) —— 必须零改动继续工作');
{
  const acct = { name: '印尼老号' };
  const t = resolveText(OLD_SETTINGS, acct);
  ok('violationMarkers 从默认值层兜底', JSON.stringify(t.violationMarkers) === JSON.stringify(DEFAULT_PAGE_TEXT.violationMarkers));
  ok('productModalMarkers 兜底', JSON.stringify(t.productModalMarkers) === JSON.stringify(DEFAULT_PAGE_TEXT.productModalMarkers));
  ok('appCrashMarkers 兜底', JSON.stringify(t.appCrashMarkers) === JSON.stringify(DEFAULT_PAGE_TEXT.appCrashMarkers));
  ok('必填项齐全，不拦', findMissingRequiredText(OLD_SETTINGS, acct).length === 0);
}

console.log('\n[2] 显式 textPreset:"id" —— 同语言，仍继承全局 settings.text');
{
  const acct = { name: '印尼号', textPreset: 'id', textOverrides: { nextButton: 'Lanjut' } };
  const t = resolveText(OLD_SETTINGS, acct);
  ok('账号自己的覆盖生效', t.nextButton === 'Lanjut');
  ok('仍继承默认层的安全项', t.violationMarkers.length === 3);
  ok('不拦', findMissingRequiredText(OLD_SETTINGS, acct).length === 0);
}

console.log('\n[3] 英文账号 —— 绝不能静默继承印尼语安全项');
{
  const acct = { name: '英文号', textPreset: 'en' };
  const t = resolveText(OLD_SETTINGS, acct);
  ok('nextButton 用英文预设', t.nextButton === 'Next');
  ok('没有继承印尼语 violationMarkers', t.violationMarkers === undefined, JSON.stringify(t.violationMarkers));
  ok('没有继承印尼语 productModalMarkers', t.productModalMarkers === undefined, JSON.stringify(t.productModalMarkers));
  ok('没有从 settings.text 漏进印尼语 postButtonTexts', JSON.stringify(t.postButtonTexts) === JSON.stringify(['Post']));
  const miss = findMissingRequiredText(OLD_SETTINGS, acct).sort();
  ok('必须被拦住，且缺的正好是两个安全项',
    JSON.stringify(miss) === JSON.stringify(['productModalMarkers', 'violationMarkers']), JSON.stringify(miss));
}

console.log('\n[4] 英文账号补齐安全项后 —— 应放行');
{
  const acct = { name: '英文号', textPreset: 'en', textOverrides: {
    violationMarkers: ['Copyright issue found'], productModalMarkers: ['Add link'] } };
  ok('不再被拦', findMissingRequiredText(OLD_SETTINGS, acct).length === 0);
  ok('安全项用的是账号自己填的', resolveText(OLD_SETTINGS, acct).violationMarkers[0] === 'Copyright issue found');
}

console.log('\n[5] custom 预设 —— 什么都不继承，全部自己填');
{
  const acct = { name: '越南号', textPreset: 'custom' };
  ok('一个印尼语都没漏进来', Object.keys(resolveText(OLD_SETTINGS, acct)).length === 0);
  ok('必填项全部报缺', findMissingRequiredText(OLD_SETTINGS, acct).length === REQUIRED_TEXT_KEYS.length);
}

console.log('\n[6] 手改配置写了个不存在的预设名 —— 不能拿印尼语兜底');
{
  const acct = { name: '乱写', textPreset: 'zh-TW' };
  ok('不继承任何默认值', Object.keys(resolveText(OLD_SETTINGS, acct)).length === 0);
  ok('被拦住', findMissingRequiredText(OLD_SETTINGS, acct).length > 0);
}

console.log('\n[7] 显式清空 —— 空值不能反过来"覆盖"成有值');
{
  const acct = { name: 'x', textPreset: 'id', textOverrides: { violationMarkers: [], searchProductPlaceholder: '' } };
  const t = resolveText(OLD_SETTINGS, acct);
  // 空值覆盖会让 includes('') 恒真、findClickableByText('') 点到随便一个空元素
  ok('空值被忽略、继续继承', t.violationMarkers.length === 3 && t.searchProductPlaceholder === 'Cari produk');
}

console.log('\n[8] 全局也换成英文时 —— 同语言的账号才继承 settings.text');
{
  const S = { textPreset: 'en', text: { violationMarkers: ['Copyright issue found'], productModalMarkers: ['Add link'] } };
  ok('英文账号继承全局英文文案', findMissingRequiredText(S, { name: 'a', textPreset: 'en' }).length === 0);
  ok('印尼账号反过来不继承全局英文', findMissingRequiredText(S, { name: 'b', textPreset: 'id' }).length === 0);
  ok('印尼账号拿到的是印尼语', resolveText(S, { name: 'b', textPreset: 'id' }).violationMarkers[0].includes('hak cipta'));
}

console.log('\n[9] 预设本身的自检');
{
  ok('id 预设就是 DEFAULT_PAGE_TEXT', TEXT_PRESETS.id.text === DEFAULT_PAGE_TEXT);
  ok('en 预设不含编造的安全项(留空是故意的)',
    TEXT_PRESETS.en.text.violationMarkers.length === 0 && TEXT_PRESETS.en.text.productModalMarkers.length === 0);
  ok('安全项都在必填清单里', SAFETY_CRITICAL_TEXT_KEYS.every((k) => REQUIRED_TEXT_KEYS.includes(k)));
  ok('必填清单里的键在印尼语默认值里都有非空值', REQUIRED_TEXT_KEYS.every((k) => {
    const v = DEFAULT_PAGE_TEXT[k]; return Array.isArray(v) ? v.length > 0 : Boolean(v);
  }));
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
