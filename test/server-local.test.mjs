import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo=path.resolve(import.meta.dirname,'..');
function rawRequest(url, options) {
  return new Promise((resolve,reject)=>{
    const req=request(url,options,res=>{
      let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);
      res.on('end',()=>resolve({status:res.statusCode,json:async()=>JSON.parse(body)}));
    });
    req.on('error',reject);req.end();
  });
}
// 在仓库下复制源码以复用依赖，所有配置、状态和浏览器打开动作均隔离。
export async function serverFixture() {
  const root=mkdtempSync(path.join(repo,'.scheduler-test-'));
  cpSync(path.join(repo,'src'),path.join(root,'src'),{recursive:true});
  mkdirSync(path.join(root,'config'));
  writeFileSync(path.join(root,'config/settings.json'),JSON.stringify({minIntervalMs:1,maxIntervalMs:2,folderScanIntervalMs:10}));
  writeFileSync(path.join(root,'config/accounts.json'),'[]');
  const serverPath=path.join(root,'src/server.js');
  writeFileSync(serverPath,readFileSync(serverPath,'utf8').replace("import open from 'open';",'const open = async () => {};'));
  const probe=createServer(); probe.listen(0,'127.0.0.1'); await once(probe,'listening');
  const port=probe.address().port; await new Promise(r=>probe.close(r));
  const previous=process.env.PORT;process.env.PORT=String(port);
  const load=file=>import(pathToFileURL(path.join(root,'src',file)));
  let server;
  try { ({server}=await load('server.js')); if(!server.listening) await once(server,'listening'); }
  finally { if(previous===undefined) delete process.env.PORT; else process.env.PORT=previous; }
  const url=`http://127.0.0.1:${port}`;
  return {root,port,url,server,load, async close(){
    (await load('controller.js')).stop();
    server.closeAllConnections(); await new Promise(r=>server.close(r));
    await new Promise(r=>setTimeout(r,35));
    if(path.dirname(root)===repo && path.basename(root).startsWith('.scheduler-test-')) rmSync(root,{recursive:true,force:true});
  }};
}

test('控制台仅监听 IPv4 回环；外部 Host/Origin 被拒绝，本机 POST 正常',async()=>{
  const f=await serverFixture();
  try {
    assert.equal(f.server.address().address,'127.0.0.1');
    for(const origin of ['https://evil.example', 'null', `http://127.0.0.1:${f.port+1}`,`${f.url}.evil.example`]) {
      const res=await fetch(`${f.url}/api/orchestrator/start`,{method:'POST',headers:{Origin:origin}});
      assert.equal(res.status,403);
    }
    assert.equal((await (await fetch(`${f.url}/api/status`)).json()).running,false);
    for(const host of ['evil.example',`127.0.0.1.evil.example:${f.port}`,'localhost']) {
      assert.equal((await rawRequest(`${f.url}/api/status`,{headers:{Host:host}})).status,403);
    }
    for(const host of [`127.0.0.1:${f.port}`,`localhost:${f.port}`]) {
      const res=await rawRequest(`${f.url}/api/orchestrator/start`,{method:'POST',headers:{Host:host,Origin:`http://${host}`}});
      assert.equal(res.status,200);assert.equal((await res.json()).running,true);
      await fetch(`${f.url}/api/orchestrator/stop`,{method:'POST'});
    }
    assert.equal((await fetch(`${f.url}/api/status`,{headers:{Origin:'https://evil.example'}})).status,200);
  } finally {await f.close();}
});

test('端口占用时仍能通过本机状态探测复用已有控制台',async()=>{
  const f=await serverFixture();
  try {
    const result=await promisify(execFile)(process.execPath,[path.join(f.root,'src/server.js')],{
      env:{...process.env,PORT:String(f.port)},timeout:15000,windowsHide:true,
    });
    assert.match(result.stdout,/控制台已经在运行/);
    assert.equal(result.stderr,'');
  } finally {await f.close();}
});

const oldAccount={name:'原账号',browser:'adspower',profileId:'fixture-profile',videoFolder:'fixture-videos'};
async function saveAccountsRequest(f, accounts, renames=[]) {
  return fetch(`${f.url}/api/accounts`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({accounts,renames})});
}

test('改名拒绝 uncertain_publish 和非空 pendingIndex，旧配置/状态保持完整',async()=>{
  const f=await serverFixture();
  try {
    const {saveAccounts,loadAllAccounts}=await f.load('config.js');
    const {getState,setState}=await f.load('stateStore.js');
    saveAccounts([oldAccount]);
    for(const flags of [{pauseCode:'uncertain_publish',pendingIndex:null},{pauseCode:'',pendingIndex:0}]) {
      const state={...getState(oldAccount.name),...flags};setState(oldAccount.name,state);
      const res=await saveAccountsRequest(f,[{...oldAccount,name:'新账号'}],[{from:oldAccount.name,to:'新账号'}]);
      assert.equal(res.status,400);assert.match((await res.json()).error,/先处理完/);
      assert.deepEqual(loadAllAccounts(),[oldAccount]);assert.deepEqual(getState(oldAccount.name),state);
    }
    // 旧客户端遗漏改名元数据也不能绕过保护。
    const res=await fetch(`${f.url}/api/accounts`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify([{...oldAccount,name:'新账号'}])});
    assert.equal(res.status,400);
  } finally {await f.close();}
});

test('正常改名移动完整状态，保留今日额度、同产品计数、队列进度及品单引用',async()=>{
  const f=await serverFixture();
  try {
    const {saveAccounts,loadAllAccounts}=await f.load('config.js');
    const {getState,setState}=await f.load('stateStore.js');
    const {currentDayKey}=await f.load('dailyQuota.js');
    const {loadJoblist}=await f.load('joblist.js');
    saveAccounts([oldAccount]);
    const state={...getState(oldAccount.name),publishDayKey:currentDayKey('Asia/Jakarta'),publishedToday:2,
      publishedProductIdsToday:['123456','234567'],slotsUsedToday:['11:30','16:30'],doneIndex:1,
      items:[{filename:'123456.mp4',productId:'123456'},{filename:'234567.mp4',productId:'234567'},{filename:'345678.mp4',productId:'345678'}]};
    setState(oldAccount.name,state);
    writeFileSync(path.join(f.root,'state/joblist.json'),JSON.stringify({extra:'keep',items:[{productId:'345678',account:oldAccount.name,name:'待发商品',custom:'keep'}]}));
    const res=await saveAccountsRequest(f,[{...oldAccount,name:'新账号'}],[{from:oldAccount.name,to:'新账号'}]);
    assert.equal(res.status,200);
    assert.deepEqual(getState('新账号'),state);
    assert.equal(loadAllAccounts()[0].name,'新账号');
    assert.equal(loadJoblist()[0].account,'新账号');
    const raw=JSON.parse(readFileSync(path.join(f.root,'state/joblist.json'),'utf8'));
    assert.equal(raw.extra,'keep');assert.equal(raw.items[0].custom,'keep');
    assert.throws(()=>readFileSync(path.join(f.root,'state/原账号.json')), /ENOENT/);
    const status=await (await fetch(`${f.url}/api/status`)).json();
    assert.equal(status.accounts[0].publishedToday,2);assert.equal(status.accounts[0].doneIndex,1);
  } finally {await f.close();}
});

test('slug 冲突和已存在的新名状态文件拒绝保存，避免覆盖',async()=>{
  const f=await serverFixture();
  try {
    for(const names of [['印尼 1','印尼#1'],['Account','account']]) {
      const res=await saveAccountsRequest(f,names.map(name=>({...oldAccount,name})));
      assert.equal(res.status,400);assert.match((await res.json()).error,/同一个状态文件/);
    }
    const {saveAccounts}=await f.load('config.js');const {getState,setState}=await f.load('stateStore.js');
    saveAccounts([oldAccount]);const existing={...getState('新账号'),publishedToday:3};setState('新账号',existing);
    const res=await saveAccountsRequest(f,[{...oldAccount,name:'新账号'}],[{from:oldAccount.name,to:'新账号'}]);
    assert.equal(res.status,400);assert.deepEqual(getState('新账号'),existing);
  } finally {await f.close();}
});

test('浏览器处理尚未完成时拒绝改名',async()=>{
  const f=await serverFixture();let release,work;
  try {
    const {saveAccounts}=await f.load('config.js');const {tick}=await f.load('orchestrator.js');
    const videos=path.join(f.root,'videos');mkdirSync(videos);writeFileSync(path.join(videos,'123456.mp4'),'fixture');
    const account={...oldAccount,videoFolder:videos};saveAccounts([account]);
    let reached;const ready=new Promise(r=>reached=r);const blocked=new Promise(r=>release=r);
    work=tick({minIntervalMs:1,maxIntervalMs:2,videoExtensions:['.mp4'],postingSlots:{enabled:false},postingWindow:{enabled:false},notifications:{enabled:false}},[account],
      new Map([['adspower',{async startProfile(){reached();await blocked;throw new Error('fixture done');}}]]));
    await ready;
    const res=await saveAccountsRequest(f,[{...account,name:'新账号'}],[{from:oldAccount.name,to:'新账号'}]);
    assert.equal(res.status,400);assert.match((await res.json()).error,/先处理完/);
  } finally {release?.();await work;await f.close();}
});

test('改名后配置保存失败时恢复原状态文件和品单',async()=>{
  const f=await serverFixture();
  try {
    const {getState,setState,renameAccountStates}=await f.load('stateStore.js');
    const state=getState(oldAccount.name);state.publishedToday=2;setState(oldAccount.name,state);
    const joblist=JSON.stringify({items:[{productId:'123456',account:oldAccount.name}]});
    writeFileSync(path.join(f.root,'state/joblist.json'),joblist);
    assert.throws(()=>renameAccountStates([{from:oldAccount.name,to:'新账号'}],{isProcessing:()=>false,commit(){throw new Error('save failed');}}),/save failed/);
    assert.deepEqual(getState(oldAccount.name),state);
    assert.equal(readFileSync(path.join(f.root,'state/joblist.json'),'utf8'),joblist);
    assert.throws(()=>readFileSync(path.join(f.root,'state/新账号.json')),/ENOENT/);
  } finally {await f.close();}
});
