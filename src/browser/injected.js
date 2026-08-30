// 这个函数会被 Playwright 通过 page.evaluate 整体注入到 TikTok Studio 页面里执行。
// 必须是完全自包含的（不能引用外部闭包变量），所有需要的东西都通过 config 参数传进来。
// 内容基本是原油猴脚本 TikTokStudioBulkUploadV2 里"自动化步骤"那一段的搬运，
// 去掉了 GM_setValue/文件夹句柄/面板UI 这些只有油猴环境才需要的部分，
// 状态记录、调度、文件读取全部交给 Node 端（Playwright）负责。
export function installTkqInPage(config) {
  if (window.__tkq) return; // 避免同一个页面被重复安装

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

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function isEnabled(el) {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if (window.getComputedStyle(el).pointerEvents === 'none') return false;
    return true;
  }

  function findByText(tag, text, exact = false) {
    const nodes = Array.from(document.querySelectorAll(tag));
    return nodes.find((el) => {
      const t = (el.textContent || '').trim();
      if (!isVisible(el)) return false;
      return exact ? t === text : t.includes(text);
    });
  }

  function findClickableByText(text, exact = false) {
    const candidates = ['button', 'div', 'span', 'a', 'label'];
    for (const tag of candidates) {
      const el = findByText(tag, text, exact);
      if (el) {
        const btnAncestor = el.closest('button');
        return btnAncestor || el;
      }
    }
    return null;
  }

  function findActionByTextsWithin(root, texts) {
    if (!root) return null;
    const candidates = Array.from(root.querySelectorAll('button, [role="button"]'));
    for (const text of texts) {
      const match = candidates.find((el) => isVisible(el) && isEnabled(el) && (el.textContent || '').trim() === text);
      if (match) return match;
    }
    return null;
  }

  function getModalRoot(el) {
    if (!el) return null;
    const modalSelector = [
      '[role="dialog"]',
      '[aria-modal="true"]',
      '.TUXModal',
      '[class*="TUXModal"]',
      '[class*="modal-content"]',
      '[class*="ModalContent"]',
      '[class*="modal-container"]',
      '[class*="ModalContainer"]',
    ].join(',');

    let semanticRoot = null;
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      if (node.matches(modalSelector)) semanticRoot = node;
    }
    if (semanticRoot) return semanticRoot;

    let fixedRoot = null;
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      if (window.getComputedStyle(node).position === 'fixed') fixedRoot = node;
    }
    return fixedRoot || document.body;
  }

  function getVisibleModalRoots() {
    const selector = [
      '[role="dialog"]',
      '[aria-modal="true"]',
      '.TUXModal',
      '[class*="TUXModal"]',
      '[class*="modal-container"]',
      '[class*="ModalContainer"]',
    ].join(',');
    const roots = [];
    for (const candidate of document.querySelectorAll(selector)) {
      if (!isVisible(candidate)) continue;
      const root = getModalRoot(candidate);
      if (root && root !== document.body && isVisible(root) && !roots.includes(root)) roots.push(root);
    }
    return roots;
  }

  function isProductWorkflowModal(root) {
    if (!root || !isVisible(root)) return false;
    const text = (root.innerText || root.textContent || '').replace(/\s+/g, ' ').trim();
    return (
      Boolean(root.querySelector(`input[placeholder*="${config.text.searchProductPlaceholder}"]`)) ||
      text.includes('Tambah tautan') ||
      text.includes('Nama produk')
    );
  }

  function getTopProductWorkflowModal() {
    return getVisibleModalRoots().filter(isProductWorkflowModal).pop() || null;
  }

  function hasOpenProductWorkflowModal() {
    return Boolean(getTopProductWorkflowModal());
  }

  function hasAttachedProduct() {
    return Array.from(document.querySelectorAll('.anchor-container .content-anchor-label')).some(isVisible);
  }

  function assertProductPickerClosed(nextAction) {
    if (hasOpenProductWorkflowModal()) {
      throw new Error(`商品流程弹窗仍然打开，禁止继续${nextAction}，避免后台误点击`);
    }
  }

  function checkForAppCrash() {
    const text = document.body.innerText || '';
    if (text.includes('Ada masalah') && text.includes('Coba lagi')) {
      throw new Error('TikTok页面自己崩溃报错了(Ada masalah/Coba lagi)，需要人工刷新页面重试');
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

  async function waitForUploadComplete(filename) {
    const expectedDefaultCaption = filename.replace(/\.[^.]+$/, '').trim();
    const productId = expectedDefaultCaption.replace(/\s*\(\d+\)$/, '');
    let stableText = '';
    let stableSince = 0;
    log('等待视频上传并等待TikTok填入默认标题…');
    await waitFor(() => {
      const text = document.body.innerText || '';
      const editable = getCaptionEditable();
      const caption = getCaptionText(editable);

      const isExplicitDone = /Diunggah\s*\(|Uploaded\s*\(|Selesai/i.test(text);
      const isUploading = /Tersisa\s*\d+\s*(?:detik|menit|s|m)|(?:Uploading|Mengunggah)\s*\(\d+%\)/i.test(text);
      const hasVideoPreview = Boolean(
        document.querySelector('video') ||
          document.querySelector('[data-e2e="video_preview"]') ||
          document.querySelector('.preview-container') ||
          document.querySelector('.player-container')
      );
      const isExpectedDefault = caption && (caption.includes(expectedDefaultCaption) || caption.includes(productId));

      if (isUploading && !isExplicitDone) {
        stableText = '';
        stableSince = 0;
        return null;
      }
      if (!editable || (!isExpectedDefault && !hasVideoPreview && !isExplicitDone)) {
        stableText = '';
        stableSince = 0;
        return null;
      }
      if (caption !== stableText) {
        stableText = caption;
        stableSince = Date.now();
        return null;
      }
      return Date.now() - stableSince >= 1000 ? editable : null;
    }, 3 * 60 * 1000, 200);
    log(`视频和默认标题均已就绪 ✅（待清空：${stableText.slice(0, 80)}）`);
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

  // ===== 商品挂车 =====
  async function addProductLink(productId) {
    log('开始添加商品链接: ' + productId);
    const addBtn = await waitFor(() => findClickableByText(config.text.addProductButton, true), 20000);
    fireClick(addBtn);

    const nextBtn1 = await waitFor(() => {
      const globalBtn = findClickableByText(config.text.nextButton, true);
      if (!globalBtn) return null;
      const dialog = getModalRoot(globalBtn);
      return findActionByTextsWithin(dialog, [config.text.nextButton]);
    });
    fireClick(nextBtn1);

    await sleep(500);
    const searchInput = await waitFor(() =>
      Array.from(document.querySelectorAll('input')).find(
        (input) => isVisible(input) && (input.getAttribute('placeholder') || '').includes(config.text.searchProductPlaceholder)
      )
    );
    const productDialog = getModalRoot(searchInput);
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(searchInput, productId);
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));

    const searchIcon = await waitFor(
      () => productDialog.querySelector('.product-search-icon') || searchInput.parentElement.querySelector('svg')?.closest('div')
    );
    fireClick(searchIcon);

    const findProductRow = () => {
      const rows = Array.from(productDialog.querySelectorAll('tr, [role="row"]')).filter(isVisible);
      return rows.find((r) => {
        const leafCells = Array.from(r.querySelectorAll('*')).filter((el) => el.children.length === 0);
        return leafCells.some((cell) => (cell.textContent || '').trim() === productId.trim());
      });
    };
    let row = await waitFor(findProductRow, 10000);
    let radio = row.querySelector('input[type="radio"].TUXRadioStandalone-input') || row.querySelector('input[type="radio"]');
    if (!radio) throw new Error('找到了商品行但没找到单选框，需要人工检查页面结构');

    const isSelected = () => {
      row = findProductRow();
      if (!row) return false;
      radio = row.querySelector('input[type="radio"].TUXRadioStandalone-input') || row.querySelector('input[type="radio"]');
      if (!radio) return false;
      return (
        radio.checked ||
        radio.getAttribute('aria-checked') === 'true' ||
        row.getAttribute('aria-selected') === 'true' ||
        Boolean(radio.closest('[aria-checked="true"], [data-state="checked"]'))
      );
    };

    const explicitLabel = radio.id ? Array.from(productDialog.querySelectorAll('label')).find((l) => l.htmlFor === radio.id) : null;
    const radioClickTarget = explicitLabel || radio.closest('label') || radio.closest('[role="radio"]') || radio.parentElement || radio;
    fireClick(radioClickTarget);

    let selectionConfirmed = await waitForOrNull(() => isSelected() || null, 3000, 100);
    if (!selectionConfirmed && radioClickTarget !== radio) {
      log('商品单选框第一次点击未生效，尝试点击radio本体');
      fireClick(radio);
      selectionConfirmed = await waitForOrNull(() => isSelected() || null, 3000, 100);
    }
    if (!selectionConfirmed) {
      throw new Error(`商品 ${productId} 已搜到，但单选框没有真正选中，已停止后续发布`);
    }
    log('商品已选中，等待最终确认按钮可用');

    let dialogClosed = false;
    for (let step = 1; step <= 4; step++) {
      const activeModal = await waitFor(getTopProductWorkflowModal, 10000, 150);
      const actionBtn = await waitFor(() => findActionByTextsWithin(activeModal, config.text.productConfirmButtons), 10000, 150);
      const actionRoot = getModalRoot(actionBtn);
      const actionText = (actionBtn.textContent || '').trim();
      log(`点击商品弹窗操作按钮(${step}/4): ${actionText}`);
      fireClick(actionBtn);

      const outcome = await waitForOrNull(() => {
        if (!hasOpenProductWorkflowModal() && hasAttachedProduct()) return 'closed';
        const rootClosed = actionRoot !== document.body && (!actionRoot.isConnected || !isVisible(actionRoot));
        const actionReplaced = !actionBtn.isConnected || !isVisible(actionBtn);
        const nextModal = getTopProductWorkflowModal();
        if ((rootClosed || actionReplaced) && nextModal) return 'advanced';
        if (nextModal && nextModal !== actionRoot) return 'advanced';
        return null;
      }, 8000, 150);

      if (outcome === 'closed') {
        dialogClosed = true;
        break;
      }
      if (outcome !== 'advanced') {
        throw new Error(`商品弹窗按钮"${actionText}"点击后页面没有变化，已停止后续发布`);
      }
      log('商品弹窗已进入下一步，继续查找最终确认按钮');
      await sleep(400);
    }

    if (!dialogClosed) {
      dialogClosed = Boolean(
        await waitForOrNull(() => !hasOpenProductWorkflowModal() && hasAttachedProduct(), 5000, 150)
      );
    }
    if (!dialogClosed) {
      throw new Error('商品弹窗经过最多4步仍未关闭，或页面没有出现商品锚点；挂车未确认，已停止后续发布');
    }
    log('商品链接添加完成: ' + productId);
  }

  async function setPublishNow() {
    assertProductPickerClosed('设置立即发布');
    const radio = await waitFor(() => findClickableByText(config.text.publishNowRadioLabel));
    fireClick(radio);
    await sleep(300);
    const input = radio.closest('div')?.querySelector('input[type="radio"]');
    if (input && !input.checked) {
      log('⚠️ "立即发布"看起来没有被选中，尝试直接点击radio本体');
      fireClick(input);
    }
  }

  async function setAiDisclosure() {
    assertProductPickerClosed('设置AI声明');

    // 之前靠 isVisible(label) 判断"要不要点展开"不可靠：折叠区域用的是
    // max-height:0 + overflow:hidden 之类的CSS折叠，被折叠起来的元素自己的
    // getBoundingClientRect 未必是0（裁剪是父级视觉层面的事，不影响子元素的
    // 布局盒模型），导致isVisible()误判成"已经可见"，从而跳过了点击"展开更多"
    // 这一步——这正是"连展开都没展开"的根因。改成直接看容器class里有没有
    // "collapsed"，这是抓到的真实DOM给出的明确信号，比猜可见性靠谱。
    const getAdvancedContainer = () => document.querySelector('[data-e2e="advanced_settings_container"]');
    const isCollapsed = () => {
      const container = getAdvancedContainer();
      return Boolean(container && container.classList.contains('collapsed'));
    };

    if (isCollapsed()) {
      const expandTrigger = await waitForOrNull(() => {
        const container = getAdvancedContainer();
        const btn = container ? container.querySelector('.more-btn') : null;
        if (btn) return btn;
        for (const t of config.text.showMoreButtons) {
          const b = findClickableByText(t, false);
          if (b) return b;
        }
        return null;
      }, 5000);
      if (!expandTrigger) {
        throw new Error('设置AI声明：高级设置区域是折叠状态，但没找到"展开更多"按钮，需要人工检查页面结构');
      }
      fireClick(expandTrigger);
      const expanded = await waitForOrNull(() => (!isCollapsed() ? true : null), 3000, 100);
      if (!expanded) {
        throw new Error('设置AI声明：点击"展开更多"后高级设置区域没有展开，需要人工检查页面结构');
      }
      log('已展开高级设置区域');
      await sleep(300);
    }

    const findAiLabel = () => findByText('span', config.text.aiDisclosureLabel) || findByText('div', config.text.aiDisclosureLabel);

    // 实际抓到的DOM结构里，role="switch"的是那个隐藏的<input>，跟可见的thumb是
    // 兄弟节点（都在同一个 Switch__content 容器下），不是thumb的祖先节点，
    // 用 thumb.closest('[role="switch"]') 永远找不到，只会退化到点thumb的父级容器，
    // 而那个容器不一定绑了真正的点击事件——这就是之前"点了但没生效"的原因。
    const found = await waitFor(() => {
      const currentLabel = findAiLabel();
      if (!currentLabel) return null;
      const row = currentLabel.closest('div');
      if (!row) return null;
      const checkbox = row.querySelector('input[role="switch"], input[type="checkbox"]');
      const wrapper = checkbox ? checkbox.closest('[data-state]') : null;
      const thumb = row.querySelector('[data-part="thumb"]');
      return checkbox || thumb ? { checkbox, wrapper, thumb } : null;
    }, 10000);

    const isChecked = () => {
      if (found.checkbox) return found.checkbox.checked || found.checkbox.getAttribute('aria-checked') === 'true';
      if (found.wrapper) return found.wrapper.getAttribute('data-state') === 'checked' || found.wrapper.getAttribute('aria-checked') === 'true';
      return found.thumb && found.thumb.getAttribute('data-state') === 'checked';
    };

    if (isChecked()) {
      log('AI声明开关已经是打开状态，跳过');
      return;
    }

    // 优先直接点隐藏的checkbox本体（真正承载开关状态和事件的元素），
    // 不行再退一步点它外层带 data-state 的可视容器。
    const primaryTarget = found.checkbox || found.wrapper || found.thumb.parentElement;
    fireClick(primaryTarget);
    let toggled = await waitForOrNull(() => isChecked() || null, 2500, 100);

    if (!toggled && found.checkbox && found.wrapper && primaryTarget !== found.wrapper) {
      log('直接点击开关本体未生效，尝试点击外层容器');
      fireClick(found.wrapper);
      toggled = await waitForOrNull(() => isChecked() || null, 2500, 100);
    }

    if (!toggled) {
      throw new Error('AI声明开关点击后没有变成打开状态，已停止后续发布，需要人工检查页面结构（开关的DOM结构可能又变了）');
    }
    log('AI声明开关已打开');
  }

  function getPostButton() {
    return (
      document.querySelector('[data-e2e="post_video_button"]') ||
      config.text.postButtonTexts.map((t) => findClickableByText(t, true)).find(Boolean) ||
      null
    );
  }

  async function waitForChecksPassAndAssertSafe() {
    assertProductPickerClosed('点击Posting');
    log('等待"Pemeriksaan"版权/内容检测完成…');
    const start = Date.now();
    const maxWaitMs = 45000;
    let explicitPassed = false;
    while (Date.now() - start < maxWaitMs) {
      checkForAppCrash();
      const text = document.body.innerText || '';
      if (text.includes('Masalah hak cipta ditemukan') || text.includes('Pelanggaran terdeteksi') || text.includes('Video tidak dapat diposting')) {
        throw new Error('检测到版权或内容严重违规，已自动暂停');
      }
      explicitPassed =
        text.includes('Tidak ada masalah yang ditemukan') || text.includes('Tidak ditemukan masalah') || text.includes('Pemeriksaan selesai');
      if (explicitPassed) {
        log('检测到明确的"检查通过"提示 ✅');
        break;
      }
      await sleep(1000);
    }
    if (!explicitPassed) {
      // 实测发现"发布按钮是否可点"这个信号不可靠：有些账号上按钮全程都是可点状态，
      // TikTok不是靠禁用按钮拦截过早提交，而是点了之后弹一个"检查还没做完，要不要
      // 硬提交"的确认框。所以这里不再用"按钮亮了"当作检查已完成的证据，没等到明确
      // 的"检查通过"文案就只能老实等满时间；点击后 clickPublishButton 还会再确认一次。
      log('⚠️ 没等到明确的"检查通过"提示，已等满最长时间，仍会继续，但点击后会再核实一次');
    }
    assertCaptionSafe('内容检测完成后的文案终检');
    log('等待Posting按钮变亮…');
    const submitBtn = await waitFor(() => {
      const btn = getPostButton();
      return btn && isEnabled(btn) ? btn : null;
    }, 60 * 1000, 1000);
    await sleep(500);
    assertCaptionSafe('点击Posting前最后检查');
    return Boolean(submitBtn);
  }

  async function clickPublishButton() {
    assertProductPickerClosed('点击Posting');
    const btn = getPostButton();
    if (!btn || !isEnabled(btn)) throw new Error('发布按钮不存在或不可用，取消点击');
    const modalsBefore = getVisibleModalRoots().length;
    fireClick(btn);

    // 点完之后看一眼是不是弹出了"检查还没做完，确定要提交吗"这类确认框——
    // 目前只能靠"新出现了一个包含Pemeriksaan字样的弹窗"这个不太精确的信号猜，
    // 没有更准确的选择器可用。猜中了就直接按"发布结果不确定"处理，绝不会替用户
    // 点这个确认框（不管它默认是"确认"还是"取消"），一律交给人工核实。
    await sleep(1500);
    const text = document.body.innerText || '';
    const prematureCheck = /Pemeriksaan/i.test(text) && getVisibleModalRoots().length > modalsBefore;
    if (prematureCheck) {
      log('⚠️ 点击发布后检测到疑似"检查未完成"的确认框，按发布结果不确定处理');
    }
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
    const sidebar = document.querySelector('nav, aside, [class*="sidebar"], [class*="Sidebar"]');
    if (sidebar) {
      const candidates = Array.from(sidebar.querySelectorAll('button, a')).filter((el) => isVisible(el) && isEnabled(el));
      const match = candidates.find((el) => {
        const text = (el.textContent || '').trim();
        return text.includes('Unggah') || text.includes('Upload') || (el.getAttribute('href') || '').includes('/upload');
      });
      if (match) return match;
    }
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
    isUploadPage,
    isContentPage,
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
