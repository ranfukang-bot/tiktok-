// 墨西哥等站点：挂商品弹窗顶部有"我的店铺 / 橱窗商品"来源标签（TUXTabBar，id=1/2），默认停在"我的店铺"，
// 但商品是加在橱窗里的。东南亚没有这排标签（由 injected.test.mjs 里的原有商品用例覆盖，行为不变）。
// 结构仿照墨西哥真实页面：.TUXTabBar-item#1/#2 > button.TUXTabBar-itemTitle(--active)。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import pw from 'playwright-core';
import { installTkqInPage } from '../src/browser/injected.js';

let browser, page;
before(async () => {
  const executablePath = process.env.CHROMIUM_PATH || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(existsSync);
  browser = await pw.chromium.launch(executablePath ? { executablePath } : {});
  page = await browser.newPage();
});
after(async () => { await browser?.close(); });

const ID = '1737057459092423942';
const NAME = 'Zapatillas de algodón ultra gruesas';

async function mexicoPicker({ shop = [], showcase = [], brokenTabs = false } = {}) {
  await page.setContent('<style>[role="dialog"]{position:fixed;inset:10px;background:white;border:1px solid}' +
    'button{min-width:40px;min-height:25px}input{width:200px;height:24px}</style>' +
    '<div class="anchor-tag-container"><button><span data-icon="Plus">+</span>Agregar</button></div>');
  await page.evaluate(({ shop, showcase, brokenTabs, NAME }) => {
    window.searches = []; window.tabClicks = []; window.radioPicks = [];
    const lists = { 1: shop, 2: showcase };
    const button = (type) => '<button class="TUXButton--' + type + '">btn</button>';
    const footer = () => '<div class="common-modal-footer">' + button('secondary') + button('primary') + '</div>';
    const show = (cls, html) => {
      const el = document.createElement('div'); el.className = 'TUXModal common-modal ' + cls;
      el.setAttribute('role', 'dialog'); el.innerHTML = html; document.body.append(el); return el;
    };
    const tabItem = (id, label, active) => '<div class="TUXTabBar-item" id="' + id + '">' +
      (brokenTabs && id === '2' ? '<span>' + label + '</span>' :
        '<button class="TUXTabBar-itemTitle' + (active ? ' TUXTabBar-itemTitle--active' : '') + '" type="button" id="' + id + '"><div>' + label + '</div></button>') +
      '</div>';
    document.querySelector('.anchor-tag-container button').onclick = () => {
      const type = show('', '<div class="anchor-modal"><button role="combobox" aria-label="33">Productos</button><div class="button-group">' + button('secondary') + button('primary') + '</div></div>');
      type.querySelector('.TUXButton--primary').onclick = () => {
        type.classList.add('no-mask-modal');
        const select = show('product-selector-modal', '<div class="product-selector-container">' +
          '<div class="TUXTabBar"><div aria-orientation="horizontal" style="display:flex">' +
          tabItem('1', 'Mi tienda', true) + tabItem('2', 'Productos del escaparate', false) + '</div></div>' +
          '<div class="product-search-input"><input type="text"></div><button class="product-search-icon">?</button>' +
          '<table class="product-table"><tbody></tbody></table></div>' + footer());
        const next = select.querySelector('.TUXButton--primary'); next.disabled = true;
        let activeTab = '1';
        const render = (ids) => {
          select.querySelector('tbody').innerHTML = ids.map((id) =>
            '<tr><td><input type="radio" data-id="' + id + '"><span class="product-name">' + NAME + '</span></td><td class="product-tb-cell">' + id + '</td></tr>').join('');
          select.querySelectorAll('input[type=radio]').forEach((radio) => {
            radio.onchange = () => { window.radioPicks.push(radio.dataset.id); next.disabled = false; };
          });
        };
        render([]); // 默认"我的店铺"在搜索前是空表
        select.querySelectorAll('button.TUXTabBar-itemTitle').forEach((btn) => {
          btn.onclick = () => {
            window.tabClicks.push(btn.id);
            activeTab = btn.id;
            select.querySelectorAll('button.TUXTabBar-itemTitle').forEach((b) =>
              b.classList.toggle('TUXTabBar-itemTitle--active', b.id === activeTab));
            select.querySelector('tbody').innerHTML = '';
            setTimeout(() => render(lists[activeTab]), 150); // 切换后列表异步加载
          };
        });
        select.querySelector('.product-search-icon').onclick = () => {
          const query = select.querySelector('.product-search-input input').value;
          window.searches.push({ tab: activeTab, query });
          select.querySelector('tbody').innerHTML = '';
          setTimeout(() => render(lists[activeTab].filter((id) => id === query)), 200);
        };
        next.onclick = () => {
          select.remove();
          const name = show('', '<div class="common-modal-body"><input type="text"><div class="TUXFormField-wordCount">12/30</div></div>' + footer());
          name.querySelector('input').value = NAME.slice(0, 30);
          name.querySelector('.TUXButton--primary').onclick = () => {
            const finalName = name.querySelector('input').value.trim();
            type.remove(); name.remove();
            const anchor = document.createElement('div'); anchor.className = 'anchor-container';
            anchor.innerHTML = '<span class="content-anchor-label">' + finalName + '</span>'; document.body.append(anchor);
          };
        };
      };
    };
  }, { shop, showcase, brokenTabs, NAME });
  await page.evaluate(installTkqInPage, { text: {}, hashtagKeywords: ['fyp'] });
}

test('墨西哥：默认停在"我的店铺"，商品在橱窗里 → 先切到橱窗标签(id=2)再按精确ID搜索并挂上', async () => {
  await mexicoPicker({ shop: [], showcase: ['1736380890936411472', ID, '1735782764922701258'] });
  const result = await page.evaluate((id) => window.__tkq.addProductLink(id), ID);
  assert.equal(result.productId, ID);
  assert.equal(result.anchorName, NAME.slice(0, 30).trim());
  assert.deepEqual(await page.evaluate(() => window.tabClicks), ['2']);
  assert.deepEqual(await page.evaluate(() => window.searches), [{ tab: '2', query: ID }], '应直接在橱窗标签搜索，不先在我的店铺空等');
  assert.deepEqual(await page.evaluate(() => window.radioPicks), [ID]);
});

test('橱窗标签里没有、"我的店铺"里有 → 依次换标签，仍只按精确ID挂上', async () => {
  await mexicoPicker({ shop: [ID], showcase: ['1736380890936411472'] });
  const result = await page.evaluate((id) => window.__tkq.addProductLink(id), ID);
  assert.equal(result.productId, ID);
  assert.deepEqual((await page.evaluate(() => window.searches)).map((s) => s.tab), ['2', '1']);
  assert.deepEqual(await page.evaluate(() => window.radioPicks), [ID]);
});

test('两个标签都搜不到 → 报"未找到精确商品ID"，不选任何商品', async () => {
  await mexicoPicker({ shop: [], showcase: ['1736380890936411472'] });
  await assert.rejects(page.evaluate((id) => window.__tkq.addProductLink(id), ID), /未找到精确商品ID/);
  assert.deepEqual(await page.evaluate(() => window.radioPicks), []);
  assert.equal(await page.locator('.anchor-container').count(), 0);
});

test('来源标签结构不认识（缺少按钮）→ 停下报页面结构不受支持，不乱点', async () => {
  await mexicoPicker({ showcase: [ID], brokenTabs: true });
  await assert.rejects(page.evaluate((id) => window.__tkq.addProductLink(id), ID), /页面结构不受支持：商品来源标签/);
  assert.deepEqual(await page.evaluate(() => window.searches), []);
  assert.deepEqual(await page.evaluate(() => window.radioPicks), []);
});
