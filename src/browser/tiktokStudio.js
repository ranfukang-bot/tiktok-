import path from 'node:path';
import { installTkqInPage } from './injected.js';

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

// 每次都强制刷新回全新的上传页，不信任"看起来已经在上传页"就直接复用——
// 上一次如果失败在选完文件之后，页面会停在"编辑已选视频"的状态，
// 这时候页面上根本没有 <input type=file>，复用旧状态会导致后续找不到上传框。
// 刷新还顺带清掉了 window.__tkq，避免下面用错误config安装过的旧实例被复用
// （installTkqInPage 是"装过一次就不再重装"的单例，配置传错了也没法覆盖）。
async function ensureOnUploadPage(page, log) {
  log.info('刷新到干净的上传页…');
  await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded' });
}

// 返回 { published: true } | { published: false, uncertain: true }
// beforePublishClick: 点击发布前调用（把 pendingIndex 落盘），防止点击后页面跳转、
// Node进程如果这时候崩了也能在重启后知道"上一条点了发布但结果没确认"，需要人工核实。
export async function runOneUploadCycle({ page, account, item, config, log, beforePublishClick }) {
  installAndBridgeLogs(page, log);
  await ensureOnUploadPage(page, log);
  await page.evaluate(installTkqInPage, config);

  const absolutePath = path.join(account.videoFolder, item.relativePath.split('/').join(path.sep));
  log.info(`开始处理: ${item.relativePath} -> 商品ID ${item.productId}`);

  const fileInput = page.locator('input[type="file"][accept="video/*"]').first();
  await fileInput.waitFor({ state: 'attached', timeout: 30000 });
  await fileInput.setInputFiles(absolutePath);

  await humanDelay(1500, 3000);
  await page.evaluate(([filename]) => window.__tkq.waitForUploadComplete(filename), [item.filename]);

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
