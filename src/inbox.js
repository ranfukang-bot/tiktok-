// 收件箱：盯着一个文件夹，把视频按文件名里的商品ID自动送进对应账号的文件夹。
//
// 解决的是这条链路上最费时间的一段：视频生成完之后，你要一条条下载、改名成商品ID、
// 再拖进对应账号的文件夹。账号一多，光是"这条该放哪个夹子"就要想半天。
// 现在只要文件名是 <商品ID>.mp4，丢进收件箱就不用管了——品单里写着它归谁。
//
// 三条硬规矩，都是为了"宁可不动，也不要动错"：
//   1. 认不出来的文件【原样留着】，不删不改不挪。收件箱同时也是你的下载目录，
//      里面还有别的东西，乱动就是事故。
//   2. 目标文件夹已经有同名文件就【不覆盖】，留在收件箱里等你看一眼。
//      覆盖掉的可能是还没发出去的视频。
//   3. 刚写完没多久的文件【先不碰】。下载到一半的文件挪走就是半个废文件。

import { readdir, stat, rename, copyFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { productIdFromFilename } from './folderScanner.js';
import { findJob } from './joblist.js';

// 文件最后一次写入之后至少要静置这么久才搬。Chrome 下载中的临时文件是 .crdownload，
// 本来就被扩展名过滤挡在外面了，这一条防的是别的下载器和网络盘同步。
const SETTLE_MS = 15 * 1000;

function isVideo(name, extensions) {
  const lower = name.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

// 同一块盘上 rename 是原子的，最快也最安全。跨盘会报 EXDEV，
// 那种情况只能先复制再删——复制失败就什么都不动，原文件还在收件箱里。
async function moveFile(from, to) {
  try {
    await rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await copyFile(from, to);
    await unlink(from);
  }
}

/**
 * 扫一遍收件箱，把认得出来的视频送进对应账号的文件夹。
 * 返回这一轮发生了什么，调用方负责打日志。
 */
export async function routeInbox(settings, accounts, joblist, { now = Date.now() } = {}) {
  const inbox = String(settings.inboxFolder || '').trim();
  if (!inbox) return { enabled: false, moved: [], skipped: [] };
  if (!existsSync(inbox)) {
    throw new Error(`收件箱文件夹不存在：${inbox}。检查一下路径，或者把全局设置里的收件箱清空来关掉这个功能`);
  }

  const extensions = settings.videoExtensions || ['.mp4', '.mov', '.avi', '.webm'];
  const items = Array.isArray(joblist) ? joblist : [];
  const moved = [];
  const skipped = [];

  const entries = await readdir(inbox, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !isVideo(entry.name, extensions)) continue;
    const from = path.join(inbox, entry.name);

    const info = await stat(from);
    if (now - info.mtimeMs < SETTLE_MS) continue; // 可能还在写，下一轮再说

    const productId = productIdFromFilename(entry.name);
    const job = findJob(items, productId);
    if (!job) {
      skipped.push({ filename: entry.name, reason: `品单里没有商品ID ${productId || '(文件名里读不出商品ID)'}` });
      continue;
    }
    if (!job.account) {
      skipped.push({ filename: entry.name, reason: `商品 ${productId} 还没在品单里指定发布账号` });
      continue;
    }
    const account = accounts.find((a) => a.name === job.account);
    if (!account) {
      skipped.push({ filename: entry.name, reason: `品单里写的账号"${job.account}"在账号列表里找不到` });
      continue;
    }
    if (!account.videoFolder || !existsSync(account.videoFolder)) {
      skipped.push({ filename: entry.name, reason: `账号"${job.account}"的视频文件夹不存在：${account.videoFolder || '(没填)'}` });
      continue;
    }

    const to = path.join(account.videoFolder, entry.name);
    if (existsSync(to)) {
      skipped.push({ filename: entry.name, reason: `账号"${job.account}"的文件夹里已经有同名文件了，没有覆盖，请自己看一眼` });
      continue;
    }

    await moveFile(from, to);
    moved.push({ filename: entry.name, productId, account: job.account, to });
  }

  return { enabled: true, moved, skipped };
}
