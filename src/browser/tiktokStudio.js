import { installTkqInPage } from './injected.js';
import { resolveItemPath } from '../folderScanner.js';

const UPLOAD_URL = 'https://www.tiktok.com/tiktokstudio/upload?from=upload';
const PUBLISH_CONFIRM_TIMEOUT_MS = 45000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 原油猴脚本每个大步骤之间都有这种随机停顿，避免所有操作像机器一样毫无间隔地连续
// 发生。移植成 Playwright 版本时这些停顿被漏掉了，导致整套流程点得飞快——这个函数
// 补回来，在 Node 端各步骤之间调用。
function humanDelay(minMs = 800, maxMs = 2200) {
  return sleep(minMs + Math.random() * (maxMs - minMs));
}

// 同一个账号的浏览器页面会跨多次发布周期反复复用，这个函数每个周期都会被调用一次；
// 用标记位保证监听器只挂一次，不然日志会一轮比一轮重复得更多次。
function installAndBridgeLogs(page, log) {
  if (page.__tkqListenersInstalled) return;
  page.__tkqListenersInstalled = true;
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.startsWith('[TKQ]')) log.info(text.slice(5).trim());
  });
  // 上一条如果是中途失败退出的，页面可能停在"要不要放弃未发布的草稿"这类确认框上；
  // 下面的强制刷新会撞上它，不自动接受的话 goto 会一直卡住。
  page.on('dialog', (dialog) => dialog.accept().catch(() => {}));
}

// 文案/话题标签：只走"点历史标签面板里的chip"这一条路径。
//
// 之前试过找不到chip时改用键盘/execCommand把文字直接打进去当兜底，撤回了：
// 实测发现那样打出来的"#fyp"只是纯文本，不会被TikTok识别成真正的话题标签
// （不会有被人搜到的效果）。用chip点出来的才是TikTok自己认的真话题，宁可要求
// "新账号先手动发一条建立历史记录"这个一次性的麻烦步骤。
//
// 标题清空和chip点击都必须走CDP真实输入事件。真实TikTok上的A/B复现结果：
//   旧 execCommand 清空 + element.click()   -> 崩
//   旧 execCommand 清空 + page.mouse.click() -> 仍然崩
//   Ctrl+A/Backspace + page.mouse.click()     -> 三个标签全部成功
// 因此根因是旧清空路径让Draft.js的可见DOM与EditorState/选区不同步；后续无论用
// 哪种方式点chip，插入标签都会触发错误边界。下面完整复刻手动成功的输入序列。
async function clearCaptionWithRealKeyboard(page, log) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const target = await page.evaluate(() => window.__tkq.locateCaptionEditor());
    if (!target) throw new Error('找不到可见的文案编辑框，无法安全清空默认标题');

    await page.mouse.move(target.x, target.y);
    await sleep(60 + Math.random() * 90);
    await page.mouse.click(target.x, target.y);
    await sleep(120 + Math.random() * 100);

    if (target.text) {
      await page.keyboard.press('Control+A');
      await sleep(180 + Math.random() * 120);
      const selectedText = await page.evaluate(() => window.__tkq.getCaptionSelectionText());
      if (!selectedText) {
        log.warn(`真实键盘没有全选到默认标题，正在重试（${attempt}/3）`);
        await humanDelay(350, 650);
        continue;
      }
      await page.keyboard.press('Backspace');
    }

    const cleared = await page.evaluate(() => window.__tkq.waitForCaptionCleared());
    if (cleared) {
      log.info(`已用真实 Ctrl+A + Backspace 清空默认标题（第${attempt}次）`);
      return;
    }

    log.warn(`默认标题在真实键盘清空后又被页面恢复，正在重试（${attempt}/3）`);
    await humanDelay(350, 650);
  }

  throw new Error('Draft.js没有稳定清空默认标题，已停止，绝不会带商品ID/文件名发布');
}

export async function fillCaption(page, config, log) {
  // 真实鼠标/键盘事件依赖当前页面焦点和视口坐标，先把标签页提到前台
  await page.bringToFront().catch(() => {});

  await clearCaptionWithRealKeyboard(page, log);
  await humanDelay(1200, 2000);

  for (const keyword of config.hashtagKeywords) {
    const pos = await page.evaluate(([k]) => window.__tkq.locateHashtagChip(k), [keyword]);
    if (!pos) {
      throw new Error(
        `没找到历史话题 #${keyword} 的建议项。这个账号大概率还没用过这个标签，需要你先在这个账号的` +
          `TikTok Studio里手动发一条带上 #${keyword} 的作品，TikTok记住这个历史标签之后，自动发布才点得到它`
      );
    }

    // 走CDP Input域派发完整的 pointerdown/mousedown/mouseup/click，isTrusted:true，
    // 跟真人点击在事件层面无法区分——诊断里真人手点是能成功的，这里就是在复刻它。
    await page.mouse.move(pos.x, pos.y);
    await sleep(60 + Math.random() * 90);
    await page.mouse.click(pos.x, pos.y);

    await page.evaluate(([k]) => window.__tkq.confirmHashtagInserted(k), [keyword]);
    await humanDelay(400, 900);
  }

  return page.evaluate(() => window.__tkq.finalizeCaption());
}

// 页面是不是已经处于"可以直接选文件"的干净状态：在上传页、有可用的文件输入框、
// 且没有已经选中在编辑中的视频（上一次如果失败在选完文件之后，会卡在"编辑已选
// 视频"这个状态，这时候页面上根本没有 <input type=file>）。
async function isCleanUploadPage(page) {
  if (!page.url().includes('/tiktokstudio/upload')) return false;
  try {
    await page.locator('input[type="file"][accept="video/*"]').first().waitFor({ state: 'attached', timeout: 3000 });
  } catch {
    return false;
  }
  return page.evaluate(() => !document.querySelector('video, [data-e2e="video_preview"]'));
}

// 原脚本全程待在同一个页面里，靠点侧边栏"上传"按钮做页内跳转，从来不整页刷新，
// 这里跟着它来：只在页面确实不干净时才刷新。发布成功后已经通过
// clickUploadEntranceAndWait 正常跳回了干净的上传页，下一轮再对着这个刚启动完的
// 页面重新整页刷新一次纯属多余。
// （注：曾经怀疑过这个多余的刷新是"Ada masalah"崩溃的诱因，已被真实A/B实验证伪——
// 真正的根因是旧的 execCommand 清空标题路径破坏了 Draft.js 状态，见上面 fillCaption
// 的注释。少刷新这件事本身仍然值得保留，只是跟那个崩溃无关。）
// 每一轮都重新安装页面助手，更新配置并清除上一轮的商品挂载确认记录。
async function ensureOnUploadPage(page, log) {
  if (await isCleanUploadPage(page)) {
    log.info('页面已经是干净的上传页，不用整页刷新');
    return;
  }
  log.info('页面不干净（比如上次失败卡在编辑视频的状态），刷新到全新的上传页…');
  await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded' });
}

// 返回 { published: true } | { published: false, uncertain: true }
// beforePublishClick: 点击发布前调用（把 pendingIndex 落盘），防止点击后页面跳转、
// Node进程如果这时候崩了也能在重启后知道"上一条点了发布但结果没确认"，需要人工核实。
export async function runOneUploadCycle({ page, account, item, config, log, beforePublishClick }) {
  installAndBridgeLogs(page, log);
  await ensureOnUploadPage(page, log);
  await page.evaluate(installTkqInPage, config);

  const absolutePath = resolveItemPath(account.videoFolder, item);
  log.info(`开始处理: ${item.relativePath} -> 商品ID ${item.productId}`);

  const fileInput = page.locator('input[type="file"][accept="video/*"]').first();
  await fileInput.waitFor({ state: 'attached', timeout: 30000 });
  await fileInput.setInputFiles(absolutePath);

  await humanDelay(1500, 3000);
  await page.evaluate(([filename]) => window.__tkq.waitForUploadComplete(filename), [item.filename]);

  await humanDelay();
  await fillCaption(page, config, log);

  await humanDelay();
  await page.evaluate(([productId]) => window.__tkq.addProductLink(productId), [item.productId]);

  await humanDelay();
  await page.evaluate(() => window.__tkq.setAiDisclosure());

  await humanDelay();
  await page.evaluate(() => window.__tkq.setPublishNow());

  await humanDelay();
  await page.evaluate(() => window.__tkq.waitForChecksPassAndAssertSafe());

  // 点击发布前先让调用方把 pendingIndex 落盘：点击后页面可能立刻跳转，
  // 后续代码来不及执行；跳没跳转由 Node 端在点击后用 page.waitForURL 判断，
  // 不依赖页面上下文存活。
  await humanDelay();
  // 延迟后重新检查双绿、AI、立即发布和本轮商品，安全闸门失败时尚未记为发布尝试。
  await page.evaluate(() => window.__tkq.assertReadyToPublish());
  if (beforePublishClick) await beforePublishClick();
  log.info('点击最终发布按钮…');
  const clickResult = await page.evaluate(() => window.__tkq.clickPublishButton());
  if (clickResult && clickResult.prematureCheck) {
    log.warn('检测到疑似"版权检查未完成"的确认框，不再等待跳转，按发布结果不确定处理');
    return { published: false, uncertain: true };
  }

  try {
    await page.waitForURL(/\/tiktokstudio\/content/, { timeout: PUBLISH_CONFIRM_TIMEOUT_MS });
  } catch {
    return { published: false, uncertain: true };
  }

  log.info('检测到发布后进入内容页，已确认本条发布成功');
  await sleep(1200 + Math.random() * 1200);

  // 必须传真实config，不能像以前那样传 {}。跳到内容页时JS环境被销毁，这里是重装；
  // 传空对象的话，下面这些方法拿到的就是一份没有任何文案的配置。更要命的是这段跑在
  // 发布点击【之后】(publishAttempted 已为 true)，一旦抛错会被判成"发布结果不确定"，
  // 结果就是：视频其实发成功了，账号却被暂停并推送通知，源文件也不会被清理。
  // 提交 e58da98 记录过同类事故。
  await page.evaluate(installTkqInPage, config);
  const backOnUploadPage = await page.evaluate(() => window.__tkq.clickUploadEntranceAndWait());
  if (!backOnUploadPage) {
    log.warn('发布已确认，但点击左侧"上传"没能回到上传页，下一轮会用直接跳转的方式兜底');
  }

  return { published: true };
}
