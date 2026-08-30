// 这个函数会被 Playwright 通过 page.evaluate 整体注入到 TikTok Studio 页面里执行。
// 必须是完全自包含的（不能引用外部闭包变量），所有需要的东西都通过 config 参数传进来。
// 内容基本是原油猴脚本 TikTokStudioBulkUploadV2 里"自动化步骤"那一段的搬运，
// 去掉了 GM_setValue/文件夹句柄/面板UI 这些只有油猴环境才需要的部分，
// 状态记录、调度、文件读取全部交给 Node 端（Playwright）负责。
export function installTkqInPage(config) {
  // 这里【故意】没有 `if (window.__tkq) return` 的单例守卫。
  // 那个守卫会把重装时传进来的新config悄悄丢掉，只保留第一次安装时的闭包——
  // 提交 e58da98 就是被它坑过一次(用空config装过之后，真实config再也装不进去)。
  // 现在文案可以由用户随时在网页上改，守卫会导致"改了配置但页面还用旧的"。
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

  // ===== 界面文案（跨语言/跨地区可配置）=====
  // 真实值由 Node 端 src/config.js 里的 DEFAULT_PAGE_TEXT 合并后传进来。
  // 这里【不】再复制一份印尼语默认值——那会变成第三处真值来源(config.js / app.js / 这里)，
  // 迟早漂移。这里只负责"取不到时安全降级"。
  const pageText = (config && config.text) || {};

  // 取"任一命中即可"的文案列表。保持原数组顺序：productConfirmButtons /
  // postButtonTexts / showMoreButtons 是按优先级排的，第一个匹配上的胜出，顺序不能乱。
  function textList(key) {
    const v = pageText[key];
    if (Array.isArray(v)) return v.filter((s) => typeof s === 'string' && s.trim());
    return typeof v === 'string' && v.trim() ? [v] : [];
  }

  // 取必填的单条文案。空值绝对不能放行：includes('') 恒为 true，
  // findClickableByText('') 会匹配到页面上随便一个空元素然后点下去。
  function requiredText(key, what) {
    const v = pageText[key];
    if (typeof v !== 'string' || !v.trim()) {
      throw new Error(
        `界面文案配置缺失：这个账号没有配置「${what}」对应的界面文字，无法安全定位元素。` +
          '请在控制台网页上编辑该账号，把界面文案填完整'
      );
    }
    return v;
  }

  // 页面文字匹配的统一入口：折叠空白 + 忽略大小写。
  // 忽略大小写是必需的——Chrome 的 innerText 会把 CSS text-transform 算进去，
  // TikTok 有些按钮是用CSS转成大写的，原样比较会匹配不上。
  function normText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function hasAnyMarker(haystack, markers) {
    if (!markers.length) return false;
    const h = normText(haystack);
    return markers.some((m) => h.includes(normText(m)));
  }

  function hasAllMarkers(haystack, markers) {
    // 空列表必须返回 false。[].every() 恒为 true，会让崩溃检测在每一轮的
    // 第一次 waitFor 就误报"页面崩溃"，整个账号立刻卡死并且报错信息完全误导。
    if (!markers.length) return false;
    const h = normText(haystack);
    return markers.every((m) => h.includes(normText(m)));
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

    // 用JS扫 placeholder，不再把用户填的文字拼进CSS属性选择器。
    // 用户会在这里填各种语言的任意文本，含引号或反斜杠时 querySelector 直接抛
    // SyntaxError；而且 [placeholder*=""] 在CSS里是"匹配不到任何元素"，
    // 空值时会静默让这半边检测失效。
    const placeholder = pageText.searchProductPlaceholder;
    if (typeof placeholder === 'string' && placeholder.trim()) {
      const hit = Array.from(root.querySelectorAll('input')).some((input) =>
        normText(input.getAttribute('placeholder')).includes(normText(placeholder))
      );
      if (hit) return true;
    }

    const text = root.innerText || root.textContent || '';
    return hasAnyMarker(text, textList('productModalMarkers'));
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
    // 这道闸门是靠"认弹窗上的字"实现的，两项文案都没配的话 isProductWorkflowModal
    // 会恒为 false —— 弹窗明明盖在上面，检查却说"没开着"，然后照样去点发布。
    // 这属于静默失效，必须停下来而不是放行。
    const placeholder = pageText.searchProductPlaceholder;
    const hasPlaceholder = typeof placeholder === 'string' && Boolean(placeholder.trim());
    if (!hasPlaceholder && !textList('productModalMarkers').length) {
      throw new Error(
        '界面文案配置缺失：这个账号没有配置「商品搜索框提示文字」和「商品弹窗里必然出现的字」，' +
          '无法判断商品弹窗是不是还开着。弹窗盖着时继续点击会误点到后面的页面，已停止。' +
          '请在控制台网页上编辑该账号补上这两项文案'
      );
    }
    if (hasOpenProductWorkflowModal()) {
      throw new Error(`商品流程弹窗仍然打开，禁止继续${nextAction}，避免后台误点击`);
    }
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

      // 这两条印尼语/英语正则【故意保留写死】，不改成可配置的纯文字：
      // 它们带着 "Diunggah(" 的括号锚点和 "Tersisa 30 detik" 的数字+单位锚点，
      // 换成普通子串会明显变松——"Diunggah"单独作为过去分词出现在别处就会被误判成
      // 上传完成，而"Mengunggah"出现在区块标题里会让"还在上传"永久卡住变成3分钟超时。
      // 用户配置的 marker 是【叠加】在这两条之上的(或的关系)，所以印尼语路径跟改动前
      // 完全一致，其它语言再补自己的词即可。
      const isExplicitDone =
        /Diunggah\s*\(|Uploaded\s*\(|Selesai/i.test(text) || hasAnyMarker(text, textList('uploadDoneMarkers'));
      const isUploading =
        /Tersisa\s*\d+\s*(?:detik|menit|s|m)|(?:Uploading|Mengunggah)\s*\(\d+%\)/i.test(text) ||
        hasAnyMarker(text, textList('uploadingMarkers'));
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
      // stableSince 初值是0，必须显式排除：否则文案为空时 caption !== stableText 为false，
      // 直接落到下面这行，Date.now() - 0 >= 1000 恒为true，"稳定1秒"这个要求等于没有，
      // 视频还在传就可能被判定成就绪。
      return stableSince && Date.now() - stableSince >= 1000 ? editable : null;
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
    const addBtn = await waitFor(() => findClickableByText(requiredText('addProductButton', '添加商品按钮'), true), 20000);
    fireClick(addBtn);

    const nextBtn1 = await waitFor(() => {
      const globalBtn = findClickableByText(requiredText('nextButton', '下一步按钮'), true);
      if (!globalBtn) return null;
      const dialog = getModalRoot(globalBtn);
      return findActionByTextsWithin(dialog, [requiredText('nextButton', '下一步按钮')]);
    });
    fireClick(nextBtn1);

    await sleep(500);
    const searchInput = await waitFor(() =>
      Array.from(document.querySelectorAll('input')).find(
        (input) => isVisible(input) && (input.getAttribute('placeholder') || '').includes(requiredText('searchProductPlaceholder', '商品搜索框提示文字'))
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
      const actionBtn = await waitFor(() => findActionByTextsWithin(activeModal, textList('productConfirmButtons')), 10000, 150);
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
    const radio = await waitFor(() => findClickableByText(requiredText('publishNowRadioLabel', '立即发布选项')));
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
        for (const t of textList('showMoreButtons')) {
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

    const findAiLabel = () => findByText('span', requiredText('aiDisclosureLabel', 'AI声明开关')) ||
      findByText('div', requiredText('aiDisclosureLabel', 'AI声明开关'));

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
      textList('postButtonTexts').map((t) => findClickableByText(t, true)).find(Boolean) ||
      null
    );
  }

  async function waitForChecksPassAndAssertSafe() {
    assertProductPickerClosed('点击Posting');

    // 版权/违规检测是唯一一个"配错了也看不出来"的检查——它只在视频真有问题时才触发，
    // 平时跑一百遍都不会暴露配错。所以没配就必须停下，绝不能当成"检查通过"放行，
    // 那等于把这道保护静默关掉还让人以为它开着。
    const violationMarkers = textList('violationMarkers');
    if (!violationMarkers.length) {
      throw new Error(
        '界面文案配置缺失：这个账号没有配置「版权/违规提示」的界面文字，' +
          '无法确认这条视频是否被TikTok判定违规。为避免把被标记的内容发出去，已停止。' +
          '请在控制台网页上编辑该账号补上这项文案'
      );
    }
    const checksPassedMarkers = textList('checksPassedMarkers');

    log('等待版权/内容检测完成…');
    const start = Date.now();
    const maxWaitMs = 45000;
    let explicitPassed = false;
    while (Date.now() - start < maxWaitMs) {
      checkForAppCrash();
      const text = document.body.innerText || '';
      if (hasAnyMarker(text, violationMarkers)) {
        throw new Error('检测到版权或内容严重违规，已自动暂停');
      }
      explicitPassed = hasAnyMarker(text, checksPassedMarkers);
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
    // 弹窗数量变多是语言无关的结构性信号；文字只是用来降低误判。
    // 文案没配时退化成"只看弹窗数量"，宁可多报也不漏报——误报的后果只是按
    // "发布结果不确定"暂停等人确认，是安全方向。
    const prematureMarkers = textList('prematureCheckMarkers');
    const modalAppeared = getVisibleModalRoots().length > modalsBefore;
    const prematureCheck = modalAppeared && (!prematureMarkers.length || hasAnyMarker(text, prematureMarkers));
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
    // 下面这条按文字找的分支【故意不做成可配置项】，虽然 'Unggah'/'Upload' 是印尼语/英语。
    // 它已经是第三道兜底了：前面两道靠 data-tt 属性和图标找，都是语言无关的；
    // 而且这条自己还带一个 href 含 '/upload' 的判断，同样语言无关。
    // 为它多加一个用户要填的输入框，收益抵不上让人多理解一项配置的成本。
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
    // 单独暴露出来，是为了让"商品弹窗还开着就不许点发布"这道安全闸门
    // 能被独立验证——它静默失效时从外部行为上完全看不出来。
    assertProductPickerClosed,
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
