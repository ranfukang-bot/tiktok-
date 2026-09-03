// 匿名本地浏览器夹具，不连接账号，不包含真实快照/商品数据。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import pw from 'playwright-core';
import { installTkqInPage } from '../src/browser/injected.js';

let browser, page;
before(async () => {
  const executablePath = process.env.CHROMIUM_PATH || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(existsSync);
  // 独立临时profile，不读取/关闭用户浏览器。启动失败算失败，不静默跳过测试。
  browser = await pw.chromium.launch(executablePath ? { executablePath } : {});
  page = await browser.newPage();
});
after(async () => { await browser?.close(); });

const switchHtml = '<div data-state="checked"><input role="switch" type="checkbox" checked></div>';
const resultHtml = '<div class="status-wrapper">' +
  '<div class="status-result status-checking" data-show="false"><span class="spinning">…</span><span class="status-tip">任意语言</span></div>' +
  '<div class="status-result status-warn" data-show="false"><span class="status-tip" style="color:var(--ui-text-danger)">任意语言</span></div>' +
  '<div class="status-result status-ready" data-show="false">任意语言</div>' +
  '<div class="status-result status-success" data-show="true"><span class="status-tip" style="color:var(--ui-text-success)">任意语言</span></div></div>';

async function fresh() {
  await page.setContent('<style>:root{--ui-text-danger:red;--ui-text-success:green;--ui-text-warning:orange}' +
    '[data-show="false"]{display:none}.info-progress{height:4px}.collapsed+.options-form{display:none}' +
    '[role="dialog"]{position:fixed;inset:10px;background:white;border:1px solid}button{min-width:40px;min-height:25px}</style>' +
    '<div data-e2e="upload_status_container"><div class="info-status success">任意语言</div><div class="info-progress success" style="width:100%"></div></div>' +
    '<div class="caption-editor"><div contenteditable="true">#fyp #tiktok #tiktokshop</div></div>' +
    '<div class="anchor-tag-container"><button><span data-icon="Plus">+</span>任意语言</button></div>' +
    '<div data-e2e="advanced_settings_container" class="more-collapse"><div class="more-btn">任意语言</div></div>' +
    '<div class="options-form"><div data-e2e="aigc_container">' + switchHtml + '</div><div data-e2e="disclose_content_container"><input type="checkbox"></div></div>' +
    '<div data-e2e="schedule_container"><input type="radio" name="postSchedule" value="schedule"><input type="radio" name="postSchedule" value="post_now" checked></div>' +
    '<div class="checks-root"><div class="copyright-check"><div data-e2e="copyright_container">' + switchHtml + '</div>' + resultHtml +
    '</div><div class="content-check__divider"></div><div class="content-check">' + switchHtml + resultHtml + '</div></div>' +
    '<button data-e2e="post_video_button">任意语言</button>');
  await page.evaluate(() => {
    window.postClicks = 0; window.aiConfirmed = false;
    document.querySelector('[data-e2e="post_video_button"]').onclick = () => { window.postClicks++; };
  });
  await page.evaluate(installTkqInPage, { text: {}, hashtagKeywords: ['fyp', 'tiktok', 'tiktokshop'] });
}

async function setState(area, state) {
  await page.evaluate(([area, state]) => {
    const root = document.querySelector(area === 'music' ? '.copyright-check' : '.content-check');
    root.querySelectorAll('.status-result').forEach((el) => { el.dataset.show = String(el.classList.contains('status-' + state)); });
  }, [area, state]);
}

async function mockProductWorkflow() {
  await page.evaluate(() => {
    const button = (type) => '<button class="TUXButton--' + type + '">任意语言</button>';
    const footer = () => '<div class="common-modal-footer">' + button('secondary') + button('primary') + '</div>';
    const show = (cls, html) => {
      const el = document.createElement('div'); el.className = 'TUXModal common-modal ' + cls;
      el.setAttribute('role', 'dialog'); el.innerHTML = html; document.body.append(el); return el;
    };
    document.querySelector('.anchor-tag-container button').onclick = () => {
      const type = show('', '<div class="anchor-modal"><button role="combobox" aria-label="33">任意语言</button><div class="button-group">' + button('secondary') + button('primary') + '</div></div>');
      type.querySelector('.TUXButton--primary').onclick = () => {
        type.classList.add('no-mask-modal');
        const select = show('product-selector-modal', '<div class="product-selector-container">' +
          '<div class="product-search-input"><input type="text"></div><button class="product-search-icon">?</button>' +
          '<table class="product-table"><tbody><tr><td><input type="radio"><span class="product-name">Test product name</span></td><td class="product-tb-cell">10000000000001</td></tr></tbody></table></div>' + footer());
        const next = select.querySelector('.TUXButton--primary'); next.disabled = true;
        select.querySelector('input[type=radio]').onchange = () => { next.disabled = false; };
        next.onclick = () => {
          select.remove();
          const name = show('', '<div class="common-modal-body"><input type="text" value="Test product"><div class="TUXFormField-wordCount">12/30</div></div>' + footer());
          name.querySelector('.TUXButton--primary').onclick = () => {
            type.remove(); name.remove();
            const anchor = document.createElement('div'); anchor.className = 'anchor-container';
            anchor.innerHTML = '<span class="content-anchor-label">Test product</span>'; document.body.append(anchor);
          };
        };
      };
    };
  });
}

test('空语言配置注入和无弹窗闸门正常', async () => {
  await fresh();
  await page.evaluate(() => { window.__tkq.checkForAppCrash(); window.__tkq.assertProductPickerClosed('测试'); });
});

for (const lang of ['id-ID', 'fil-PH', 'th-TH', 'ms-MY', 'en-US']) {
  test('翻译替换夹具 ' + lang + ' 双绿通过（不代表当地实测）', async () => {
    await fresh();
    await page.evaluate((lang) => { document.documentElement.lang = lang; document.querySelectorAll('.status-tip').forEach((e) => { e.textContent = lang + ' 随机文案'; }); }, lang);
    assert.equal(await page.evaluate(() => window.__tkq.getChecksState().passed), true);
    assert.equal(await page.evaluate(() => window.__tkq.waitForChecksPassAndAssertSafe(1800)), true);
  });
}

for (const [area, state] of [['music','warn'], ['content','warn'], ['music','checking'], ['content','checking'], ['content','ready']]) {
  test(area + '=' + state + '，隐藏绿字不能放行', async () => {
    await fresh(); await setState(area, state);
    assert.equal(await page.evaluate(() => window.__tkq.getChecksState().passed), false);
    await assert.rejects(page.evaluate(() => window.__tkq.waitForChecksPassAndAssertSafe(50)), /发布安全检查未通过/);
    await assert.rejects(page.evaluate(() => window.__tkq.clickPublishButton()), /发布安全检查未通过/);
    assert.equal(await page.evaluate(() => window.postClicks), 0);
  });
}

test('检查中转换为双绿后，仍需绿色状态稳定才放行', async () => {
  await fresh(); await setState('content', 'checking');
  const elapsed = await page.evaluate(async () => {
    const start = Date.now();
    setTimeout(() => {
      document.querySelectorAll('.content-check .status-result').forEach((el) => {
        el.dataset.show = String(el.classList.contains('status-success'));
      });
    }, 150);
    await window.__tkq.waitForChecksPassAndAssertSafe(2200);
    return Date.now() - start;
  });
  assert.ok(elapsed >= 1150);
  assert.equal(await page.evaluate(() => window.postClicks), 0);
});

for (const variation of ['disabled', 'missing', 'ancestor-hidden', 'data-show-false', 'duplicate-green', 'yellow', 'unknown', 'conflicting']) {
  test('异常检查结构 ' + variation + ' 阻止放行', async () => {
    await fresh();
    await page.evaluate((variation) => {
      const root = document.querySelector('.content-check'), success = root.querySelector('.status-success');
      if (variation === 'disabled') root.querySelector('input').checked = false;
      if (variation === 'missing') root.remove();
      if (variation === 'ancestor-hidden') root.style.display = 'none';
      if (variation === 'data-show-false') { success.dataset.show = 'false'; success.style.display = 'block'; }
      if (variation === 'duplicate-green') root.querySelector('.status-wrapper').append(success.cloneNode(true));
      if (variation === 'yellow') success.querySelector('.status-tip').style.color = 'var(--ui-text-warning)';
      if (variation === 'unknown') success.className = 'status-result new-unknown';
      if (variation === 'conflicting') root.querySelector('.status-warn').dataset.show = 'true';
    }, variation);
    assert.equal(await page.evaluate(() => window.__tkq.getChecksState().passed), false);
    await assert.rejects(page.evaluate(() => window.__tkq.clickPublishButton()), /发布安全检查未通过/);
    assert.equal(await page.evaluate(() => window.postClicks), 0);
  });
}

// 检查开关偶尔会莫名其妙是关着的(页面没渲染完就被读到、或者TikTok自己抽风)。
// 这不是"内容没通过"，不该叫人来处理——自己把开关打开重跑一遍就行。
// 但这里有条不能松的线：只做【打开】这一个方向，而且真的红/黄必须照样拦住。
async function turnCheckOff(area, { stuck = false } = {}) {
  await page.evaluate(([area, stuck]) => {
    const root = document.querySelector(area === 'music' ? '.copyright-check' : '.content-check');
    const wrap = root.querySelector('[data-state]');
    const input = root.querySelector('input[role="switch"]');
    wrap.dataset.state = 'unchecked';
    input.checked = false;
    input.onclick = stuck
      ? (e) => { e.preventDefault(); input.checked = false; }        // 点了也打不开
      : () => { input.checked = true; wrap.dataset.state = 'checked'; }; // 真实页面的行为
  }, [area, stuck]);
}

for (const area of ['music', 'content']) {
  test(`${area} 检查开关被关掉时自动打开重跑，不打扰人`, async () => {
    await fresh();
    await turnCheckOff(area);
    const result = await page.evaluate(() =>
      window.__tkq.waitForChecksPassAndAssertSafe(8000).then(() => 'ok', (e) => e.message));
    assert.equal(result, 'ok', '开关自动打开后应该正常通过');
    const on = await page.evaluate((area) => {
      const sel = area === 'music' ? '.copyright-check' : '.content-check';
      return document.querySelector(sel + ' input[role="switch"]').checked;
    }, area);
    assert.equal(on, true, '开关应该被打开');
  });
}

test('开关卡住打不开时停下，并且报成可以重试的那类错', async () => {
  await fresh();
  await turnCheckOff('music', { stuck: true });
  const result = await page.evaluate(() =>
    window.__tkq.waitForChecksPassAndAssertSafe(8000).then(() => 'PUBLISHED', (e) => e.message));
  assert.notEqual(result, 'PUBLISHED', '检查没跑就绝不能放行');
  assert.match(result, /版权检查开关处于关闭状态/);
  // 这句话如果混进去，errorPolicy 会按 CONTENT_PATTERNS 判成永不重试，
  // 那就又变回"每次抽风都要人来点一下"了
  assert.doesNotMatch(result, /发布安全检查未通过/, '不能落进不可重试那一类');
});

test('真的红色结果不会被当成开关问题放过', async () => {
  await fresh();
  await setState('content', 'warn');
  const result = await page.evaluate(() =>
    window.__tkq.waitForChecksPassAndAssertSafe(5000).then(() => 'PUBLISHED', (e) => e.message));
  assert.notEqual(result, 'PUBLISHED');
  assert.match(result, /发布安全检查未通过/, '内容判红必须走不可重试那条路');
});

// 上传等多久看的是【卡住没有】，不是【用了多久】。
// 原来写死等 3 分钟：网速慢的时候视频还在传(进度条明明在涨)就被判"等待元素超时"，
// 然后整轮重来——重来又得从头传一遍，网速慢的人永远发不出去。
// fresh() 的夹具默认是"传完了"，测上传过程要先退回起点
async function resetUploadToStart() {
  await page.evaluate(() => {
    const c = document.querySelector('[data-e2e="upload_status_container"]');
    c.querySelector('.info-progress').classList.remove('success');
    c.querySelector('.info-status').classList.remove('success');
    c.querySelector('.info-progress').style.width = '0%';
    document.querySelector('.caption-editor [contenteditable="true"]').textContent = '';
  });
}

async function setUploadProgress(pct, { done = false, error = false } = {}) {
  await page.evaluate(([pct, done, error]) => {
    const c = document.querySelector('[data-e2e="upload_status_container"]');
    const prog = c.querySelector('.info-progress');
    const status = c.querySelector('.info-status');
    prog.style.width = pct + '%';
    prog.classList.toggle('success', done);
    status.classList.toggle('success', done);
    prog.classList.toggle('error', error);
  }, [pct, done, error]);
}

test('上传慢但进度一直在涨，不能判失败', async () => {
  await fresh();
  // fresh() 的夹具默认是"已上传完成"，这里要退回到"刚开始传"
  await resetUploadToStart();
  const result = await page.evaluate(() => {
    // 进度每 100ms 涨一点，总耗时远超 stallMs(800ms)——只要"在动"就不该超时
    const prog = document.querySelector('.info-progress');
    const status = document.querySelector('.info-status');
    let pct = 0;
    const timer = setInterval(() => {
      pct += 4;
      prog.style.width = pct + '%';
      if (pct >= 100) {
        clearInterval(timer);
        prog.classList.add('success');
        status.classList.add('success');
        document.querySelector('.caption-editor [contenteditable="true"]').textContent = '123456';
      }
    }, 100);
    // stallMs 给 3000：要够跨过传完之后那 1200ms 的"标题稳定"窗口
    return window.__tkq.waitForUploadComplete('123456.mp4', 3000, 60000).then(() => 'ok', (e) => e.message);
  });
  assert.equal(result, 'ok', '进度在涨就该一直等');
});

test('进度真的停住不动才算失败，并说清卡在几%', async () => {
  await fresh();
  await resetUploadToStart();
  await setUploadProgress(99);
  const result = await page.evaluate(() =>
    window.__tkq.waitForUploadComplete('123456.mp4', 800, 60000).then(() => 'PASSED', (e) => e.message));
  assert.notEqual(result, 'PASSED');
  assert.match(result, /卡住/);
  assert.match(result, /99%/, '要告诉人卡在哪，不能只说"等待元素超时"');
});

test('传完了但默认标题一直不出现，也要能退出，不能空转到硬上限', async () => {
  await fresh();
  await setUploadProgress(100, { done: true });
  const started = Date.now();
  const result = await page.evaluate(() =>
    window.__tkq.waitForUploadComplete('从来不会出现的标题.mp4', 800, 60000).then(() => 'PASSED', (e) => e.message));
  assert.notEqual(result, 'PASSED');
  assert.match(result, /默认标题/);
  // 曾经在这个分支里给计时器"续命"，结果是永远等不到超时，一直空转到硬上限
  assert.ok(Date.now() - started < 20000, '应该在 stallMs 附近退出，不是熬满 60 秒');
});

test('上传报错立刻停，不用等到超时', async () => {
  await fresh();
  await resetUploadToStart();
  await setUploadProgress(30, { error: true });
  const started = Date.now();
  const result = await page.evaluate(() =>
    window.__tkq.waitForUploadComplete('123456.mp4', 60000, 90000).then(() => 'PASSED', (e) => e.message));
  assert.match(result, /视频上传失败/);
  assert.ok(Date.now() - started < 5000, '报错就该立刻退出');
});

test('上传99%或未知结构不能算完成，不读完成提示文案', async () => {
  await fresh();
  assert.equal(await page.evaluate(() => window.__tkq.getUploadState().state), 'success');
  await page.evaluate(() => { document.querySelector('.info-progress').className = 'info-progress info'; document.querySelector('.info-progress').style.width = '99%'; });
  assert.equal(await page.evaluate(() => window.__tkq.getUploadState().state), 'uploading');
  await page.evaluate(() => document.querySelector('[data-e2e="upload_status_container"]').remove());
  assert.equal(await page.evaluate(() => window.__tkq.getUploadState().state), 'unknown');
});

test('上传就绪需等待默认标题稳定，不依赖翻译', async () => {
  await fresh(); await page.locator('[contenteditable]').fill('test-file');
  await page.evaluate(() => window.__tkq.waitForUploadComplete('test-file.mp4'));
});

test('任何语言/未知用途弹窗都拦住', async () => {
  await fresh();
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div role="dialog">X Y Z</div>'));
  await assert.rejects(page.evaluate(() => window.__tkq.assertProductPickerClosed('发布')), /弹窗仍然打开/);
  await assert.rejects(page.evaluate(() => window.__tkq.clickPublishButton()), /弹窗仍然打开/);
  assert.equal(await page.evaluate(() => window.postClicks), 0);
});

test('立即发布按value定位，不误选顺序在前面的定时发布', async () => {
  await fresh(); await page.locator('input[value=schedule]').check();
  await page.evaluate(() => window.__tkq.setPublishNow());
  assert.equal(await page.locator('input[value=post_now]').isChecked(), true);
});

test('AI声明先展开，按aigc容器定位，不触碰广告声明', async () => {
  await fresh();
  await page.evaluate(() => {
    const advanced = document.querySelector('[data-e2e=advanced_settings_container]'); advanced.classList.add('collapsed');
    advanced.querySelector('.more-btn').onclick = () => advanced.classList.remove('collapsed');
    const input = document.querySelector('[data-e2e=aigc_container] input'); input.checked = false; input.parentElement.dataset.state = 'unchecked';
    input.onchange = () => { input.parentElement.dataset.state = input.checked ? 'checked' : 'unchecked'; };
  });
  await page.evaluate(() => window.__tkq.setAiDisclosure());
  assert.equal(await page.locator('[data-e2e=aigc_container] input').isChecked(), true);
  assert.equal(await page.locator('[data-e2e=disclose_content_container] input').isChecked(), false);
});

for (const known of [true, false]) {
  test('AI首次确认：' + (known ? '已验证结构可确认' : '未知弹窗不确认'), async () => {
    await fresh();
    await page.evaluate((known) => {
      const input = document.querySelector('[data-e2e=aigc_container] input'); input.checked = false; input.parentElement.dataset.state = 'unchecked';
      input.onclick = (event) => {
        event.preventDefault();
        const modal = document.createElement('div'); modal.setAttribute('role', 'dialog');
        modal.innerHTML = '<div class="modal-content"><h2>任意语言</h2>' +
          (known ? '<div class="modal-bullet">1</div><div class="modal-bullet">2</div><div class="modal-bullet">3</div>' : '') +
          '</div><div class="common-modal-footer"><button data-type="neutral">X</button><button data-type="primary">Y</button></div>';
        modal.querySelector('[data-type=primary]').onclick = () => { window.aiConfirmed = true; input.checked = true; input.parentElement.dataset.state = 'checked'; modal.remove(); };
        document.body.append(modal);
      };
    }, known);
    if (known) {
      await page.evaluate(() => window.__tkq.setAiDisclosure());
      assert.equal(await page.evaluate(() => window.aiConfirmed), true);
    } else {
      await assert.rejects(page.evaluate(() => window.__tkq.setAiDisclosure()), /未知确认弹窗/);
      assert.equal(await page.evaluate(() => window.aiConfirmed), false);
    }
  });
}

test('商品全流程靠结构和精确ID；本地模拟点击最终按钮一次', async () => {
  await fresh(); await mockProductWorkflow();
  const result = await page.evaluate(() => window.__tkq.addProductLink('10000000000001'));
  assert.equal(result.anchorName, 'Test product');
  assert.equal(await page.evaluate(() => window.__tkq.assertReadyToPublish()), true);
  assert.deepEqual(await page.evaluate(() => window.__tkq.clickPublishButton()), { clicked: true, prematureCheck: false });
  assert.equal(await page.evaluate(() => window.postClicks), 1);
});

test('检查通过后变红：最终点击再次校验，不发出点击', async () => {
  await fresh(); await mockProductWorkflow();
  await page.evaluate(() => window.__tkq.addProductLink('10000000000001'));
  await page.evaluate(() => window.__tkq.waitForChecksPassAndAssertSafe(1800));
  await setState('content', 'warn');
  await assert.rejects(page.evaluate(() => window.__tkq.clickPublishButton()), /发布安全检查未通过/);
  assert.equal(await page.evaluate(() => window.postClicks), 0);
});

test('发布后任何新弹窗都报不确定，不替用户确认', async () => {
  await fresh(); await mockProductWorkflow();
  await page.evaluate(() => window.__tkq.addProductLink('10000000000001'));
  await page.evaluate(() => { document.querySelector('[data-e2e=post_video_button]').onclick = () => document.body.insertAdjacentHTML('beforeend', '<div role="dialog"><button>未知语言确认</button></div>'); });
  assert.equal((await page.evaluate(() => window.__tkq.clickPublishButton())).prematureCheck, true);
});

test('重装助手清除上一轮商品确认，不能用旧锚点发布', async () => {
  await fresh(); await mockProductWorkflow();
  await page.evaluate(() => window.__tkq.addProductLink('10000000000001'));
  await page.evaluate(installTkqInPage, { hashtagKeywords: ['fyp', 'tiktok', 'tiktokshop'] });
  await assert.rejects(page.evaluate(() => window.__tkq.assertReadyToPublish()), /没有本次精确商品ID/);
});

for (const variation of ['ai', 'schedule', 'upload', 'caption', 'product', 'button']) {
  test('最终闸门重新核对 ' + variation + '，不发出点击', async () => {
    await fresh(); await mockProductWorkflow();
    await page.evaluate(() => window.__tkq.addProductLink('10000000000001'));
    await page.evaluate((variation) => {
      if (variation === 'ai') document.querySelector('[data-e2e=aigc_container] input').checked = false;
      if (variation === 'schedule') document.querySelector('input[value=post_now]').checked = false;
      if (variation === 'upload') document.querySelector('.info-progress').classList.remove('success');
      if (variation === 'caption') document.querySelector('[contenteditable]').textContent += ' left-over-filename';
      if (variation === 'product') document.querySelector('.content-anchor-label').textContent = 'another product';
      if (variation === 'button') document.querySelector('[data-e2e=post_video_button]').disabled = true;
    }, variation);
    await assert.rejects(page.evaluate(() => window.__tkq.clickPublishButton()));
    assert.equal(await page.evaluate(() => window.postClicks), 0);
  });
}

test('真实控制台JS：无需语言字段保存账号，且保留旧配置（模拟API，不写用户数据）', async () => {
  const example = JSON.parse(readFileSync(new URL('../config/settings.example.json', import.meta.url), 'utf8'));
  let saved;
  const existing = { name: 'fixture', browser: 'bitbrowser', browserId: 'test-profile', videoFolder: 'C:/fixture', enabled: false,
    hashtagKeywords: ['fyp'], textPreset: 'custom', textOverrides: { appCrashMarkers: ['X', 'Y'] }, dailyPublishLimit: 7 };
  await page.route('http://console.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/' || path === '/app.js' || path === '/style.css') {
      const file = path === '/' ? 'index.html' : path.slice(1);
      const body = readFileSync(new URL('../public/' + file, import.meta.url), 'utf8');
      return route.fulfill({ body, contentType: path === '/' ? 'text/html' : path.endsWith('.js') ? 'text/javascript' : 'text/css' });
    }
    if (path === '/api/logs/stream') return route.fulfill({ body: '', contentType: 'text/event-stream' });
    let value = {};
    if (path === '/api/settings') value = example;
    if (path === '/api/accounts') {
      if (route.request().method() === 'PUT') { saved = route.request().postDataJSON(); value = { ok: true, warnings: [] }; }
      else value = [existing];
    }
    if (path === '/api/status') value = { running: false, accounts: [] };
    if (path === '/api/bitbrowser/profiles') value = [];
    return route.fulfill({ json: value });
  });
  await page.goto('http://console.test/');
  await page.waitForFunction(() => accountsConfig.length === 1);
  await page.evaluate(() => openAccountModal(0));
  await page.locator('#a-name').fill('fixture-edited');
  await page.locator('#account-form button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#account-modal').classList.contains('hidden'));
  assert.equal(saved[0].name, 'fixture-edited');
  assert.equal(saved[0].enabled, false);
  assert.equal(saved[0].dailyPublishLimit, 7);
  assert.deepEqual(saved[0].textOverrides, existing.textOverrides);
  assert.equal(saved[0].textPreset, 'custom');
});

test('控制台移除了15项翻译表单且保留旧配置', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.equal(html.includes('a-text-fields'), false);
  assert.equal(app.includes('currentPresetKey'), false);
  assert.equal(app.includes('...(previous || {})'), true);
});
