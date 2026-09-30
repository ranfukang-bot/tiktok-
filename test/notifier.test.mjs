import test from 'node:test';
import assert from 'node:assert/strict';
import { notify, sendTestNotification, listProviders } from '../src/notifier.js';

const settings = { notifications: { enabled: true, provider: 'pushplus', pushplus: { token: ' test-only-token ' }, bark: { serverUrl: 'https://example.invalid/bark-private' } } };
const payload = { title: '需要处理', text: '账号：菲律宾1号\n发布结果不确定', account: '菲律宾1号' };

test('PushPlus sends one HTTPS text request to this computer’s configured recipient only', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ code: 200, data: 'request-id' }));
  });
  const before = structuredClone(settings);
  assert.ok(listProviders().includes('pushplus'));
  assert.deepEqual(await notify(settings, payload), { sent: true, queued: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://www.pushplus.plus/send');
  assert.equal(calls[0].options.method, 'POST');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(calls[0].options.body), { token: 'test-only-token', title: payload.title, content: payload.text, template: 'txt', channel: 'wechat' });
  assert.deepEqual(settings, before, 'sending does not alter the local Bark config');
});

test('Bark remains unchanged and never also sends to PushPlus', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push([url, JSON.parse(options.body)]); return new Response('{}'); });
  assert.deepEqual(await notify({ notifications: { ...settings.notifications, provider: 'bark' } }, payload), { sent: true });
  assert.deepEqual(calls, [['https://example.invalid/bark-private', { title: payload.title, body: payload.text, group: 'TikTok发布' }]]);
});

for (const [name, response] of [
  ['HTTP failure', () => new Response('bad gateway', { status: 502 })],
  ['quota / real-name rejection despite HTTP 200', () => new Response(JSON.stringify({ code: 905, msg: '需要实名 test-only-token' }))],
  ['HTML instead of JSON', () => new Response('<html>unavailable</html>')],
  ['missing status code', () => new Response('{}')],
  ['empty JSON', () => new Response('null')],
  ['network timeout', () => { throw new DOMException('Timed out', 'TimeoutError'); }],
]) {
  test(`notification failure never interrupts publishing: ${name}`, async t => {
    t.mock.method(globalThis, 'fetch', response);
    const warnings = [];
    const result = await notify(settings, payload, { warn: text => warnings.push(text) });
    assert.equal(result.sent, false);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], /test-only-token/);
    await assert.rejects(sendTestNotification(settings), 'test button reports failures instead of pretending success');
  });
}

test('disabled and missing-token configurations send nothing', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('must not send'); });
  assert.equal((await notify({ notifications: { ...settings.notifications, enabled: false } }, payload)).sent, false);
  const noToken = { notifications: { enabled: true, provider: 'pushplus' } };
  assert.equal((await notify(noToken, payload)).sent, false);
  await assert.rejects(sendTestNotification(noToken), /Token/);
  assert.equal(calls, 0);
});

test('test button reports accepted, not confirmed delivered', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{"code":200,"data":"request-id"}'));
  assert.deepEqual(await sendTestNotification(settings), { queued: true });
});
