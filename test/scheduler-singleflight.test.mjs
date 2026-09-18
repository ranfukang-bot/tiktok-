import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(import.meta.dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture() {
  const root = mkdtempSync(path.join(repo, '.scheduler-test-'));
  cpSync(path.join(repo, 'src'), path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'config'));
  writeFileSync(path.join(root, 'config', 'settings.json'), JSON.stringify({minIntervalMs:1,maxIntervalMs:2,folderScanIntervalMs:10}));
  writeFileSync(path.join(root, 'config', 'accounts.json'), '[]');
  return root;
}
function cleanup(root) {
  if (path.dirname(root) === repo && path.basename(root).startsWith('.scheduler-test-')) rmSync(root, {recursive:true,force:true});
}

test('真实 controller：处理未完成时快速停止/启动不能产生第二条调度循环', async () => {
  const root = fixture();
  // 仅替换隔离副本中的外部调度工作，保留实际 controller 的 start/stop/loop。
  writeFileSync(path.join(root, 'src', 'orchestrator.js'), `
    export let calls=0;
    const releases=[];
    export async function tickAll(){calls++;await new Promise(r=>releases.push(r));}
    export function release(){for(const r of releases.splice(0))r();}
    export function isAccountProcessing(){return false;}
    export async function syncAccountFolder(){}
  `);
  const controller = await import(pathToFileURL(path.join(root,'src','controller.js')));
  const work = await import(pathToFileURL(path.join(root,'src','orchestrator.js')));
  try {
    controller.start();
    assert.equal(work.calls, 1);
    for(let i=0;i<4;i++){controller.stop();controller.start();}
    assert.equal(work.calls, 1, '旧循环尚未结束，不能启动新的循环');
    work.release(); await delay(25);
    assert.equal(work.calls,2,'旧工作完成后仍能继续下一轮，而不是彻底停死');
  } finally {
    controller.stop(); work.release(); await delay(40); cleanup(root);
  }
});

test('真实 controller：循环睡眠时停止再启动同样不能多开循环', async () => {
  const root = fixture();
  writeFileSync(path.join(root,'src','orchestrator.js'), `
    export let calls=0;
    export async function tickAll(){calls++;}
    export function isAccountProcessing(){return false;}
    export async function syncAccountFolder(){}
  `);
  const controller=await import(pathToFileURL(path.join(root,'src','controller.js')));
  const work=await import(pathToFileURL(path.join(root,'src','orchestrator.js')));
  try {
    controller.start(); await Promise.resolve(); await Promise.resolve();
    controller.stop();controller.start();
    assert.equal(work.calls,1,'睡眠中的旧循环必须复用');
  } finally { controller.stop(); await delay(40); cleanup(root); }
});

test('真实 tickAll：停止后让当前账号收尾，但不启动后续账号', async () => {
  const root=fixture();
  writeFileSync(path.join(root,'src','browserAdapters','index.js'), `
    export const names=[];
    export let proceed=true;
    export function createAdapter(){return {async startProfile(a){names.push(a.name);proceed=false;throw new Error('fixture end');}};}
  `);
  const {tickAll}=await import(pathToFileURL(path.join(root,'src','orchestrator.js')));
  const adapters=await import(pathToFileURL(path.join(root,'src','browserAdapters','index.js')));
  const videos=path.join(root,'videos');mkdirSync(videos);writeFileSync(path.join(videos,'123.mp4'),'fixture');
  const settings={concurrency:1,minIntervalMs:1,maxIntervalMs:2,videoExtensions:['.mp4'],postingSlots:{enabled:false},postingWindow:{enabled:false},notifications:{enabled:false}};
  try {
    await tickAll(settings,[{name:'第一个夹具',browser:'fake',videoFolder:videos},{name:'第二个夹具',browser:'fake',videoFolder:videos}],{shouldContinue:()=>adapters.proceed});
    assert.deepEqual(adapters.names,['第一个夹具']);
  } finally { cleanup(root); }
});

test('真实 tick：同账号并发 tick 只能启动一次，锁覆盖等待浏览器和错误处理', async () => {
  const root = fixture();
  const {tick,isAccountProcessing} = await import(pathToFileURL(path.join(root,'src','orchestrator.js')));
  const {getState,setState} = await import(pathToFileURL(path.join(root,'src','stateStore.js')));
  const videoDir = path.join(root,'videos'); mkdirSync(videoDir);
  writeFileSync(path.join(videoDir,'123.mp4'),'fixture');
  const account = {name:'并发夹具',browser:'fake',videoFolder:videoDir};
  const settings = {minIntervalMs:1,maxIntervalMs:2,videoExtensions:['.mp4'],postingSlots:{enabled:false},postingWindow:{enabled:false},retryBackoffMs:[1000],notifications:{enabled:false}};
  let calls=0, release, reached;
  const ready = new Promise(r=>reached=r);
  const blocked = new Promise(r=>release=r);
  const adapter = {async startProfile(){calls++;reached();await blocked;throw new Error('fixture network failure');}};
  let one, two;
  try {
    one=tick(settings,[account],new Map([['fake',adapter]])); await ready;
    assert.equal(isAccountProcessing(account.name),true);
    two=tick(settings,[account],new Map([['fake',adapter]])); await delay(20);
    assert.equal(calls,1,'已有上传流程时，第二个 tick 不得再开浏览器');
    release(); await Promise.all([one,two]);
    assert.equal(getState(account.name).consecutiveFailures,1,'只计一次失败');
    assert.equal(isAccountProcessing(account.name),false,'失败后释放锁');
    const state=getState(account.name);state.retryAt=null;setState(account.name,state);
    await tick(settings,[account],new Map([['fake',adapter]]));
    assert.equal(calls,2,'锁释放后允许正常的下一次重试');
  } finally { release(); await Promise.all([one,two]); cleanup(root); }
});
