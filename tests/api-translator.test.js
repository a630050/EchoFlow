import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiTranslator, checkApiConfig, fillPrompt, DEFAULT_PROMPT } from '../core.js';
import { readTranslationSettings, writeTranslationSettings, defaultTranslationSettings } from '../storage.js';
import { normalizeAppearance, LINE_HEIGHT } from '../appearance.js';

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function capture(response) {
  const calls = [];
  return { calls, fetch: async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return response; } };
}
const openai = { method: 'api', format: 'openai', url: 'https://llm.example/v1/chat/completions', model: 'my-model', token: 'sk-test', prompt: '' };

test('OpenAI-compatible request: bearer token, filled system prompt, sentence as the user message', async () => {
  const server = capture(reply(200, { choices: [{ message: { content: '  你好，世界。 ' } }] }));
  const api = new ApiTranslator({ getConfig: () => openai, fetch: server.fetch });
  assert.equal(await api.translate('Hello, world.', 'en', 'zh-TW'), '你好，世界。');
  const [{ url, init, body }] = server.calls;
  assert.equal(url, openai.url);
  assert.equal(init.headers.Authorization, 'Bearer sk-test');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.equal(body.model, 'my-model');
  assert.deepEqual(body.messages.map(m => m.role), ['system', 'user']);
  assert.equal(body.messages[0].content, fillPrompt(DEFAULT_PROMPT, 'en', 'zh-TW'));
  assert.match(body.messages[0].content, /英文.*繁體中文/);
  assert.equal(body.messages[1].content, 'Hello, world.');
});

test('Anthropic request: x-api-key, current API version, browser access header, text blocks only', async () => {
  const config = { ...openai, format: 'anthropic', url: 'https://api.anthropic.com/v1/messages', model: 'claude-opus-5-5', prompt: '翻成{target}，來源是{source}' };
  const server = capture(reply(200, { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'こんにちは' }] }));
  const api = new ApiTranslator({ getConfig: () => config, fetch: server.fetch });
  assert.equal(await api.translate('你好', 'zh-TW', 'ja'), 'こんにちは');
  const [{ init, body }] = server.calls;
  assert.equal(init.headers['x-api-key'], 'sk-test');
  assert.equal(init.headers['anthropic-version'], '2026-10-21');
  assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(init.headers.Authorization, undefined);
  assert.equal(body.system, '翻成日文，來源是繁體中文');
  assert.deepEqual(body.messages, [{ role: 'user', content: '你好' }]);
  assert.equal(body.max_tokens, 16000);
  assert.equal(body.temperature, undefined);
  assert.equal(body.fallbacks, 'default');
  assert.equal(init.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  // Models without server-side fallback get a plain request.
  const plain = capture(reply(200, { content: [{ type: 'text', text: 'ok' }] }));
  await new ApiTranslator({ getConfig: () => ({ ...config, model: 'claude-haiku-5-5' }), fetch: plain.fetch }).translate('a', 'en', 'ja');
  assert.equal(plain.calls[0].body.fallbacks, undefined);
  assert.equal(plain.calls[0].init.headers['anthropic-beta'], undefined);
});

test('API failures become readable paragraph errors that never include the token', async () => {
  const cases = [
    [openai, reply(401, { error: { message: 'invalid x-api-key' } }), /HTTP 401（請檢查 Token）：invalid x-api-key/],
    [openai, reply(429, {}), /HTTP 429（請求過於頻繁或額度不足）/],
    [openai, reply(200, { choices: [{ message: { content: '' } }] }), /沒有回傳譯文/],
    [{ ...openai, format: 'anthropic' }, reply(200, { stop_reason: 'refusal', content: [] }), /拒絕翻譯/],
  ];
  for (const [config, response, pattern] of cases) {
    const api = new ApiTranslator({ getConfig: () => config, fetch: async () => response });
    await assert.rejects(api.translate('x', 'en', 'ja'), error => pattern.test(error.message) && !error.message.includes('sk-test'));
  }
  const offline = new ApiTranslator({ getConfig: () => openai, fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(offline.translate('x', 'en', 'ja'), /CORS/);
});

test('timeout and cancellation abort the request; same-language text is not sent', async () => {
  let seen;
  const hanging = (url, init) => new Promise((_, reject) => {
    seen = init.signal;
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  await assert.rejects(new ApiTranslator({ getConfig: () => openai, fetch: hanging, timeoutMs: 5 }).translate('x', 'en', 'ja'), /逾時/);
  assert.equal(seen.aborted, true);
  const controller = new AbortController();
  const pending = new ApiTranslator({ getConfig: () => openai, fetch: hanging }).translate('x', 'en', 'ja', controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  let called = false;
  assert.equal(await new ApiTranslator({ getConfig: () => openai, fetch: async () => { called = true; } }).translate('same', 'ja', 'ja'), 'same');
  assert.equal(called, false);
});

test('incomplete settings are reported before any request is made', async () => {
  assert.equal(checkApiConfig(openai), '');
  assert.match(checkApiConfig({ ...openai, url: 'not a url' }), /有效的 API 網址/);
  assert.match(checkApiConfig({ ...openai, url: 'http://llm.example/v1' }), /https/);
  assert.equal(checkApiConfig({ ...openai, url: 'http://localhost:11434/v1/chat/completions', token: '' }), '', 'local model servers may use http and no token');
  assert.match(checkApiConfig({ ...openai, model: ' ' }), /模型名稱/);
  let called = false;
  const api = new ApiTranslator({ getConfig: () => ({ ...openai, url: '' }), fetch: async () => { called = true; } });
  await assert.rejects(api.translate('x', 'en', 'ja'), /設定不完整/);
  assert.equal(called, false);
});

test('translation settings are validated, size-limited and survive blocked storage', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.deepEqual(readTranslationSettings(storage), defaultTranslationSettings());
  assert.equal(writeTranslationSettings({ ...openai, prompt: 'p'.repeat(5000), format: 'weird' }, storage), true);
  const read = readTranslationSettings(storage);
  assert.equal(read.method, 'api');
  assert.equal(read.format, 'openai');
  assert.equal(read.prompt.length, 4000);
  assert.equal(read.token, 'sk-test');
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(readTranslationSettings(blocked), defaultTranslationSettings());
  assert.equal(writeTranslationSettings(openai, blocked), false);
});

test('line spacing runs from 1.0, defaults to 1.2 and keeps only values the person chose', () => {
  assert.deepEqual([LINE_HEIGHT.min, LINE_HEIGHT.default], [1, 1.2]);
  assert.deepEqual([normalizeAppearance(undefined).lineHeight, normalizeAppearance(undefined).lineHeightCustom], [1.2, false]);
  const chosen = value => normalizeAppearance({ lineHeight: value, lineHeightCustom: true }).lineHeight;
  assert.equal(chosen(1.33), 1.35, 'snapped to the slider step');
  assert.equal(chosen(1), 1);
  assert.equal(chosen(0.8), 1.2, 'below the range');
  assert.equal(chosen(9), 1.2, 'above the range');
  assert.equal(chosen('tight'), 1.2);
  // A value saved without the custom flag (the earlier 1.6 default) now follows the new default.
  assert.equal(normalizeAppearance({ lineHeight: 1.6 }).lineHeight, 1.2);
  assert.equal(normalizeAppearance({ lineHeight: 1.6, lineHeightCustom: true }).lineHeightCustom, true);
});
