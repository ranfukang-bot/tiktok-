import test from 'node:test';
import assert from 'node:assert/strict';
import { findMissingRequiredText, resolveText, REQUIRED_TEXT_KEYS, SAFETY_CRITICAL_TEXT_KEYS } from '../src/config.js';
import { classifyError } from '../src/errorPolicy.js';

test('所有语言无需填写文案；安全边界由DOM判断', () => {
  for (const textPreset of [undefined, 'id', 'en', 'custom', 'fil-PH', 'th-TH', 'ms-MY']) {
    assert.deepEqual(findMissingRequiredText({}, { textPreset }), []);
  }
  assert.deepEqual(REQUIRED_TEXT_KEYS, []);
  assert.deepEqual(SAFETY_CRITICAL_TEXT_KEYS, []);
});

test('兼容旧配置读取，不把另一种语言的诊断词串入账号', () => {
  const settings = { textPreset: 'id', text: { appCrashMarkers: ['旧诊断A', '旧诊断B'] } };
  assert.deepEqual(resolveText(settings, {}).appCrashMarkers, ['旧诊断A', '旧诊断B']);
  assert.equal(resolveText(settings, { textPreset: 'custom' }).appCrashMarkers, undefined);
  assert.deepEqual(resolveText(settings, { textPreset: 'custom', textOverrides: { appCrashMarkers: ['X', 'Y'] } }).appCrashMarkers, ['X', 'Y']);
});

test('安全错误立即暂停，不反复重传有问题的视频', () => {
  for (const message of ['发布安全检查未通过：content=blocked', '发布安全检查未通过：等待双绿超时', '商品橱窗为空', '未找到精确商品ID 123']) {
    assert.equal(classifyError(new Error(message)).kind, 'never_retry');
  }
  assert.equal(classifyError(new Error('页面结构不受支持：未知弹窗')).kind, 'config');
  assert.equal(classifyError(new Error('等待元素超时'), { publishAttempted: true }).code, 'uncertain_publish');
});
