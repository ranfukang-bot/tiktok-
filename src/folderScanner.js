import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

// 与原油猴脚本保持一致的规则：文件名(去扩展名、去" (1)"这类重名后缀)就是商品ID。
export function productIdFromFilename(name) {
  let base = name.replace(/\.[^.]+$/, '');
  base = base.replace(/\s*\(\d+\)$/, '');
  return base.trim();
}

function isVideoFilename(name, extensions) {
  const lower = name.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

export async function scanDirectory(rootDir, extensions, prefix = '') {
  const dir = prefix ? path.join(rootDir, prefix) : rootDir;
  const entries = await readdir(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...(await scanDirectory(rootDir, extensions, relativePath)));
    } else if (entry.isFile() && isVideoFilename(entry.name, extensions)) {
      const full = path.join(rootDir, relativePath);
      const info = await stat(full);
      results.push({
        filename: entry.name,
        relativePath,
        productId: productIdFromFilename(entry.name),
        size: info.size,
        mtimeMs: Math.round(info.mtimeMs),
      });
    }
  }
  return results;
}

function queueIdentity(item) {
  return `${(item.relativePath || item.filename).toLowerCase()}|${item.size || 0}|${item.mtimeMs || 0}`;
}

// 直接对应原脚本 syncFilesIntoQueue：保留原队列顺序和已完成计数，
// 只把文件夹里已经不存在的项目真正删掉，新文件追加到队尾。
export function syncFilesIntoQueue(state, records) {
  records = [...records].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true })
  );

  if (state.items.length === 0) {
    state.items = records;
    state.doneIndex = -1;
    return { added: records.length, removed: 0, total: records.length, resumed: false };
  }

  if (Number.isInteger(state.pendingIndex)) {
    return { added: 0, removed: 0, total: state.items.length, resumed: false, deferred: true };
  }

  const previousItems = state.items;
  const previousDoneIndex = Math.min(state.doneIndex, previousItems.length - 1);
  const currentByIdentity = new Map(records.map((r) => [queueIdentity(r), r]));
  const retainedItems = [];
  const retainedIdentities = new Set();
  let retainedCompletedCount = 0;

  previousItems.forEach((item, oldIndex) => {
    const identity = queueIdentity(item);
    const currentRecord = currentByIdentity.get(identity);
    if (!currentRecord) return;
    retainedItems.push(currentRecord);
    retainedIdentities.add(identity);
    if (oldIndex <= previousDoneIndex) retainedCompletedCount += 1;
  });

  const additions = records.filter((r) => !retainedIdentities.has(queueIdentity(r)));
  const removed = previousItems.length - retainedItems.length;
  state.items = [...retainedItems, ...additions];
  state.doneIndex = retainedCompletedCount - 1;

  const wasMissingFilePause = state.paused && state.pauseCode === 'missing_queue_file';
  const resumed = wasMissingFilePause && removed > 0;
  if (resumed) {
    state.paused = false;
    state.pauseReason = '';
    state.pauseCode = '';
    state.nextTime = Math.min(state.nextTime, Date.now());
  }

  return { added: additions.length, removed, total: state.items.length, resumed };
}
