import test from 'node:test';
import assert from 'node:assert/strict';
import { createBitBrowserAdapter } from '../src/browserAdapters/bitbrowser.js';

const tls = 'Client network socket disconnected before secure TLS connection was established';
const response = data => ({ ok: true, async json() { return data; } });
function fixture(handler) {
  const calls = [], delays = [];
  const adapter = createBitBrowserAdapter({ baseUrl: 'http://127.0.0.1:54345' }, {
    async request(url, options) {
      const call = { url, body: options.body ? JSON.parse(options.body) : null };
      calls.push(call);
      assert.ok(options.signal, 'API 调用必须有超时上限');
      return response(await handler(call));
    },
    async delay(ms) { delays.push(ms); },
  });
  return { adapter, calls, delays };
}

test('只复用本账号已打开且调试端口可用的环境，不再次调用打开', async () => {
  const f = fixture(({url}) => url.endsWith('/browser/ports')
    ? {success:true,data:{mine:'1234',other:'5678'}} : {webSocketDebuggerUrl:'ws://127.0.0.1:1234/devtools/browser/test'});
  assert.deepEqual(await f.adapter.startProfile({browserId:'mine'}), {wsEndpoint:'http://127.0.0.1:1234',reused:true});
  assert.equal(f.calls.length, 2);
  assert.ok(!f.calls.some(x => x.url.endsWith('/browser/open')));
});

test('不复用另一个账号的端口；明确 TLS 业务错误短重试后可恢复', async () => {
  let opens = 0;
  const f = fixture(({url,body}) => {
    if (url.endsWith('/browser/ports')) return {success:true,data:{other:'5678'}};
    assert.equal(body.id,'mine');
    return ++opens === 1 ? {success:false,msg:tls} : {success:true,data:{ws:'ws://local/test'}};
  });
  assert.equal((await f.adapter.startProfile({browserId:'mine'})).wsEndpoint, 'ws://local/test');
  assert.equal(opens,2);
  assert.deepEqual(f.delays,[2000]);
});

test('TLS 错误连续发生只尝试三次，最终保留错误并说明尚未上传', async () => {
  const f=fixture(({url}) => url.endsWith('/browser/ports') ? {success:true,data:{}} : {success:false,msg:tls});
  await assert.rejects(f.adapter.startProfile({browserId:'mine'}), err => err.code === 'BITBROWSER_START_TLS' && /尚未上传/.test(err.message));
  assert.equal(f.calls.filter(x=>x.url.endsWith('/browser/open')).length,3);
  assert.deepEqual(f.delays,[2000,5000]);
});

test('启动报TLS错误但环境已打开：核验本账号端口后接回，不重复打开', async () => {
  let opens=0;
  const f=fixture(({url}) => {
    if(url.endsWith('/browser/ports'))return {success:true,data:opens?{mine:'1234'}:{}};
    if(url.endsWith('/json/version'))return {webSocketDebuggerUrl:'ws://127.0.0.1:1234/test'};
    opens++;return {success:false,msg:tls};
  });
  assert.equal((await f.adapter.startProfile({browserId:'mine'})).reused,true);
  assert.equal(opens,1);
});

test('旧客户端不支持ports查询仍可正常启动，非TLS错误不做短重试', async () => {
  const f=fixture(({url}) => url.endsWith('/browser/ports') ? {success:false,msg:'unsupported'} : {success:false,msg:'profile permission denied'});
  await assert.rejects(f.adapter.startProfile({browserId:'mine'}),/permission denied/);
  assert.equal(f.calls.filter(x=>x.url.endsWith('/browser/open')).length,1);
  assert.deepEqual(f.delays,[]);
});

test('端口映射过期或无效不会被当作启动成功', async () => {
  for (const port of ['bad', 70000, 1234]) {
    const f=fixture(({url}) => {
      if(url.endsWith('/browser/ports')) return {success:true,data:{mine:port}};
      if(url.endsWith('/json/version')) return {};
      return {success:true,data:{ws:'ws://local/new'}};
    });
    assert.equal((await f.adapter.startProfile({browserId:'mine'})).wsEndpoint,'ws://local/new');
  }
});
