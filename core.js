export const LANGUAGES = [
  { code: 'zh-TW', speech: 'zh-TW', translate: 'zh-Hant', label: '繁體中文' },
  { code: 'en', speech: 'en-US', translate: 'en', label: '英文' },
  { code: 'ja', speech: 'ja-JP', translate: 'ja', label: '日文' },
  { code: 'ko', speech: 'ko-KR', translate: 'ko', label: '韓文' },
];
export const language = code => LANGUAGES.find(item => item.code === code);
export const pairKey = (source, target) => `${source}->${target}`;
export const isWindowsEdge = (nav = navigator) => {
  const ua = nav.userAgent || '';
  return /Windows NT/.test(ua) && /Edg\//.test(ua) && !/Mobile|Android|EdgA|EdgiOS/.test(ua);
};

// Export only actual text. Interim and presentation/status strings never enter this model.
export function exportText(segments, mode) {
  return segments.map(segment => {
    const lines = [];
    if (mode !== 'translation' && segment.sourceText) lines.push(segment.sourceText);
    if (mode !== 'source' && segment.translation) lines.push(segment.translation);
    return lines.join('\n');
  }).filter(Boolean).join('\n\n');
}

export function filename(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `聽譯流_EchoFlow_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.txt`;
}

export function deadline(promise, ms, { signal, onLate = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      fn(value);
    };
    const abort = () => finish(reject, new DOMException('已取消', 'AbortError'));
    const timer = setTimeout(() => finish(reject, new Error('操作逾時，請稍後重試')), ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => {
      if (settled) { onLate(value); return; }
      finish(resolve, value);
    }, error => finish(reject, error));
  });
}

export class ResultTracker {
  constructor() { this.finalIndexes = new Set(); this.settled = 0; }
  read(event) {
    const finals = [];
    const interim = [];
    // Scan the session results, not transcript strings; repeated spoken sentences are valid.
    // Skip the leading run already committed as final: in a long continuous session event.results
    // keeps growing, and rescanning it from 0 on every interim update would be O(n²). Starting at
    // that run (not at event.resultIndex) still sees an unchanged interim that sits below resultIndex.
    for (let index = this.settled; index < event.results.length; index++) {
      const result = event.results[index];
      const text = result[0]?.transcript?.trim() || '';
      if (result.isFinal) {
        if (!this.finalIndexes.has(index)) {
          this.finalIndexes.add(index);
          if (text) finals.push(text);
        }
      } else if (!this.finalIndexes.has(index) && text) interim.push(text);
    }
    while (this.finalIndexes.has(this.settled)) this.finalIndexes.delete(this.settled++);
    return { finals, interim: interim.join(' ') };
  }
}

// A session that ran this long was healthy; its end starts a fresh failure count.
const STABLE_SESSION_MS = 10000;
// A clean end after this long is the service's normal silence cut-off, not a failure.
const QUIET_SESSION_MS = 3000;

export class SpeechController {
  constructor({ Recognition, onFinal, onInterim, onState, onError, timers = globalThis, now = () => Date.now() }) {
    Object.assign(this, { Recognition, onFinal, onInterim, onState, onError, timers, now });
    this.current = null;
    this.wanted = false;
    this.source = 'en';
    this.failures = 0;
    this.restartTimer = null;
  }
  start(source) {
    if (this.wanted || this.current) return;
    this.source = source;
    this.wanted = true;
    this.failures = 0;
    this.open();
  }
  switchLanguage(source) {
    this.source = source;
    if (!this.wanted) return;
    this.restart(source);
  }
  restart(source = this.source) {
    if (!this.wanted) return false;
    this.source = source;
    this.failures = 0;
    this.clearRestart();
    const context = this.current;
    this.current = null;
    if (context) {
      this.timers.clearTimeout(context.timer);
      if (context.interim.trim()) this.onFinal(context.interim.trim(), context.source);
      try { context.recognition.abort(); } catch {}
    }
    this.onInterim('');
    this.onState('switching');
    this.restartTimer = this.timers.setTimeout(() => { this.restartTimer = null; this.open(); }, 250);
    return true;
  }
  stop() {
    this.wanted = false;
    this.clearRestart();
    if (this.current) this.drain('stop');
    else this.onState('idle');
  }
  clearRestart() {
    if (this.restartTimer !== null) this.timers.clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }
  // keepInterim commits the words still being recognised (closing the tab); clearing discards them.
  reset({ keepInterim = false } = {}) {
    this.wanted = false;
    this.clearRestart();
    const context = this.current;
    this.current = null; // Invalidate before abort; synchronous/late events cannot write back.
    if (context) {
      this.timers.clearTimeout(context.timer);
      if (keepInterim && context.interim.trim()) this.onFinal(context.interim.trim(), context.source);
      try { context.recognition.abort(); } catch {}
    }
    this.onInterim('');
    this.onState('idle');
  }
  drain(intent) {
    const context = this.current;
    if (!context) return;
    context.intent = intent;
    this.onState(intent === 'switch' ? 'switching' : 'stopping');
    if (context.draining) return;
    context.draining = true;
    this.timers.clearTimeout(context.timer);
    context.timer = this.timers.setTimeout(() => {
      this.finish(context);
      try { context.recognition.abort(); } catch {}
    }, 4000);
    try { context.recognition.stop(); } catch { this.finish(context); }
  }
  open() {
    if (!this.wanted || this.current) return;
    let recognition;
    try { recognition = new this.Recognition(); }
    catch { this.wanted = false; this.onState('idle'); this.onError('無法建立語音辨識服務，請使用 Windows 電腦版 Edge。'); return; }
    const context = { recognition, source: this.source, tracker: new ResultTracker(), interim: '', intent: '', draining: false, timer: null, startedAt: null };
    this.current = context;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = language(context.source).speech;
    const active = () => this.current === context;
    this.onState('starting');
    context.timer = this.timers.setTimeout(() => {
      if (!active()) return;
      context.error = 'timeout';
      this.finish(context);
      try { recognition.abort(); } catch {}
    }, 12000);
    recognition.onstart = () => {
      if (!active()) return;
      if (context.draining) return;
      this.timers.clearTimeout(context.timer);
      context.startedAt = this.now();
      this.onState('listening');
    };
    recognition.onresult = event => {
      if (!active()) return;
      const result = context.tracker.read(event);
      if (result.finals.length || (result.interim && result.interim !== context.interim)) {
        this.failures = 0;
        this.onProgress?.();
      }
      // Update the residual before notifying consumers, so finals cannot be committed twice.
      context.interim = result.interim;
      for (const text of result.finals) this.onFinal(text, context.source);
      this.onInterim(context.interim);
    };
    recognition.onerror = event => {
      if (!active()) return;
      context.error = event.error;
      const fatal = ['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported', 'bad-grammar'].includes(event.error);
      if (fatal) {
        this.wanted = false;
        context.intent = 'fatal';
        const messages = {
          'not-allowed': '麥克風權限遭拒，請在網址列的網站權限中允許麥克風，再按開始。',
          'service-not-allowed': '瀏覽器或系統禁止語音辨識服務，請檢查 Edge 與系統設定。',
          'audio-capture': '無法取得麥克風，請確認裝置已連接且可供瀏覽器使用。',
          'language-not-supported': '目前辨識服務不支援這個語言，請切換語言後重試。',
        };
        this.onError(messages[event.error] || '語音辨識無法啟動，請檢查瀏覽器設定。');
      }
      if (!context.draining) {
        this.timers.clearTimeout(context.timer);
        context.timer = this.timers.setTimeout(() => {
          this.finish(context);
          try { recognition.abort(); } catch {}
        }, 1500);
      }
    };
    recognition.onend = () => this.finish(context);
    try { recognition.start(); }
    catch (error) {
      context.error = error.name;
      this.finish(context);
    }
  }
  finish(context) {
    if (this.current !== context) return;
    this.timers.clearTimeout(context.timer);
    this.current = null;
    if (context.interim.trim()) this.onFinal(context.interim.trim(), context.source);
    this.onInterim('');
    if (!this.wanted) { this.onState('idle'); return; }
    if (context.intent === 'switch') {
      this.restartTimer = this.timers.setTimeout(() => { this.restartTimer = null; this.open(); }, 250);
      return;
    }
    const lived = context.startedAt === null ? 0 : this.now() - context.startedAt;
    if (lived >= STABLE_SESSION_MS) this.failures = 0;
    // Silence ends sessions with no-speech or a clean end. Resume at once without counting it,
    // so meeting pauses never exhaust retries and the next words are not lost to back-off.
    const quiet = context.startedAt !== null && (context.error === 'no-speech' || (!context.error && lived >= QUIET_SESSION_MS));
    if (quiet) {
      this.onState('resuming');
      this.restartTimer = this.timers.setTimeout(() => { this.restartTimer = null; this.open(); }, 250);
      return;
    }
    this.failures++;
    if (this.failures > 5) {
      this.wanted = false;
      this.onState('idle');
      this.onError('語音辨識已多次中斷，請確認網路及麥克風後重新開始。');
      return;
    }
    this.onState('reconnecting');
    this.restartTimer = this.timers.setTimeout(() => {
      this.restartTimer = null;
      this.open();
    }, Math.min(500 * 2 ** (this.failures - 1), 8000));
  }
}

// Thrown while a pair's model is downloading, so one paragraph never holds the serial queue for minutes.
export const MODEL_DOWNLOADING = 'model-downloading';

export class TranslationService {
  constructor({ api, onPackage = () => {}, availabilityMs = 5000, createMs = 180000, translateMs = 15000 }) {
    Object.assign(this, { api, onPackage, availabilityMs, createMs, translateMs });
    this.sessions = new Map();
    this.creating = new Map();
    this.downloading = new Set();
  }
  options(source, target) {
    return { sourceLanguage: language(source).translate, targetLanguage: language(target).translate };
  }
  async availability(source, target) {
    if (source === target) return 'same';
    if (!this.api) return 'unsupported';
    return deadline(this.api.availability(this.options(source, target)), this.availabilityMs);
  }
  // This method is deliberately not async: create() executes in the original click stack.
  prepare(source, target) {
    if (source === target) return Promise.resolve(null);
    if (!this.api) return Promise.reject(new Error('瀏覽器未提供 Translator API，請更新 Edge 並檢查瀏覽器設定。'));
    const key = pairKey(source, target);
    if (this.sessions.has(key)) return Promise.resolve(this.sessions.get(key));
    if (this.creating.has(key)) return this.creating.get(key);
    this.downloading.add(key);
    try {
      const pending = this.api.create({ ...this.options(source, target), monitor: monitor => {
        monitor.addEventListener('downloadprogress', event => {
          const progress = event.total > 0 ? event.loaded / event.total : null;
          this.onPackage(source, target, 'downloading', progress);
        });
      } });
      this.onPackage(source, target, 'downloading', null);
      return this.trackCreation(key, pending, this.createMs, source, target);
    } catch (error) { this.downloading.delete(key); return Promise.reject(error); }
  }
  trackCreation(key, pending, timeout, source, target) {
    const job = deadline(pending, timeout, { onLate: session => session?.destroy?.() }).then(session => {
      this.sessions.set(key, session);
      this.onPackage(source, target, 'available');
      return session;
    }).catch(error => { this.onPackage(source, target, 'error'); throw error; }).finally(() => {
      if (this.creating.get(key) === job) { this.creating.delete(key); this.downloading.delete(key); }
    });
    this.creating.set(key, job);
    return job;
  }
  async session(source, target, signal) {
    const key = pairKey(source, target);
    if (this.sessions.has(key)) return this.sessions.get(key);
    if (this.downloading.has(key)) throw Object.assign(new Error('翻譯包下載中，完成後自動翻譯'), { code: MODEL_DOWNLOADING });
    if (this.creating.has(key)) return deadline(this.creating.get(key), this.createMs, { signal });
    const state = await deadline(this.availability(source, target), this.availabilityMs, { signal });
    this.onPackage(source, target, state);
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
    // Never start downloads from automatic translation; downloads require an explicit gesture.
    if (state !== 'available') throw new Error(state === 'unavailable' ? '此語言配對不支援本機翻譯' : '請先至設定準備此語言配對的翻譯包');
    if (this.creating.has(key)) return deadline(this.creating.get(key), this.createMs, { signal });
    const pending = this.api.create(this.options(source, target));
    return deadline(this.trackCreation(key, pending, this.translateMs, source, target), this.translateMs, { signal });
  }
  async translate(text, source, target, signal) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
    if (source === target) return text;
    const key = pairKey(source, target);
    let session;
    try {
      session = await this.session(source, target, signal);
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
      const translated = await deadline(session.translate(text, { signal }), this.translateMs, { signal });
      if (typeof translated !== 'string' || !translated.trim()) throw new Error('翻譯回傳空白，請重試');
      return translated.trim();
    } catch (error) {
      if (session && this.sessions.get(key) === session) {
        this.sessions.delete(key);
        try { session.destroy(); } catch {}
      }
      throw error;
    }
  }
}

// ---- Custom translation API ------------------------------------------------------------------
// A provider of the person's choosing, called straight from the page with fetch (the page has no
// build step or CDN, so no SDK). Two request formats: OpenAI-compatible Chat Completions, which
// most providers and local model servers accept, and the Anthropic Messages API.
export const DEFAULT_PROMPT = '你是專業的即時口譯員。請把使用者提供的{source}語音辨識文字翻譯成{target}。只輸出譯文本身，不要加上引號、說明、註解或原文；若原文有明顯的辨識錯字，請依上下文翻出最合理的意思。';
export const API_FORMATS = {
  openai: { label: 'OpenAI 相容（Chat Completions）', url: 'https://api.openai.com/v1/chat/completions', model: '' },
  anthropic: { label: 'Anthropic（Claude Messages）', url: 'https://api.anthropic.com/v1/messages', model: 'claude-opus-5-5' },
};
// Models that accept Anthropic's server-side refusal fallback (`fallbacks: "default"`).
const FALLBACK_MODELS = /^claude-(fable-5-[12]|opus-5(-5)?|sonnet-5-5)$/;

export function fillPrompt(template, source, target) {
  return template.replaceAll('{source}', language(source).label).replaceAll('{target}', language(target).label);
}
// Returns a message describing what is missing, or '' when the configuration can be used.
export function checkApiConfig(config) {
  let url;
  try { url = new URL(config?.url || ''); } catch { return '請填寫有效的 API 網址'; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return 'API 網址須使用 https://（本機服務可用 http://localhost）';
  if (!API_FORMATS[config.format]) return '請選擇介面格式';
  if (!config.model?.trim()) return '請填寫模型名稱';
  return '';
}
function apiRequest(config, system, text) {
  const token = config.token?.trim();
  if (config.format === 'anthropic') {
    const model = config.model.trim();
    const headers = { 'content-type': 'application/json', 'anthropic-version': '2026-10-21', 'anthropic-dangerous-direct-browser-access': 'true' };
    if (token) headers['x-api-key'] = token;
    const body = { model, max_tokens: 16000, system, messages: [{ role: 'user', content: text }] };
    // Opt into server-side fallback on models that support it, so a policy decline is retried by
    // the API on another model instead of leaving the paragraph untranslated.
    if (FALLBACK_MODELS.test(model)) { headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; body.fallbacks = 'default'; }
    return { headers, body };
  }
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return { headers, body: { model: config.model.trim(), messages: [{ role: 'system', content: system }, { role: 'user', content: text }] } };
}
function apiText(format, data) {
  if (format === 'anthropic') {
    if (data?.stop_reason === 'refusal') throw new Error('外部模型拒絕翻譯這段內容');
    return (Array.isArray(data?.content) ? data.content : []).filter(block => block?.type === 'text').map(block => block.text).join('');
  }
  const content = data?.choices?.[0]?.message?.content;
  return Array.isArray(content) ? content.map(part => part?.text || '').join('') : content;
}

export class ApiTranslator {
  constructor({ getConfig, fetch = (...args) => globalThis.fetch(...args), timeoutMs = 30000 }) {
    Object.assign(this, { getConfig, fetch, timeoutMs });
  }
  async translate(text, source, target, signal) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
    if (source === target) return text;
    const config = this.getConfig();
    const problem = checkApiConfig(config);
    if (problem) throw new Error(`自定義 API 設定不完整：${problem}`);
    const system = fillPrompt(config.prompt?.trim() || DEFAULT_PROMPT, source, target);
    const { headers, body } = apiRequest(config, system, text);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    let response, data;
    try {
      // credentials/referrer off: the request carries only what is shown here, never site cookies.
      response = await this.fetch(config.url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
      data = await response.json().catch(() => null);
    } catch {
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
      if (timedOut) throw new Error('外部翻譯 API 逾時，請稍後重試');
      throw new Error('無法連線到外部翻譯 API；請確認網址與網路，以及該服務允許瀏覽器跨來源請求（CORS）');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
    if (!response.ok) {
      const detail = String(data?.error?.message || data?.message || '').slice(0, 160);
      const hint = response.status === 401 || response.status === 403 ? '（請檢查 Token）' : response.status === 404 ? '（請檢查網址與模型名稱）' : response.status === 429 ? '（請求過於頻繁或額度不足）' : '';
      throw new Error(`外部翻譯 API 回應錯誤 HTTP ${response.status}${hint}${detail ? `：${detail}` : ''}`);
    }
    const translated = apiText(config.format, data);
    if (typeof translated !== 'string' || !translated.trim()) throw new Error('外部翻譯 API 沒有回傳譯文');
    return translated.trim();
  }
}

export class Transcript {
  constructor({ translator, onChange = () => {}, makeId = () => crypto.randomUUID() }) {
    Object.assign(this, { translator, onChange, makeId });
    this.segments = [];
    this.queue = [];
    this.epoch = 0;
    this.running = false;
    this.batch = false;
    this.abort = null;
  }
  restore(segments) {
    const unfinished = s => s.status === 'pending' || s.status === 'waiting';
    this.segments = segments.map(s => ({ ...s, version: 0, status: unfinished(s) ? 'error' : s.status,
      error: unfinished(s) ? '上次翻譯尚未完成，請重試' : s.error || '' }));
  }
  // Swap in a whole transcript (clear, or another tab's saved copy), cancelling all queued work.
  replace(segments) {
    this.epoch++;
    this.abort?.abort();
    for (const task of this.queue) task.resolve();
    this.queue = [];
    this.batch = false;
    this.restore(segments);
    this.onChange();
  }
  append(text, source, target) {
    const segment = { id: this.makeId(), sourceText: text, source, target, translation: '', translationTarget: null, status: 'pending', error: '', version: 0, createdAt: Date.now() };
    this.segments.push(segment);
    this.enqueue(segment, target);
    return segment;
  }
  enqueue(segment, target) {
    segment.version++;
    segment.target = target;
    segment.status = 'pending';
    segment.error = '';
    const task = { segment, target, version: segment.version, epoch: this.epoch };
    const done = new Promise(resolve => { task.resolve = resolve; });
    this.queue.push(task);
    this.onChange(segment);
    void this.pump();
    return done;
  }
  valid(task) { return task.epoch === this.epoch && task.segment.version === task.version; }
  async pump() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const task = this.queue.shift();
      if (!this.valid(task)) { task.resolve(); continue; }
      const controller = new AbortController();
      this.abort = controller;
      try {
        const result = await this.translator.translate(task.segment.sourceText, task.segment.source, task.target, controller.signal);
        if (this.valid(task)) Object.assign(task.segment, { translation: result, translationTarget: task.target, status: 'done', error: '' });
      } catch (error) {
        // A downloading model parks the paragraph; resume() re-queues it once the model is ready.
        if (this.valid(task)) Object.assign(task.segment, error?.code === MODEL_DOWNLOADING ? { status: 'waiting', error: '' } : { status: 'error', error: error.message || '翻譯失敗，請重試' });
      } finally {
        if (this.abort === controller) this.abort = null;
        task.resolve();
        if (this.valid(task)) this.onChange(task.segment);
      }
    }
    this.running = false;
  }
  async retranslate(target) {
    if (this.batch || !this.segments.length) return;
    const epoch = this.epoch;
    this.batch = true;
    // Snapshot and invalidate all previous work synchronously before queued promises can resolve.
    const snapshot = [...this.segments];
    const jobs = snapshot.map(segment => this.enqueue(segment, target));
    await Promise.all(jobs);
    if (epoch === this.epoch) { this.batch = false; this.onChange(); }
  }
  retry() {
    for (const segment of this.segments.filter(s => s.status === 'error' || s.status === 'waiting')) this.enqueue(segment, segment.target);
  }
  resume() {
    for (const segment of this.segments.filter(s => s.status === 'waiting')) this.enqueue(segment, segment.target);
  }
  clear() { this.replace([]); }
}
