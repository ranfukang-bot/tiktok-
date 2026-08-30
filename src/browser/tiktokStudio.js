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
// （注：曾经怀疑过这个多余的刷新是"Ada masalah"崩溃的诱因，后来用户指出崩溃点
// 其实在同一个页面内的加话题标签那一步，跟刷不刷新无关，真正的原因见 injected.js
// 里 fillCaption 的注释。少刷新这件事本身仍然值得保留，只是跟那个崩溃无关。）
// 刷新还顺带清掉了 window.__tkq，避免用错误config安装过的旧实例被复用
// （installTkqInPage 是"装过一次就不再重装"的单例），所以刷新过的分支后面
// 调用方还是会重新执行一次 installTkqInPage。
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

  // 清空默认标题 + 依次点三个历史话题标签，整段在页面里一次跑完，中间绝不能插进
  // Node端的等待或额外的 page.evaluate——历史标签面板会自己收起，拆开来点很容易
  // 撞上它正在重新渲染的瞬间，把整页点崩(详见 injected.js 里 fillCaption 的注释)。
  await humanDelay();
  await page.evaluate(() => window.__tkq.fillCaption());

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
  if (beforePublishClick) await beforePublishClick();

  await humanDelay();
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

  await page.evaluate(installTkqInPage, {});
  const backOnUploadPage = await page.evaluate(() => window.__tkq.clickUploadEntranceAndWait());
  if (!backOnUploadPage) {
    log.warn('发布已确认，但点击左侧"上传"没能回到上传页，下一轮会用直接跳转的方式兜底');
  }

  return { published: true };
}
