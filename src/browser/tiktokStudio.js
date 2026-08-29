import path from 'node:path';
import { installTkqInPage } from './injected.js';

const UPLOAD_URL = 'https://www.tiktok.com/tiktokstudio/upload?from=upload';
const PUBLISH_CONFIRM_TIMEOUT_MS = 45000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function installAndBridgeLogs(page, log) {
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.startsWith('[TKQ]')) log.info(text.slice(5).trim());
  });
}

async function ensureOnUploadPage(page, log) {
  if (!page.url().includes('/tiktokstudio/upload')) {
    log.info('导航到上传页…');
    await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded' });
  }
  await page.evaluate(installTkqInPage, {});
}

// 返回 { published: true } | { published: false, uncertain: true }
// beforePublishClick: 点击发布前调用（把 pendingIndex 落盘），防止点击后页面跳转、
// Node进程如果这时候崩了也能在重启后知道"上一条点了发布但结果没确认"，需要人工核实。
export async function runOneUploadCycle({ page, account, item, config, log, beforePublishClick }) {
  await ensureOnUploadPage(page, log);
  await installAndBridgeLogs(page, log);
  await page.evaluate(installTkqInPage, config);

  const absolutePath = path.join(account.videoFolder, item.relativePath.split('/').join(path.sep));
  log.info(`开始处理: ${item.relativePath} -> 商品ID ${item.productId}`);

  const fileInput = page.locator('input[type="file"][accept="video/*"]').first();
  await fileInput.waitFor({ state: 'attached', timeout: 30000 });
  await fileInput.setInputFiles(absolutePath);

  await page.evaluate(([filename]) => window.__tkq.waitForUploadComplete(filename), [item.filename]);
  await page.evaluate(() => window.__tkq.fillCaption());
  await page.evaluate(([productId]) => window.__tkq.addProductLink(productId), [item.productId]);
  await page.evaluate(() => window.__tkq.setAiDisclosure());
  await page.evaluate(() => window.__tkq.setPublishNow());
  await page.evaluate(() => window.__tkq.waitForChecksPassAndAssertSafe());

  // 点击发布前先让调用方把 pendingIndex 落盘：点击后页面可能立刻跳转，
  // 后续代码来不及执行；跳没跳转由 Node 端在点击后用 page.waitForURL 判断，
  // 不依赖页面上下文存活。
  if (beforePublishClick) await beforePublishClick();

  log.info('点击最终发布按钮…');
  await page.evaluate(() => window.__tkq.clickPublishButton());

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
