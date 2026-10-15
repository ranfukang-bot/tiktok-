import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(import.meta.dirname, '..');
const delay = ms => new Promise(r => setTimeout(r, ms));
function fixture() {
  const root = mkdtempSync(path.join(repo, '.scheduler-test-'));
  cpSync(path.join(repo, 'src'), path.join(root, 'src'), {recursive:true});
  mkdirSync(path.join(root, 'config'));
  const videos = path.join(root,'videos'); mkdirSync(videos);
  writeFileSync(path.join(videos,'123456.mp4'), 'fixture');
  writeFileSync(path.join(root,'src/browserAdapters/index.js'), `
    export const started=[]; const releases=[];
    export function release(){releases.splice(0).forEach(r=>r());}
    export function createAdapter(){return {async startProfile(a){started.push(a.name);
      await new Promise(r=>releases.push(r)); throw new Error('fixture network failure');}};}
  `);
  const settings = {concurrency:2,minIntervalMs:1,maxIntervalMs:2,videoExtensions:['.mp4'],timezone:'UTC',
    postingSlots:{enabled:false},postingWindow:{enabled:false},notifications:{enabled:false}};
  writeFileSync(path.join(root,'config/settings.json'),JSON.stringify(settings));
  const account = name => ({name,browser:'fake',videoFolder:videos});
  const load = file => import(pathToFileURL(path.join(root,'src',file)));
  return {root,settings,account,load};
}
function cleanup(root) {
  if(path.dirname(root)===repo && path.basename(root).startsWith('.scheduler-test-')) rmSync(root,{recursive:true,force:true});
}

test('工作池：卡住的账号不阻塞下一圈到点账号，空位复用且不超并发上限', async () => {
  const f=fixture(); const {tickAll,isAccountProcessing}=await f.load('orchestrator.js');
  const adapter=await f.load('browserAdapters/index.js');
  const {getState,setState}=await f.load('stateStore.js');
  const accounts=['blocked','later','third'].map(f.account);
  for(const a of accounts.slice(1)){const s=getState(a.name);s.nextTime=Date.now()+60000;setState(a.name,s);}
  try {
    await tickAll(f.settings,accounts);
    assert.deepEqual(adapter.started,['blocked']);
    for(const a of accounts.slice(1)){const s=getState(a.name);s.nextTime=0;setState(a.name,s);}
    await tickAll(f.settings,accounts);
    assert.deepEqual(adapter.started,['blocked','later']);
    await tickAll(f.settings,accounts);
    assert.equal(adapter.started.length,2);
    assert.equal(isAccountProcessing('blocked'),true);
    await tickAll(f.settings,accounts,{shouldContinue:()=>false});
    assert.equal(adapter.started.length,2);
  } finally {adapter.release(); await delay(30); cleanup(f.root);}
});

test('错过节点按日去重，暂停/无库存不计数，状态接口显示并跨日清零', async () => {
  const f=fixture(); const originalNow=Date.now;
  Date.now=()=>Date.parse('2026-10-15T12:00:00Z');
  const {tickAll}=await f.load('orchestrator.js');
  const {getState,setState}=await f.load('stateStore.js');
  const {recentLogs}=await f.load('logBus.js');
  const {getStatus}=await f.load('controller.js');
  const settings={...f.settings,postingSlots:{slots:[{start:'10:00',end:'11:00'}]}};
  const accounts=['missed','paused','empty','used'].map(f.account);
  const empty=path.join(f.root,'empty');mkdirSync(empty); accounts[2].videoFolder=empty;
  let s=getState('paused');s.paused=true;setState('paused',s);
  s=getState('used');s.publishDayKey='2026-10-15';s.slotsUsedToday=['10:00'];setState('used',s);
  writeFileSync(path.join(f.root,'config/settings.json'),JSON.stringify(settings));
  writeFileSync(path.join(f.root,'config/accounts.json'),JSON.stringify(accounts));
  try {
    await tickAll(settings,accounts);await tickAll(settings,accounts);
    assert.equal(recentLogs().filter(x=>x.level==='warn' && x.message.includes('错过节点')).length,1);
    assert.deepEqual(getStatus().accounts.map(a=>a.missedSlotsToday),[1,0,0,0]);
    Date.now=()=>Date.parse('2026-10-16T00:00:00Z');
    assert.equal(getStatus().accounts[0].missedSlotsToday,0);
    await tickAll(settings,accounts);
    assert.deepEqual(getState('missed').missedSlotsToday,[]);
  } finally {Date.now=originalNow;cleanup(f.root);}
});

test('工作池按当前节点截止时间排序，未到点账号仍同步库存', async () => {
  const f=fixture(); const originalNow=Date.now;
  Date.now=()=>Date.parse('2026-10-15T10:30:00Z');
  const {tickAll}=await f.load('orchestrator.js'); const adapter=await f.load('browserAdapters/index.js');
  const {getState}=await f.load('stateStore.js');
  const accounts=[{...f.account('later-deadline'),timezone:'UTC'},
    {...f.account('earlier-deadline'),timezone:'Asia/Kolkata'},
    {...f.account('not-due'),timezone:'America/New_York'}];
  // UTC 10:30 对应印度 16:00，两个节点均仅一分钟，目标时间无抖动。
  const settings={...f.settings,concurrency:1,postingSlots:{slots:[
    {start:'10:30',end:'10:32'},{start:'16:00',end:'16:01'}]}};
  const {evaluateSlots}=await f.load('dailyQuota.js');
  if (!evaluateSlots({nowMs:Date.now(),timezone:'UTC',dayKey:'2026-10-15',slots:settings.postingSlots.slots,accountName:accounts[0].name}).due) accounts[0].name+='a';
  assert.ok(evaluateSlots({nowMs:Date.now(),timezone:'UTC',dayKey:'2026-10-15',slots:settings.postingSlots.slots,accountName:accounts[0].name}).due);
  try {
    await tickAll(settings,accounts);
    assert.deepEqual(adapter.started,['earlier-deadline']);
    assert.equal(getState('not-due').items.length,1);
  } finally {adapter.release(); await delay(30);Date.now=originalNow;cleanup(f.root);}
});
