import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAdsPowerAdapter } from '../src/browserAdapters/adspower.js';
import { createHubstudioAdapter } from '../src/browserAdapters/hubstudio.js';

const repo=path.resolve(import.meta.dirname,'..');
function fixture() {
  const root=mkdtempSync(path.join(repo,'.scheduler-test-'));
  cpSync(path.join(repo,'src'),path.join(root,'src'),{recursive:true});
  mkdirSync(path.join(root,'videos'));writeFileSync(path.join(root,'videos/123456.mp4'),'fixture');
  mkdirSync(path.join(root,'config'));writeFileSync(path.join(root,'config/settings.json'),JSON.stringify({minIntervalMs:1,maxIntervalMs:2}));
  const settings={minIntervalMs:1,maxIntervalMs:2,videoExtensions:['.mp4'],postingSlots:{enabled:false},postingWindow:{enabled:false},
    notifications:{enabled:true,provider:'webhook',webhook:{url:'https://fixture.invalid/notify'}}};
  const account={name:'卡住号',browser:'fake',videoFolder:path.join(root,'videos')};
  return {root,settings,account,load:file=>import(pathToFileURL(path.join(root,'src',file))),close(){
    if(path.dirname(root)===repo && path.basename(root).startsWith('.scheduler-test-')) rmSync(root,{recursive:true,force:true});
  }};
}
function captureNotifications(t) {
  const sent=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(String(url),'https://fixture.invalid/notify');sent.push(JSON.parse(options.body));
    return new Response('{}',{status:200});
  });
  return sent;
}

for(const threshold of [undefined,120000]) {
  test(`永不返回的 adapter：${threshold ?? '默认90分钟'} 后只提醒一次，不重试、不关窗口`,async t=>{
    const f=fixture();
    try {
      const {tick,isAccountProcessing}=await f.load('orchestrator.js');
      const {getState}=await f.load('stateStore.js');
      const {loadSettings}=await f.load('config.js');
      assert.equal(loadSettings().cycleAlertMs,5400000);
      const sent=captureNotifications(t);
      t.mock.timers.enable({apis:['setTimeout']});
      const settings={...f.settings,...(threshold ? {cycleAlertMs:threshold} : {})};
      let calls=0,closes=0,reached;const ready=new Promise(r=>reached=r);
      const adapter={async startProfile(){calls++;reached();await new Promise(()=>{});},async stopProfile(){closes++;}};
      const adapters=new Map([['fake',adapter]]);
      void tick(settings,[f.account],adapters);await ready;
      const before=getState(f.account.name);const limit=threshold ?? 5400000;
      t.mock.timers.tick(limit-1);assert.equal(sent.length,0);
      t.mock.timers.tick(1);await Promise.resolve();
      assert.equal(sent.length,1);
      assert.match(sent[0].text,new RegExp(`账号卡住号这一轮已运行超过${limit/60000}分钟，可能卡住，请打开窗口看一眼`));
      assert.match(sent[0].text,/本轮开始时间/);
      t.mock.timers.tick(limit*2);await tick(settings,[f.account],adapters);
      assert.equal(sent.length,1);assert.equal(calls,1);assert.equal(closes,0);
      assert.equal(isAccountProcessing(f.account.name),true);
      assert.deepEqual(getState(f.account.name),before,'提醒不能改暂停、重试、pending 或队列进度');
    } finally {t.mock.timers.reset();f.close();}
  });
}

test('调度扫描本身卡住超过30分钟独立提醒一次',async t=>{
  const f=fixture();
  writeFileSync(path.join(f.root,'src/inbox.js'),'export async function routeInbox(){return new Promise(()=>{});}');
  try {
    const {tickAll}=await f.load('orchestrator.js');const sent=captureNotifications(t);
    t.mock.timers.enable({apis:['setTimeout']});
    void tickAll({...f.settings,inboxFolder:'fixture'},[]);
    t.mock.timers.tick(1800000-1);assert.equal(sent.length,0);
    t.mock.timers.tick(1);await Promise.resolve();
    assert.equal(sent.length,1);assert.match(sent[0].text,/调度循环超过30分钟/);
    t.mock.timers.tick(1800000*3);assert.equal(sent.length,1);
  } finally {t.mock.timers.reset();f.close();}
});

test('正常结束的账号和调度轮次会清除提醒计时器',async t=>{
  const f=fixture();
  try {
    const {tick,tickAll}=await f.load('orchestrator.js');
    const {getState,setState}=await f.load('stateStore.js');
    const state=getState(f.account.name);state.paused=true;setState(f.account.name,state);
    const sent=captureNotifications(t);t.mock.timers.enable({apis:['setTimeout']});
    await tick(f.settings,[f.account],new Map());await tickAll(f.settings,[]);
    t.mock.timers.tick(5400000*2);assert.equal(sent.length,0);
  } finally {t.mock.timers.reset();f.close();}
});

for(const [name,createAdapter] of [['AdsPower',createAdsPowerAdapter],['Hubstudio',createHubstudioAdapter]]) {
  test(`${name} 开关环境请求均使用120秒超时，连接失败文案指向客户端`,async t=>{
    const deadlines=[];const calls=[];
    t.mock.method(AbortSignal,'timeout',ms=>{deadlines.push(ms);return AbortSignal.abort(new DOMException('fixture timeout','TimeoutError'));});
    t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push(options.method);options.signal.throwIfAborted();});
    const adapter=createAdapter({});const account={name:'fixture',profileId:'profile',containerCode:'container'};
    await assert.rejects(adapter.startProfile(account),new RegExp(`连不上 ${name} 指纹浏览器客户端.*120秒`));
    await assert.rejects(adapter.stopProfile(account),new RegExp(`连不上 ${name} 指纹浏览器客户端`));
    assert.deepEqual(deadlines,[120000,120000]);assert.deepEqual(calls,name==='AdsPower'?['GET','GET']:['POST','POST']);
  });
}
