import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForVideoInput, withPageLogs } from '../src/browser/tiktokStudio.js';

function fixture({waitFailures=1,view={path:'/tiktokstudio/upload',title:'upload',hasVideo:false,inputs:[]}}={}) {
  let waits=0, reloads=0, selections=0;
  const logs=[];
  const input={first(){return this;}, async waitFor(options){assert.equal(options.timeout,90000);if(waits++<waitFailures)throw Object.assign(Error('fixture timeout'),{name:'TimeoutError'});},async setInputFiles(){selections++;}};
  const page={locator:()=>input, async evaluate(){return view;}, async goto(){reloads++;}};
  return {page,input,log:{warn:x=>logs.push(x)},counts:()=>({waits,reloads,selections})};
}

test('空白上传页控件超时可重载一次，恢复期间不选择/重传视频', async()=>{
  const f=fixture();
  assert.equal(await waitForVideoInput(f.page,f.log),f.input);
  assert.deepEqual(f.counts(),{waits:2,reloads:1,selections:0});
});
test('重载仍没控件时给出明确页面诊断，不无限刷新',async()=>{
  const f=fixture({waitFailures:3});
  await assert.rejects(waitForVideoInput(f.page,f.log),/上传页选文件控件未就绪/);
  assert.deepEqual(f.counts(),{waits:2,reloads:1,selections:0});
});
for(const view of [{path:'/login',title:'login',hasVideo:false,inputs:[]},{path:'/tiktokstudio/upload',hasVideo:true,inputs:[]},{path:'/tiktokstudio/upload',hasVideo:false,inputs:['.mp4']}]) {
  test('登录页/已存在视频/未知控件不刷新也不选文件：'+JSON.stringify(view),async()=>{
    const f=fixture({view});
    await assert.rejects(waitForVideoInput(f.page,f.log),/尚未/);
    assert.deepEqual(f.counts(),{waits:1,reloads:0,selections:0});
  });
}
test('流程失败也提取页面日志，并保留原始错误',async()=>{
  const logs=[];const failure=Error('original failure');
  await assert.rejects(withPageLogs({async evaluate(){return ['content=service_error'];}},{info:x=>logs.push(x)},async()=>{throw failure;}),err=>err===failure);
  assert.deepEqual(logs,['content=service_error']);
});
test('页面日志读取失败不改变发布成功结果',async()=>{
  const result=await withPageLogs({async evaluate(){throw Error('context destroyed');}},{info(){}},async()=>({published:true}));
  assert.deepEqual(result,{published:true});
});
