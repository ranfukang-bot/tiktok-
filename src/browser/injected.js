// 这个函数会被 Playwright 通过 page.evaluate 整体注入到 TikTok Studio 页面里执行。
// 必须是完全自包含的（不能引用外部闭包变量），所有需要的东西都通过 config 参数传进来。
// 内容基本是原油猴脚本 TikTokStudioBulkUploadV2 里"自动化步骤"那一段的搬运，
// 去掉了 GM_setValue/文件夹句柄/面板UI 这些只有油猴环境才需要的部分，
// 状态记录、调度、文件读取全部交给 Node 端（Playwright）负责。
export function installTkqInPage(config) {
  // 这里【故意】没有 `if (window.__tkq) return` 的单例守卫。
  // 那个守卫会把重装时传进来的新config悄悄丢掉，只保留第一次安装时的闭包——
  // 提交 e58da98 就是被它坑过一次(用空config装过之后，真实config再也装不进去)。
  // 每轮需更新标签配置并清除上一轮挂车记录，不能保留旧闭包。
  // 重装是安全的：函数体只声明闭包再赋值 window.__tkq，没有事件监听、没有定时器、
  // 不碰DOM，而且Node端的 page.evaluate 是串行的，不会有执行到一半的调用被打断。

  function log(msg) {
    // eslint-disable-next-line no-console
    console.log('[TKQ] ' + msg);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function humanDelay(minMs = 800, maxMs = 2200) {
    return sleep(minMs + Math.random() * (maxMs - minMs));
  }

  // 文案只保留为错误页的可选诊断信号，不参与定位或发布放行。
  const pageText = (config && config.text) || {};
  function textList(key) {
    const v = pageText[key];
    return (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string' && x.trim());
  }

  // 页面文字匹配的统一入口：折叠空白 + 忽略大小写。
  // 忽略大小写是必需的——Chrome 的 innerText 会把 CSS text-transform 算进去，
  // TikTok 有些按钮是用CSS转成大写的，原样比较会匹配不上。
  function normText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }



  function hasAllMarkers(haystack, markers) {
    // 空列表必须返回 false。[].every() 恒为 true，会让崩溃检测在每一轮的
    // 第一次 waitFor 就误报"页面崩溃"，整个账号立刻卡死并且报错信息完全误导。
    if (!markers.length) return false;
    const h = normText(haystack);
    return markers.every((m) => h.includes(normText(m)));
  }

  // 不要求在视口内（页面下方的检查也要读），但排除隐藏分支及隐藏祖先。
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let node = el; node && node !== document; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || node.getAttribute('data-show') === 'false' ||
          style.display === 'none' || style.visibility === 'hidden' ||
          style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
    }
    return true;
  }

  function isEnabled(el) {
    return Boolean(el && !el.disabled && !el.matches(':disabled') &&
      !el.closest('[aria-disabled="true"], [data-disabled="true"], [inert]') &&
      getComputedStyle(el).pointerEvents !== 'none');
  }

  function uniqueVisible(root, selector, what) {
    const nodes = Array.from((root || document).querySelectorAll(selector)).filter(isVisible);
    if (nodes.length > 1) throw new Error(`页面结构不受支持：${what}有多个匹配，已停止以避免误点击`);
    return nodes[0] || null;
  }

  const MODAL_SELECTOR = '[role="dialog"], [aria-modal="true"], .TUXModal, .common-modal, [class*="modal-container"], [class*="ModalContainer"]';
  function getVisibleModalRoots() {
    const nodes = Array.from(document.querySelectorAll(MODAL_SELECTOR)).filter(isVisible);
    // 外层遮罩和内层 dialog 算同一个弹窗，只保留最内层的语义容器。
    return nodes.filter((el) => !nodes.some((other) => other !== el && el.contains(other)));
  }

  function getTopModal() {
    return getVisibleModalRoots().filter((el) => !el.classList.contains('no-mask-modal')).pop() || null;
  }

  function assertProductPickerClosed(nextAction) {
    // 不认弹窗里的字：任何可见弹窗都拦截，未知弹窗也不能隔着它点发布。
    if (getVisibleModalRoots().length) {
      throw new Error(`页面弹窗仍然打开，禁止继续${nextAction}，避免后台误点击`);
    }
  }

  function attachedProductLabel() {
    return uniqueVisible(document, '.anchor-container .content-anchor-label', '商品锚点');
  }

  let attachedProduct = null;

  function getWorkflowStage(root) {
    if (!root) return null;
    if (root.matches('.product-selector-modal') || root.querySelector('.product-selector-container')) return 'select';
    if (root.querySelector('.anchor-modal')) return 'type';
    if (root.querySelector('.common-modal-body .TUXFormField-wordCount') &&
        root.querySelectorAll('.common-modal-body input[type="text"]').length === 1 &&
        root.querySelector('.common-modal-footer')) return 'name';
    return null;
  }

  function getWorkflowAction(root, stage) {
    if (getWorkflowStage(root) !== stage) return null;
    const scope = root.querySelector(stage === 'type' ? '.anchor-modal .button-group' : '.common-modal-footer');
    if (!scope) return null;
    const btn = uniqueVisible(scope,
      'button.TUXButton--primary, button[data-type="primary"], button.Button__root--type-primary', '商品确认按钮');
    return btn && isEnabled(btn) ? btn : null;
  }

  function switchIsOn(input) {
    if (!input || !input.checked) return false;
    const wrapper = input.closest('[data-state]');
    return input.getAttribute('aria-checked') !== 'false' &&
      (!wrapper || wrapper.getAttribute('data-state') !== 'unchecked');
  }

  function checkForAppCrash() {
    // 用"全部命中才算"的语义，跟原来的 A && B 一致：单独一个"出错了"很容易
    // 在别的提示里出现，两个词同时出现才足够确定是那个错误页。
    // hasAllMarkers 内部对空列表返回 false —— 没配就是检测不到崩溃(退化成等超时)，
    // 绝不能变成"恒为真"，那会让每一轮的第一次 waitFor 就误报崩溃。
    const markers = textList('appCrashMarkers');
    if (hasAllMarkers(document.body.innerText || '', markers)) {
      throw new Error(`TikTok页面自己崩溃报错了(${markers.join('/')})，需要人工刷新页面重试`);
    }
  }

  async function waitFor(fn, timeout = 10000, interval = 300) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      checkForAppCrash();
      const result = fn();
      if (result) return result;
      await sleep(interval);
    }
    throw new Error('等待元素超时');
  }

  async function waitForOrNull(fn, timeout = 5000, interval = 150) {
    try {
      return await waitFor(fn, timeout, interval);
    } catch (err) {
      if (err && err.message === '等待元素超时') return null;
      throw err;
    }
  }

  function fireClick(el) {
    el.scrollIntoView({ block: 'center' });
    el.click();
  }

  // ===== 文案框 =====
  function getCaptionEditable() {
    return (
      Array.from(document.querySelectorAll('.caption-editor [contenteditable="true"]'))
        .filter(isVisible)
        .sort((a, b) => {
          const aRect = a.getBoundingClientRect();
          const bRect = b.getBoundingClientRect();
          return bRect.width * bRect.height - aRect.width * aRect.height;
        })[0] || null
    );
  }

  function getCaptionText(editable) {
    if (!editable) return '';
    return (editable.innerText || editable.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  }

  // 这里只返回真实鼠标可以点击的坐标，不在页面上下文里调用 focus()/修改选区/改DOM。
  // Draft.js 对脚本直接操纵 Selection + execCommand 的组合非常敏感；真实 TikTok
  // 对照实验已经确认，那条旧路径虽然表面上清空成功，却会让下一次插入历史标签时
  // 进入错误页。实际聚焦和清空统一交给 Node 端的 CDP 鼠标/键盘事件完成。
  async function locateCaptionEditor() {
    const editable = await waitFor(getCaptionEditable);
    editable.scrollIntoView({ block: 'center' });
    await sleep(100);
    const rect = editable.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: rect.left + Math.min(80, rect.width / 2),
      y: rect.top + Math.min(24, rect.height / 2),
      text: getCaptionText(editable),
    };
  }

  function getCaptionSelectionText() {
    const editable = getCaptionEditable();
    const selection = window.getSelection();
    if (!editable || !selection || selection.rangeCount === 0) return '';
    const range = selection.getRangeAt(0);
    const selectionBelongsToCaption =
      editable.contains(range.commonAncestorContainer) || range.commonAncestorContainer === editable;
    return selectionBelongsToCaption ? selection.toString() : '';
  }

  async function waitForCaptionCleared(timeout = 3000, stableMs = 1200) {
    const deadline = Date.now() + timeout;
    let emptySince = 0;
    while (Date.now() < deadline) {
      checkForAppCrash();
      const editable = getCaptionEditable();
      if (editable && !getCaptionText(editable)) {
        if (!emptySince) emptySince = Date.now();
        if (Date.now() - emptySince >= stableMs) return true;
      } else {
        emptySince = 0;
      }
      await sleep(100);
    }
    return false;
  }

  function captionContainsHashtag(text, keyword) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^a-z0-9_])#\\s*${escaped}(?=$|[^a-z0-9_])`, 'i').test(text);
  }

  function captionHashtagCount(text, keyword) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = text.match(new RegExp(`(?:^|[^a-z0-9_])#\\s*${escaped}(?=$|[^a-z0-9_])`, 'gi'));
    return matches ? matches.length : 0;
  }

  function captionUnexpectedRemainder(text) {
    let remainder = text;
    for (const keyword of config.hashtagKeywords) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      remainder = remainder.replace(new RegExp(`#\\s*${escaped}(?=$|[^a-z0-9_])`, 'gi'), ' ');
    }
    return remainder.replace(/[\s#]+/g, '').trim();
  }

  function assertCaptionSafe(stage, requireAllHashtags = true) {
    const editable = getCaptionEditable();
    const text = getCaptionText(editable);
    if (!editable || !text) {
      throw new Error(`${stage}：文案框为空或不可见，已停止以避免误发布`);
    }
    const remainder = captionUnexpectedRemainder(text);
    if (remainder) {
      throw new Error(`${stage}：发现未清除的默认标题"${text.slice(0, 120)}"，已停止，绝不会发布`);
    }
    if (requireAllHashtags) {
      const missing = config.hashtagKeywords.filter((k) => !captionContainsHashtag(text, k));
      if (missing.length) {
        throw new Error(`${stage}：缺少话题标签 ${missing.map((k) => '#' + k).join(' ')}，已停止以避免误发布`);
      }
      // 話題标签点击建议项/直接输入这两条路径都可能因为面板刷新时机问题被重复触发，
      // 重复标签发出去不算"误发布"但很像机器人行为，一律拦下来让人看一眼，不悄悄放过。
      const duplicated = config.hashtagKeywords.filter((k) => captionHashtagCount(text, k) > 1);
      if (duplicated.length) {
        throw new Error(`${stage}：话题标签 ${duplicated.map((k) => '#' + k).join(' ')} 重复出现了，可能是插入过程中被重复触发，已停止以避免发出带重复标签的内容`);
      }
    }
    return text;
  }

  async function waitForCaptionHashtag(keyword, timeout = 2000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      checkForAppCrash();
      const editable = getCaptionEditable();
      if (editable && captionContainsHashtag(getCaptionText(editable), keyword)) return true;
      await sleep(100);
    }
    return false;
  }

  function getUploadState() {
    const container = uniqueVisible(document, '[data-e2e="upload_status_container"]', '上传状态容器');
    if (!container) return { state: 'unknown' };
    const progress = container.querySelector('.info-progress');
    const status = container.querySelector('.info-status');
    // 初始进度条会 visibility:hidden，不能把“没看到进度条”当作完成。
    const states = [progress, status].filter(Boolean);
    if (states.some((el) => el.classList.contains('error') || el.classList.contains('danger'))) {
      return { state: 'error' };
    }
    if (progress && status && states.every((el) => el.classList.contains('success'))) {
      return { state: 'success', progress: progress.style.width };
    }
    return { state: 'uploading', progress: progress?.style.width || '' };
  }

  async function waitForUploadComplete(filename) {
    const expected = String(filename || '').replace(/\.[^.]+$/, '').trim();
    let stableText = null;
    let stableSince = 0;
    log('等待上传完成状态和默认标题稳定（DOM识别，无需语言配置）…');
    await waitFor(() => {
      const upload = getUploadState();
      if (upload.state === 'error') throw new Error('视频上传失败，已停止后续操作');
      const editable = getCaptionEditable();
      const caption = getCaptionText(editable);
      if (upload.state !== 'success' || !editable || !expected || caption !== expected) {
        stableText = null;
        stableSince = 0;
        return null;
      }
      if (caption !== stableText) {
        stableText = caption;
        stableSince = Date.now();
      }
      return Date.now() - stableSince >= 1200;
    }, 3 * 60 * 1000, 200);
    log('视频上传完成且默认标题已稳定 ✅');
  }

  // ===== 文案/话题标签：只走"点历史标签面板里的chip"这一条路径。=====
  // 曾经加过"找不到chip就用键盘/execCommand直接打字"的兜底，撤回了：那样打出来的
  // "#fyp"只是纯文本，不会被TikTok识别成真正的话题标签，而且实测出过页面崩溃。
  // 找不到chip就直接报错暂停，交给人去给这个账号先手动发一条建立历史记录。

  // 在真实键盘清空后保持编辑器焦点，找到历史标签chip并返回它在视口里的中心坐标。
  // 注意这里【只定位不点击】——实际点击由 Node 端用 Playwright 的真实鼠标事件完成。
  //
  // 真实 TikTok 的A/B复现已经进一步确认：只把chip换成真实鼠标仍然会崩；只有
  // 同时把标题清空改成真实 Ctrl+A + Backspace 才能稳定插入三个标签。也就是说
  // 旧 execCommand 清空留下的Draft.js选区/EditorState不一致才是根因，真实鼠标
  // 点击chip是完整修复的一部分，但不是单独的根因。
  //
  // 返回 null 表示这个账号还没有这个历史标签(需要人工先手动发一条建立记录)。
  async function locateHashtagChip(keyword) {
    await waitFor(getCaptionEditable);
    // 不再调用 editable.focus()：标题由真实鼠标聚焦并用真实键盘清空，必须保留
    // 浏览器当前的真实焦点和选区，让建议面板自己的 mousedown 逻辑接管。
    await sleep(250);
    checkForAppCrash();

    const chip = Array.from(document.querySelectorAll('.suggest-item')).find(
      (el) => isVisible(el) && el.textContent.replace(/\s/g, '').toLowerCase() === ('#' + keyword).toLowerCase()
    );
    if (!chip) return null;

    // 滚到可视区域再取坐标；不改DOM(不加data属性之类)，这个编辑器很脆弱，
    // 能不碰它的DOM就不碰。
    chip.scrollIntoView({ block: 'center' });
    await sleep(200);
    const rect = chip.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  // Node端用真实鼠标点完之后调这个确认标签确实进到文案里了
  async function confirmHashtagInserted(keyword) {
    const inserted = await waitForCaptionHashtag(keyword);
    if (!inserted) {
      throw new Error(`已点击 #${keyword} 建议项，但文案框里没有确认到该标签，需要人工检查`);
    }
    assertCaptionSafe(`添加 #${keyword} 后检查`, false);
    log(`已添加并确认历史话题: #${keyword}`);
    return true;
  }

  async function finalizeCaption() {
    const editable = getCaptionEditable();
    if (editable) editable.blur();
    await sleep(1200);
    const finalCaption = assertCaptionSafe('文案填写完成终检');
    log(`文案终检通过 ✅：${finalCaption}`);
    return finalCaption;
  }

  // ===== 商品挂车：限定流程、限定容器，不根据按钮文字猜下一步 =====
  async function addProductLink(productId) {
    productId = String(productId || '').trim();
    if (!/^\d+$/.test(productId)) throw new Error('商品ID必须是数字字符串，已停止挂车');
    assertProductPickerClosed('添加商品');
    if (attachedProductLabel()) throw new Error('编辑页已有商品锚点，已停止以避免挂错商品');
    attachedProduct = null;
    log('开始添加商品链接: ' + productId);
    const addBtn = await waitFor(() => {
      const scope = uniqueVisible(document, '.anchor-tag-container', '添加链接区域');
      const btn = scope && uniqueVisible(scope, 'button', '添加商品按钮');
      return btn && btn.querySelector('[data-icon="Plus"]') && isEnabled(btn) ? btn : null;
    }, 20000);
    fireClick(addBtn);

    const typeModal = await waitFor(() => {
      const modal = getTopModal();
      return getWorkflowStage(modal) === 'type' ? modal : null;
    });
    // 在菲律宾和印尼实际观察到的 Products 链接类型枚举是 33。
    // 其它链接类型不能盲目点下一步，避免误挂非商品链接。
    const type = uniqueVisible(typeModal, '.anchor-modal [role="combobox"]', '商品链接类型');
    if (!type || type.getAttribute('aria-label') !== '33') {
      throw new Error('页面结构不受支持：链接类型不是已验证的商品类型33，请人工核对');
    }
    fireClick(await waitFor(() => getWorkflowAction(getTopModal(), 'type')));

    const productDialog = await waitFor(() => {
      const modal = getTopModal();
      return getWorkflowStage(modal) === 'select' ? modal : null;
    });
    const searchInput = await waitFor(() => {
      if (productDialog.querySelector('.product-empty-container')) {
        throw new Error('商品橱窗为空，请先在TikTok App添加橱窗商品');
      }
      return uniqueVisible(productDialog, '.product-search-input input[type="text"]', '商品搜索框');
    }, 20000);
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(searchInput, productId);
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    const searchIcon = await waitFor(() => uniqueVisible(productDialog, '.product-search-icon', '商品搜索按钮'));
    fireClick(searchIcon);

    const findProductRow = () => {
      const rows = Array.from(productDialog.querySelectorAll('.product-table tbody tr, .product-table [role="row"]'))
        .filter(isVisible).filter((row) =>
          Array.from(row.querySelectorAll('.product-tb-cell')).some((cell) => cell.textContent.trim() === productId));
      if (rows.length > 1) throw new Error('页面结构不受支持：同一商品ID匹配多行');
      return rows[0] || null;
    };
    const row = await waitForOrNull(findProductRow, 20000);
    if (!row) throw new Error(`未找到精确商品ID ${productId}，请核对该账号橱窗`);
    const radio = row.querySelector('input[type="radio"]');
    const productName = row.querySelector('.product-name')?.textContent.trim();
    if (!radio || !isEnabled(radio) || !productName) {
      throw new Error('页面结构不受支持：商品行缺少可用单选框或商品名称');
    }
    fireClick(radio);
    if (!await waitForOrNull(() => findProductRow()?.querySelector('input[type="radio"]')?.checked, 3000, 100)) {
      throw new Error(`商品 ${productId} 已搜到，但单选框没有真正选中，已停止后续发布`);
    }
    log('已按精确ID选中商品，进入名称确认');
    fireClick(await waitFor(() => getWorkflowAction(getTopModal(), 'select'), 15000));

    const nameModal = await waitFor(() => {
      const modal = getTopModal();
      return getWorkflowStage(modal) === 'name' ? modal : null;
    }, 20000);
    const nameInput = nameModal.querySelector('.common-modal-body input[type="text"]');
    const anchorName = nameInput.value.trim();
    // TikTok会把商品名称截断；确认它确实来自刚选中的商品，不能确认其它弹窗。
    if (!anchorName || !productName.startsWith(anchorName) || nameInput.getAttribute('aria-invalid') === 'true') {
      throw new Error('商品确认名称与所选商品不一致，已停止挂车');
    }
    fireClick(await waitFor(() => getWorkflowAction(getTopModal(), 'name'), 10000));
    await waitFor(() => {
      if (getVisibleModalRoots().length) return false;
      return attachedProductLabel()?.textContent.trim() === anchorName;
    }, 15000, 150);
    attachedProduct = { productId, anchorName };
    log('商品链接添加完成并已核对锚点: ' + productId);
    return { ...attachedProduct };
  }

  // ===== 发布时间 / AI声明 =====
  function getNowRadio() {
    return uniqueVisible(document,
      '[data-e2e="schedule_container"] input[type="radio"][name="postSchedule"][value="post_now"]', '立即发布单选框');
  }

  async function setPublishNow() {
    assertProductPickerClosed('设置立即发布');
    const radio = await waitFor(getNowRadio);
    if (!isEnabled(radio)) throw new Error('立即发布单选框不可用，已停止');
    if (!radio.checked) fireClick(radio);
    await waitFor(() => {
      const current = getNowRadio();
      return current?.checked && current.getAttribute('aria-checked') !== 'false';
    }, 3000, 100);
    log('已确认立即发布（post_now）');
  }

  function getAiSwitch() {
    const container = uniqueVisible(document, '[data-e2e="aigc_container"]', 'AI声明区域');
    return container?.querySelector('input[role="switch"][type="checkbox"]') || null;
  }

  async function setAiDisclosure() {
    assertProductPickerClosed('设置AI声明');
    const advanced = await waitFor(() => uniqueVisible(document,
      '[data-e2e="advanced_settings_container"]', '高级设置展开区域'));
    if (advanced.classList.contains('collapsed')) {
      const trigger = uniqueVisible(advanced, '.more-btn', '展开更多按钮');
      if (!trigger) throw new Error('页面结构不受支持：缺少高级设置展开按钮');
      fireClick(trigger);
      await waitFor(() => {
        const current = document.querySelector('[data-e2e="advanced_settings_container"]');
        return current && !current.classList.contains('collapsed');
      }, 5000, 100);
    }
    const input = await waitFor(getAiSwitch);
    if (!switchIsOn(input)) {
      if (!isEnabled(input)) throw new Error('AI声明开关不可用，已停止');
      fireClick(input);
      const outcome = await waitFor(() => switchIsOn(getAiSwitch()) ? 'on' : getTopModal(), 5000, 100);
      if (outcome !== 'on') {
        // 菲律宾首次开启时的实际DOM：一个说明标题、三条modal-bullet、底部两按钮。
        // 只接受由本次AI开关操作触发的新弹窗；不是通用的“碰到主按钮就确认”。
        const modal = outcome;
        const footer = modal.querySelector('.common-modal-footer');
        const buttons = footer ? Array.from(footer.querySelectorAll('button')).filter(isVisible) : [];
        const confirm = footer && uniqueVisible(footer, 'button[data-type="primary"]', 'AI确认按钮');
        if (getVisibleModalRoots().length !== 1 || !modal.querySelector('.modal-content h2') ||
            modal.querySelectorAll('.modal-content .modal-bullet').length !== 3 ||
            modal.querySelector('input') || buttons.length !== 2 ||
            !buttons.some((btn) => btn.getAttribute('data-type') === 'neutral') ||
            !confirm || !isEnabled(confirm)) {
          throw new Error('页面结构不受支持：AI开关触发了未知确认弹窗，未自动确认');
        }
        fireClick(confirm);
        await waitFor(() => !getVisibleModalRoots().length, 5000, 100);
      }
      await waitFor(() => switchIsOn(getAiSwitch()), 5000, 100);
    }
    log('已确认AI声明开启（aigc_container）');
  }

  // ===== 发布前双绿闸门 =====
  function getCheckRoots() {
    const musicControl = uniqueVisible(document, '[data-e2e="copyright_container"]', '音乐检查');
    const music = musicControl?.closest('.copyright-check') || null;
    const container = music?.parentElement;
    const divider = container?.querySelector(':scope > .content-check__divider');
    const content = divider?.nextElementSibling || null;
    // 只从已观察到的检查区域取状态，HD提示和视频预览也有status-wrapper，不能全局数绿字。
    return { music, content: content?.querySelector('.status-wrapper') ? content : null };
  }

  function readCheck(root, name) {
    if (!root || !isVisible(root)) return { name, state: 'missing', text: '' };
    const input = root.querySelector('input[role="switch"]');
    if (!switchIsOn(input)) return { name, state: 'disabled', text: '' };
    const active = Array.from(root.querySelectorAll('.status-result')).filter(isVisible);
    const result = active[0];
    const text = active.map((el) => el.innerText.trim()).join(' | ').slice(0, 350);
    const flags = active.map((el) => ({
      el,
      danger: Boolean(el.querySelector('[style*="--ui-text-danger"], [color*="--ui-text-danger"]')),
      warning: Boolean(el.querySelector('[style*="--ui-text-warning"], [color*="--ui-text-warning"]')),
    }));
    if (flags.some(({ el, danger, warning }) =>
      danger || warning || el.matches('.status-warn, .status-error'))) return { name, state: 'blocked', text };
    if (active.length !== 1) return { name, state: 'unknown', text };
    if (result.matches('.status-checking') || result.querySelector('.spinning')) {
      return { name, state: 'checking', text };
    }
    if (result.matches('.status-success') && result.querySelector('.status-tip[style*="--ui-text-success"]')) {
      return { name, state: 'success', text };
    }
    return { name, state: result.matches('.status-ready') ? 'ready' : 'unknown', text };
  }

  function getChecksState() {
    const roots = getCheckRoots();
    const checks = [readCheck(roots.music, 'music'), readCheck(roots.content, 'content')];
    return { passed: checks.every((check) => check.state === 'success'), checks };
  }

  function checkSummary(state) {
    return state.checks.map((check) => `${check.name}=${check.state}${check.text ? ': ' + check.text : ''}`).join('；');
  }

  function assertChecksPassed() {
    const state = getChecksState();
    if (!state.passed) throw new Error('发布安全检查未通过：必须两项均为可见绿色成功状态；' + checkSummary(state));
    return state;
  }

  function getPostButton() {
    return uniqueVisible(document, '[data-e2e="post_video_button"]', '最终发布按钮');
  }

  async function waitForChecksPassAndAssertSafe(timeoutMs = 10 * 60 * 1000) {
    assertProductPickerClosed('等待发布前检查');
    log('等待音乐版权和内容检查双绿（最多10分钟；不会超时放行）…');
    const deadline = Date.now() + timeoutMs;
    let passedSince = null;
    let previous = '';
    while (Date.now() < deadline) {
      checkForAppCrash();
      assertProductPickerClosed('等待发布前检查');
      const state = getChecksState();
      const signature = state.checks.map((check) => check.state).join('/');
      if (signature !== previous) {
        log('检查状态: ' + checkSummary(state));
        previous = signature;
      }
      if (state.checks.some((check) => check.state === 'blocked' || check.state === 'disabled')) {
        throw new Error('发布安全检查未通过：' + checkSummary(state));
      }
      const button = getPostButton();
      if (state.passed && button && isEnabled(button)) {
        if (passedSince === null) passedSince = Date.now();
        if (Date.now() - passedSince >= 1000) {
          assertCaptionSafe('双绿后的文案终检');
          assertChecksPassed();
          log('两项检查均明确通过且状态稳定 ✅');
          return true;
        }
      } else {
        passedSince = null;
      }
      await sleep(250);
    }
    throw new Error('发布安全检查未通过：等待双绿超时，不会继续发布；' + checkSummary(getChecksState()));
  }

  function assertReadyToPublish() {
    checkForAppCrash();
    assertProductPickerClosed('发布');
    assertChecksPassed();
    assertCaptionSafe('点击发布前最后检查');
    if (getUploadState().state !== 'success') throw new Error('发布安全检查未通过：上传未完成');
    if (!switchIsOn(getAiSwitch())) throw new Error('发布安全检查未通过：AI声明未开启');
    const now = getNowRadio();
    if (!now?.checked || now.getAttribute('aria-checked') === 'false') {
      throw new Error('发布安全检查未通过：未选择立即发布');
    }
    if (!attachedProduct || attachedProductLabel()?.textContent.trim() !== attachedProduct.anchorName) {
      throw new Error('发布安全检查未通过：没有本次精确商品ID挂载的确认记录');
    }
    const btn = getPostButton();
    if (!btn || !isEnabled(btn)) throw new Error('发布按钮不存在或不可用，取消点击');
    return true;
  }

  async function clickPublishButton() {
    // 最终点击当下再读一次DOM，防止等待完成后状态变红/重新检查。
    assertReadyToPublish();
    fireClick(getPostButton());
    await sleep(1500);
    // 未知语言的任何新弹窗都视为结果不确定，绝不替用户点“仍然发布”。
    const prematureCheck = getVisibleModalRoots().length > 0;
    if (prematureCheck) log('点击发布后出现确认弹窗，按发布结果不确定处理，不点击弹窗');
    return { clicked: true, prematureCheck };
  }

  // ===== 返回上传页 =====
  function isUploadPage() {
    return location.pathname.includes('/tiktokstudio/upload');
  }

  function isContentPage() {
    return location.pathname.includes('/tiktokstudio/content');
  }

  function findVisibleUploadEntranceButton() {
    const stableSelectors = ['button[data-tt="Sidebar_UploadEntrance_Button"]', 'button[data-tt="Sidebar_UploadEntrance_WideButton"]'];
    for (const selector of stableSelectors) {
      const button = Array.from(document.querySelectorAll(selector)).find((c) => isVisible(c) && isEnabled(c));
      if (button) return button;
    }
    const iconBtn = Array.from(document.querySelectorAll('[data-tt="Sidebar_UploadEntrance_Container"] button')).find(
      (c) => isVisible(c) && isEnabled(c) && Boolean(c.querySelector('[data-icon="PlusSquare"], [data-icon="plus-square"], svg'))
    );
    if (iconBtn) return iconBtn;
    const links = Array.from(document.querySelectorAll('a[href]')).filter((el) =>
      isVisible(el) && isEnabled(el) && new URL(el.href, location.href).pathname === '/tiktokstudio/upload');
    if (links.length === 1) return links[0];
    return null;
  }

  async function clickUploadEntranceAndWait() {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (isUploadPage()) return true;
      const uploadButton = await waitForOrNull(() => findVisibleUploadEntranceButton(), 10000, 200);
      if (!uploadButton) {
        log(`暂未找到左侧"上传"按钮，等待后重试（${attempt}/3）`);
        await humanDelay(800, 1600);
        continue;
      }
      log(`点击左侧"上传"返回上传页（${attempt}/3）`);
      fireClick(uploadButton);
      const reached = await waitForOrNull(() => isUploadPage() || null, 10000, 200);
      if (reached) return true;
      await humanDelay(800, 1600);
    }
    return false;
  }

  window.__tkq = {
    log,
    checkForAppCrash,
    assertProductPickerClosed,
    isUploadPage,
    isContentPage,
    getUploadState,
    getChecksState,
    assertChecksPassed,
    assertReadyToPublish,
    waitForUploadComplete,
    locateCaptionEditor,
    getCaptionSelectionText,
    waitForCaptionCleared,
    locateHashtagChip,
    confirmHashtagInserted,
    finalizeCaption,
    addProductLink,
    setAiDisclosure,
    setPublishNow,
    waitForChecksPassAndAssertSafe,
    clickPublishButton,
    clickUploadEntranceAndWait,
    humanDelay: (min, max) => humanDelay(min, max),
  };
}
