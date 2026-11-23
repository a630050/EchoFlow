import test from 'node:test';
import assert from 'node:assert/strict';
import { ResultTracker, SpeechController, Transcript, TranslationService, exportText, filename, isWindowsEdge, deadline } from '../core.js';
import { readPreferences, writePreferences, TranscriptStore, readDraft, writeDraft, clearDraft, readRecoverable, writeRecoverable, draftLanded } from '../storage.js';
import { normalizeAppearance } from '../appearance.js';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function result(text, isFinal = false) { return Object.assign([{ transcript: text }], { isFinal }); }
const event = (...results) => ({ results });
class Clock {
  constructor() { this.tasks = new Map(); this.id = 0; this.time = 0; }
  setTimeout = (fn, ms) => { this.tasks.set(++this.id, { fn, ms }); return this.id; };
  clearTimeout = id => this.tasks.delete(id);
  next() { const [id, task] = [...this.tasks].sort((a, b) => a[1].ms - b[1].ms)[0] || []; if (task) { this.tasks.delete(id); task.fn(); } }
}
function speechFixture() {
  const instances = [], finals = [], interims = [], states = [], errors = [], timers = new Clock();
  class Recognition {
    constructor() { instances.push(this); }
    start() { this.onstart?.(); }
    stop() { this.stopped = true; }
    abort() { this.aborted = true; this.onend?.(); }
    result(...results) { this.onresult(event(...results)); }
    end() { this.onend(); }
  }
  const speech = new SpeechController({ Recognition, timers, now: () => timers.time, onFinal: (text, source) => finals.push({ text, source }), onInterim: text => interims.push(text), onState: state => states.push(state), onError: text => errors.push(text) });
  return { speech, instances, finals, interims, states, errors, timers };
}

test('result indices preserve repeated sentences and multiple finals, replace interim', () => {
  const tracker = new ResultTracker();
  assert.deepEqual(tracker.read(event(result('he'))), { finals: [], interim: 'he' });
  assert.deepEqual(tracker.read(event(result('hello', true), result('hello', true), result('next'))), { finals: ['hello', 'hello'], interim: 'next' });
  assert.deepEqual(tracker.read(event(result('hello', true), result('hello', true), result('next word'))), { finals: [], interim: 'next word' });
});
test('stop waits for final, commits residual once and rejects late events', () => {
  const f = speechFixture(); f.speech.start('en');
  const r = f.instances[0]; r.result(result('tail')); f.speech.stop();
  assert.equal(f.finals.length, 0);
  r.result(result('tail.', true)); r.end(); r.end(); r.result(result('late', true));
  assert.deepEqual(f.finals, [{ text: 'tail.', source: 'en' }]);
  assert.equal(f.timers.tasks.size, 0);
  f.speech.start('ja'); const next = f.instances[1]; next.result(result('最後')); f.speech.stop(); f.timers.next();
  assert.deepEqual(f.finals.at(-1), { text: '最後', source: 'ja' });
  assert.equal(next.aborted, true);
});
test('live source switch drains old language then starts latest requested language', () => {
  const f = speechFixture(); f.speech.start('en'); const old = f.instances[0];
  old.result(result('old')); f.speech.switchLanguage('ja'); f.speech.switchLanguage('ko');
  assert.equal(f.instances.length, 1); old.end(); f.timers.next();
  assert.equal(f.instances[1].lang, 'ko-KR');
  f.instances[1].result(result('new', true));
  assert.deepEqual(f.finals, [{ text: 'old', source: 'en' }, { text: 'new', source: 'ko' }]);
  f.speech.reset();
});
test('clear invalidates recognition before abort and ignores delayed results', () => {
  const f = speechFixture(); f.speech.start('en'); const r = f.instances[0];
  r.result(result('interim')); f.speech.reset(); r.result(result('late', true)); r.end();
  assert.equal(f.finals.length, 0); assert.equal(f.timers.tasks.size, 0);
});
test('closing the page keeps the words still being recognised, exactly once', () => {
  const f = speechFixture(); f.speech.start('en'); const r = f.instances[0];
  r.result(result('almost done')); f.speech.reset({ keepInterim: true }); r.result(result('late', true)); r.end();
  assert.deepEqual(f.finals, [{ text: 'almost done', source: 'en' }]);
  assert.equal(f.speech.wanted, false); assert.equal(f.timers.tasks.size, 0);
});
test('a long continuous session scans only results after the committed run', () => {
  const tracker = new ResultTracker();
  const finals = Array.from({ length: 500 }, (_, i) => result(`s${i}`, true));
  assert.equal(tracker.read(event(...finals)).finals.length, 500);
  assert.equal(tracker.settled, 500); assert.equal(tracker.finalIndexes.size, 0);
  let touched = 0;
  const watched = finals.map((item, i) => i < 500 ? new Proxy(item, { get(target, key) { if (key === 'isFinal') touched++; return target[key]; } }) : item);
  assert.deepEqual(tracker.read(event(...watched, result('next'))), { finals: [], interim: 'next' });
  assert.equal(touched, 0);
  // A final that lands after an interim gap is still committed once, and the run catches up.
  assert.deepEqual(tracker.read(event(...finals, result('a'), result('b', true))), { finals: ['b'], interim: 'a' });
  assert.equal(tracker.settled, 500);
  assert.deepEqual(tracker.read(event(...finals, result('a', true), result('b', true))), { finals: ['a'], interim: '' });
  assert.equal(tracker.settled, 502);
});
test('permission errors do not retry; recoverable interruptions have bounded retries', () => {
  const f = speechFixture(); f.speech.start('en');
  f.instances[0].onerror({ error: 'not-allowed' }); f.instances[0].end();
  assert.equal(f.speech.wanted, false); assert.equal(f.errors.length, 1); assert.equal(f.timers.tasks.size, 0);
  f.speech.start('en');
  for (let i = 0; i < 6; i++) { f.instances.at(-1).end(); f.timers.next(); }
  assert.equal(f.speech.wanted, false); assert.equal(f.errors.length, 2);
});
test('long silence keeps listening: no-speech and clean quiet ends resume quickly without counting failures', () => {
  const f = speechFixture(); f.speech.start('en');
  for (let i = 0; i < 20; i++) {
    const r = f.instances.at(-1); f.timers.time += 1000;
    r.onerror({ error: 'no-speech' }); r.end();
    assert.deepEqual([...f.timers.tasks.values()].map(task => task.ms), [250]);
    f.timers.next();
  }
  for (let i = 0; i < 20; i++) { f.timers.time += 4000; f.instances.at(-1).end(); f.timers.next(); }
  assert.equal(f.speech.wanted, true); assert.equal(f.errors.length, 0);
  assert.equal(f.states.includes('resuming'), true); assert.equal(f.states.includes('reconnecting'), false);
  f.speech.reset();
});
test('a stable session resets the failure count; instant clean ends still count as failures', () => {
  const f = speechFixture(); f.speech.start('en');
  for (let i = 0; i < 5; i++) { f.instances.at(-1).end(); f.timers.next(); }
  assert.equal(f.speech.wanted, true);
  const stable = f.instances.at(-1); f.timers.time += 15000; stable.onerror({ error: 'network' }); stable.end(); f.timers.next();
  for (let i = 0; i < 4; i++) { f.instances.at(-1).end(); f.timers.next(); }
  assert.equal(f.speech.wanted, true);
  f.instances.at(-1).end();
  assert.equal(f.speech.wanted, false); assert.equal(f.errors.length, 1);
});
test('manual stop during reconnect cancels restart', () => {
  const f = speechFixture(); f.speech.start('en'); f.instances[0].end(); f.speech.stop();
  assert.equal(f.timers.tasks.size, 0); assert.equal(f.states.at(-1), 'idle');
});

test('targets are captured per paragraph; a failure does not block later work', async () => {
  const calls = [];
  const model = new Transcript({ translator: { async translate(text, source, target) { calls.push([text, source, target]); if (text === 'fail') throw new Error('network'); return `${target}:${text}`; } } });
  model.append('first', 'en', 'zh-TW'); model.append('fail', 'ja', 'zh-TW'); model.append('third', 'ko', 'en');
  await flush();
  assert.deepEqual(calls, [['first', 'en', 'zh-TW'], ['fail', 'ja', 'zh-TW'], ['third', 'ko', 'en']]);
  assert.deepEqual(model.segments.map(s => s.status), ['done', 'error', 'done']);
});
test('full retranslation snapshots mixed sources and blocks old results from overwriting', async () => {
  const first = deferred(); let count = 0; const calls = [];
  const model = new Transcript({ translator: { translate(text, source, target) { calls.push([text, source, target]); return ++count === 1 ? first.promise : Promise.resolve(`${target}:${text}`); } } });
  model.append('A', 'en', 'zh-TW'); model.append('B', 'ja', 'zh-TW');
  const retranslation = model.retranslate('ko');
  model.append('C', 'ko', 'en');
  assert.equal(model.batch, true);
  first.resolve('stale'); await retranslation; await flush();
  assert.deepEqual(model.segments.map(s => s.translation), ['ko:A', 'ko:B', 'en:C']);
  assert.equal(calls.some(([text, , target]) => text === 'B' && target === 'zh-TW'), false);
  assert.equal(model.batch, false);
});
test('failed retranslation keeps prior translation and retry uses requested target', async () => {
  let fail = false;
  const model = new Transcript({ translator: { async translate(text, source, target) { if (fail) throw new Error('failed'); return target; } } });
  model.append('A', 'en', 'zh-TW'); await flush(); fail = true;
  await model.retranslate('ja');
  assert.equal(model.segments[0].translation, 'zh-TW');
  assert.equal(model.segments[0].translationTarget, 'zh-TW');
  assert.equal(model.segments[0].status, 'error');
  fail = false; model.retry(); await flush();
  assert.equal(model.segments[0].translation, 'ja');
});
test('clear cancels work, resolves batch, and late translations cannot restore old text', async () => {
  const work = deferred();
  const model = new Transcript({ translator: { translate: () => work.promise } });
  model.append('old', 'en', 'ja'); const batch = model.retranslate('ko'); model.clear(); work.resolve('late');
  await batch; await flush(); assert.deepEqual(model.segments, []); assert.equal(model.batch, false);
});
test('restoring unfinished translations exposes retry without automatically translating', () => {
  const model = new Transcript({ translator: {} });
  model.restore([{ id: '1', status: 'pending', source: 'en', target: 'ja', translation: '' }, { id: '2', status: 'waiting', source: 'en', target: 'ja', translation: '' }]);
  assert.deepEqual(model.segments.map(s => s.status), ['error', 'error']); assert.match(model.segments[1].error, /尚未完成/);
});
test('paragraphs during a model download wait without blocking other pairs, then resume', async () => {
  const download = deferred();
  const service = new TranslationService({ api: {
    availability: async () => 'available',
    create: options => options.monitor ? download.promise : Promise.resolve({ translate: async text => `${options.targetLanguage}:${text}` }),
  } });
  const model = new Transcript({ translator: service });
  const preparing = service.prepare('en', 'ja');
  model.append('A', 'en', 'ja'); model.append('B', 'ko', 'en');
  await tick();
  assert.deepEqual(model.segments.map(s => s.status), ['waiting', 'done']);
  assert.equal(model.segments[1].translation, 'en:B');
  download.resolve({ translate: async text => `ja:${text}` }); await preparing;
  model.resume(); await tick();
  assert.deepEqual(model.segments.map(s => [s.status, s.translation]), [['done', 'ja:A'], ['done', 'en:B']]);
});
test('replace swaps the transcript and cancels queued work', async () => {
  const work = deferred(); let changes = 0;
  const model = new Transcript({ translator: { translate: () => work.promise }, onChange: () => changes++ });
  model.append('old', 'en', 'ja'); model.replace([{ id: 'n', sourceText: 'new', translation: '新', status: 'done', source: 'en', target: 'ja' }]);
  work.resolve('late'); await tick();
  assert.deepEqual(model.segments.map(s => [s.sourceText, s.translation]), [['new', '新']]);
  assert.ok(changes >= 2);
});

test('prepare invokes create synchronously in click stack and monitors progress', async () => {
  let inClick = true; let listener; const statuses = [];
  const service = new TranslationService({ api: { create(options) { assert.equal(inClick, true); assert.equal(options.sourceLanguage, 'zh-Hant'); options.monitor({ addEventListener(type, fn) { assert.equal(type, 'downloadprogress'); listener = fn; } }); return Promise.resolve({ translate: async () => 'test' }); } }, onPackage: (...args) => statuses.push(args) });
  const work = service.prepare('zh-TW', 'en'); inClick = false; listener({ loaded: .5, total: 1 });
  await work;
  assert.ok(statuses.some(([, , state, progress]) => state === 'downloading' && progress === .5));
  assert.equal(statuses.at(-1)[2], 'available');
});
test('automatic translation refuses to download; availability timeout and failed call recover', async () => {
  let state = 'downloadable', creates = 0;
  const service = new TranslationService({ api: { availability: async () => state, create: async () => { creates++; return { translate: async () => 'ok' }; } } });
  await assert.rejects(service.translate('hi', 'en', 'ja'), /準備/); assert.equal(creates, 0);
  state = 'available'; assert.equal(await service.translate('hi', 'en', 'ja'), 'ok');
  const hanging = new TranslationService({ api: { availability: () => new Promise(() => {}) }, availabilityMs: 5 });
  await assert.rejects(hanging.translate('hi', 'en', 'ja'), /逾時/);
});
test('late model after timeout is destroyed and a later preparation can succeed', async () => {
  const d = deferred(); let destroyed = 0;
  const service = new TranslationService({ api: { create: () => d.promise }, createMs: 5 });
  await assert.rejects(service.prepare('en', 'ja'), /逾時/);
  d.resolve({ destroy() { destroyed++; } }); await flush(); assert.equal(destroyed, 1); assert.equal(service.sessions.size, 0);
  service.api.create = async () => ({ translate: async () => 'ok' });
  await service.prepare('en', 'ja'); assert.equal(service.sessions.size, 1);
});
test('failed or empty translation retires session; same-language text bypasses API', async () => {
  let attempts = 0, destroyed = 0;
  const service = new TranslationService({ api: { availability: async () => 'available', create: async () => ({ translate: async () => ++attempts === 1 ? '' : 'success', destroy() { destroyed++; } }) } });
  await assert.rejects(service.translate('hi', 'en', 'ja'), /空白/);
  assert.equal(destroyed, 1); assert.equal(await service.translate('hi', 'en', 'ja'), 'success');
  assert.equal(await service.translate('same', 'en', 'en'), 'same');
});
test('aborted deadline cleans up and does not leak late resource', async () => {
  const d = deferred(); const controller = new AbortController(); let late;
  const job = deadline(d.promise, 100, { signal: controller.signal, onLate: value => { late = value; } });
  controller.abort(); await assert.rejects(job, { name: 'AbortError' }); d.resolve('resource'); await flush(); assert.equal(late, 'resource');
});
test('all export modes include only landed text, retain paragraph boundaries and omit placeholders', () => {
  const segments = [{ sourceText: 'A', translation: '甲', status: 'done' }, { sourceText: 'B', translation: '', status: 'pending' }, { sourceText: 'C', translation: '丙', status: 'error' }];
  assert.equal(exportText(segments, 'source'), 'A\n\nB\n\nC');
  assert.equal(exportText(segments, 'translation'), '甲\n\n丙');
  assert.equal(exportText(segments, 'both'), 'A\n甲\n\nB\n\nC\n丙');
  assert.match(filename(new Date(2026, 10, 23, 9, 5, 2)), /20261123_090502\.txt$/);
});
test('browser recommendation matches Windows desktop Edge only', () => {
  assert.equal(isWindowsEdge({ userAgent: 'Windows NT 10.0 Chrome/140 Edg/140' }), true);
  for (const userAgent of ['Windows NT 10.0 Chrome/140', 'Macintosh Edg/140', 'Android EdgA/140', 'Windows NT Mobile Edg/140']) assert.equal(isWindowsEdge({ userAgent }), false);
});
test('appearance and preference persistence validate stored values and recover from failures', () => {
  const values = new Map(); const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  let preferences = readPreferences(storage); assert.equal(preferences.source, 'en'); assert.equal(preferences.appearance.source.size, 18);
  preferences.appearance.source = { font: 'kai', color: '#123abc', darkColor: '#ddeeff', size: 32 }; preferences.warned = true; writePreferences(preferences, storage);
  assert.deepEqual(readPreferences(storage), preferences);
  assert.deepEqual(normalizeAppearance({ source: { font: 'evil', color: 'url(x)', darkColor: 'red', size: 999 } }).source, { font: 'system', size: 18, color: '', darkColor: '' });
  // Older preferences with a single colour keep it as the light-theme colour; dark follows the theme.
  assert.deepEqual(normalizeAppearance({ translation: { font: 'noto', size: 20, color: '#223344' } }).translation, { font: 'noto', size: 20, color: '#223344', darkColor: '' });
  assert.equal(readPreferences({ getItem() { throw new Error('blocked'); } }).mode, 'both');
  assert.throws(() => writePreferences(preferences, { setItem() { throw new Error('quota'); } }), /quota/);
});
test('unreadable saved transcript carries the raw value for backup', async () => {
  const raw = [{ id: 1, sourceText: 'x' }];
  const db = { transaction: () => ({ objectStore: () => ({ get() { const request = {}; setTimeout(() => { request.result = raw; request.onsuccess(); }); return request; } }) }) };
  const store = new TranscriptStore({}); store.db = db;
  await assert.rejects(store.load(), error => error.raw === raw && /暫停保存/.test(error.message));
});
test('every save opens its transaction synchronously, even while another write is in flight', () => {
  const transactions = [];
  const db = { transaction: () => { const tx = { objectStore: () => ({ put: value => { tx.value = value; } }), commit() { tx.committed = true; } }; transactions.push(tx); return tx; } };
  const store = new TranscriptStore({}); store.db = db;
  store.save([{ n: 1 }]);
  assert.equal(transactions.length, 1, 'opened before save() returns');
  store.save([{ n: 2 }], { urgent: true }); // e.g. pagehide while the first write has not completed
  assert.equal(transactions.length, 2, 'not queued behind the write in flight');
  assert.deepEqual(transactions.map(tx => [tx.value[0].n, !!tx.committed]), [[1, false], [2, true]], 'only the urgent save commits early');
});
test('saves apply in the order they were made, so a newer save is never overtaken', async () => {
  const db = sharedDatabase();
  const store = storeOn(db); await store.claim();
  const writes = [store.save([{ v: 1 }]), store.save([{ v: 2 }]), store.save([{ v: 3 }], { urgent: true })];
  await Promise.all(writes);
  assert.deepEqual(db.data.get('current'), [{ v: 3 }]);
});
// Minimal shared IndexedDB stand-in: like real read-write transactions on one store, each runs only
// after the one created before it finished; writes apply on commit and abort rolls them back.
function sharedDatabase() {
  const data = new Map();
  let last = Promise.resolve();
  const db = { data, created: 0, transaction() {
    db.created++;
    const staged = new Map(); let open = 0, aborted = false, finished = false, release;
    const previous = last; last = new Promise(resolve => { release = resolve; });
    const finish = () => { if (open || finished) return; finished = true; queueMicrotask(() => { if (!aborted) { for (const [k, v] of staged) data.set(k, v); tx.oncomplete?.(); } release(); }); };
    const run = (work) => { open++; previous.then(() => { if (!aborted) work(); open--; finish(); }); };
    const tx = {
      objectStore: () => ({
        get(key) { const request = {}; run(() => { request.result = staged.has(key) ? staged.get(key) : data.get(key); request.onsuccess?.(); }); return request; },
        put(value, key) { run(() => staged.set(key, value)); },
      }),
      abort() { aborted = true; finished = true; queueMicrotask(() => { tx.onabort?.(); release(); }); },
      commit() {},
    };
    return tx;
  } };
  return db;
}
function storeOn(db) { const store = new TranscriptStore({}); store.db = db; return store; }
test('the newest editing tab fences out saves from a tab that lost editing', async () => {
  const db = sharedDatabase();
  const oldTab = storeOn(db), newTab = storeOn(db);
  assert.equal(await oldTab.claim(), 1);
  await oldTab.save([{ v: 'old' }]);
  assert.equal(await newTab.claim(), 2);
  await newTab.save([{ v: 'new' }]);
  // A delayed write from the old tab (e.g. a frozen tab waking up) is rolled back, not applied.
  await assert.rejects(oldTab.save([{ v: 'stale' }]), { code: 'fenced' });
  assert.deepEqual(db.data.get('current'), [{ v: 'new' }]);
  assert.equal(oldTab.revoked, true);
  await assert.rejects(oldTab.save([{ v: 'stale again' }], { urgent: true }), { code: 'fenced' });
  assert.deepEqual(db.data.get('current'), [{ v: 'new' }]);
});
test('an urgent (page-closing) save from a tab that lost editing cannot overwrite the new editor', async () => {
  const db = sharedDatabase();
  const oldTab = storeOn(db), newTab = storeOn(db);
  await oldTab.claim(); await oldTab.save([{ v: 'old' }]);
  await newTab.claim(); await newTab.save([{ v: 'new' }]);
  assert.equal(oldTab.revoked, false, 'the old tab has not noticed it lost editing');
  await assert.rejects(oldTab.save([{ v: 'stale on close' }], { urgent: true }), { code: 'fenced' });
  assert.deepEqual(db.data.get('current'), [{ v: 'new' }]);
  // The current editor's urgent save still opens its transaction before returning, and lands.
  const before = db.created;
  const closing = newTab.save([{ v: 'closing' }], { urgent: true });
  assert.equal(db.created, before + 1);
  await closing;
  assert.deepEqual(db.data.get('current'), [{ v: 'closing' }]);
});
test('a draft that names its paragraph is judged by that id only, even if the words repeat', () => {
  const segments = [{ id: 'a', sourceText: '好的。' }, { id: 'b', sourceText: '下一步。' }, { id: 'c', sourceText: '謝謝' }];
  assert.equal(draftLanded({ text: '好的', id: 'never-saved' }, segments), false);
  assert.equal(draftLanded({ text: '好的', id: 'a' }, segments), true);
});
test('a draft without an id only matches paragraphs recognised after its anchor', () => {
  const segments = [{ id: 'a', sourceText: '好的。' }, { id: 'b', sourceText: '下一步。' }];
  assert.equal(draftLanded({ text: '好的', id: null, after: 'b' }, segments), false, 'the earlier 好的 is not this sentence');
  assert.equal(draftLanded({ text: '好的', id: null, after: 'b' }, [...segments, { id: 'c', sourceText: '好的！' }]), true);
  assert.equal(draftLanded({ text: '好的', id: null, after: 'missing' }, segments), false, 'anchor not saved, so neither is the sentence after it');
  assert.equal(draftLanded({ text: '好的', id: null, after: null }, segments), true, 'transcript was empty when drafted: any paragraph counts');
});
test('a revoked tab refuses later writes; the hand-off write before revoking lands', async () => {
  const db = sharedDatabase();
  const editor = storeOn(db); await editor.claim();
  await editor.save([{ v: 'tail' }]); editor.revoke();
  await assert.rejects(editor.save([{ v: 'after hand-off' }]), { code: 'fenced' });
  await assert.rejects(editor.save([{ v: 'closing' }], { urgent: true }), { code: 'fenced' });
  assert.deepEqual(db.data.get('current'), [{ v: 'tail' }]);
  const next = storeOn(db); assert.equal(await next.claim(), 2); assert.equal(next.revoked, false);
});
test('recovery drafts: validation, landed detection and the recoverable list', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  assert.equal(readDraft(storage), null);
  assert.equal(writeDraft({ text: '  Hello wor  ', source: 'en', target: 'zh-TW', at: 5, id: null }, storage), true);
  assert.deepEqual(readDraft(storage), { text: 'Hello wor', source: 'en', target: 'zh-TW', at: 5, id: null, after: null });
  values.set('echoflow.draft', JSON.stringify({ text: 'x', source: 'xx', target: 'en' }));
  assert.equal(readDraft(storage), null, 'unknown language rejected');
  clearDraft(storage); assert.equal(values.has('echoflow.draft'), false);
  const segments = [{ id: 'a', sourceText: 'First.' }, { id: 'b', sourceText: 'Hello, world!' }];
  assert.equal(draftLanded({ text: 'hello wor', id: null }, segments), true, 'interim is part of the saved final');
  assert.equal(draftLanded({ text: 'something else', id: 'z' }, segments), false);
  assert.equal(draftLanded({ text: 'whatever', id: 'a' }, segments), true, 'landed paragraph id present');
  assert.equal(draftLanded({ text: '。', id: null }, []), true, 'punctuation only is not worth offering');
  writeRecoverable([{ text: 'one', source: 'ja', target: 'ko' }, { text: '', source: 'ja', target: 'ko' }], storage);
  assert.deepEqual(readRecoverable(storage).map(d => d.text), ['one']);
  writeRecoverable([], storage); assert.equal(values.has('echoflow.draft.recover'), false);
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.equal(readDraft(blocked), null); assert.equal(writeDraft({}, blocked), false); assert.deepEqual(readRecoverable(blocked), []);
});
test('IndexedDB unavailable surfaces a save/load error', async () => {
  const store = new TranscriptStore(null);
  await assert.rejects(store.open(), /無法使用/);
  await assert.rejects(store.save([]), /無法使用/);
});
