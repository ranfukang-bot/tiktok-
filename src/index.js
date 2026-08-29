import { runOrchestrator } from './orchestrator.js';
import { getState } from './stateStore.js';
import { loadAccounts, ensureConfigFiles } from './config.js';
import { resolveUncertain as resolveUncertainState } from './controller.js';

ensureConfigFiles();

async function resolveUncertain(accountName, decision) {
  const accounts = loadAccounts();
  const account = accounts.find((a) => a.name === accountName);
  if (!account) {
    console.error(`没找到账号 "${accountName}"，accounts.json 里的名字必须完全一致。`);
    process.exitCode = 1;
    return;
  }
  const state = getState(accountName);
  if (state.pauseCode !== 'uncertain_publish') {
    console.error(`账号 "${accountName}" 当前不是 uncertain_publish 暂停状态(现在是: ${state.pauseCode || '未暂停'})，无需处理。`);
    process.exitCode = 1;
    return;
  }

  await resolveUncertainState(accountName, decision);
  console.log(
    decision === 'published'
      ? '✅ 已按"上次实际发布成功"处理，将从下一条继续（如果开着自动删除，源文件也已经删掉）'
      : '↻ 已按"上次没有发布"处理，将自动重试当前视频'
  );
}

const [, , command, ...rest] = process.argv;

if (command === 'run') {
  runOrchestrator().catch((err) => {
    console.error('编排器异常退出:', err);
    process.exitCode = 1;
  });
} else if (command === 'resolve') {
  const [accountName, flag] = rest;
  if (!accountName || (flag !== '--published' && flag !== '--retry')) {
    console.error('用法: node src/index.js resolve "<账号名>" --published|--retry');
    process.exitCode = 1;
  } else {
    resolveUncertain(accountName, flag === '--published' ? 'published' : 'retry');
  }
} else {
  console.log('用法:');
  console.log('  node src/index.js run                          启动全自动编排器');
  console.log('  node src/index.js resolve "<账号名>" --published  人工确认上次其实发布成功了');
  console.log('  node src/index.js resolve "<账号名>" --retry      人工确认上次没有发布，重试当前这条');
}
