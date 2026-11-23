import { LANGUAGES, language, pairKey, isWindowsEdge, exportText, filename, SpeechController, TranslationService, Transcript, ApiTranslator, checkApiConfig, DEFAULT_PROMPT, API_FORMATS } from './core.js';
import { TranscriptStore, readPreferences, writePreferences, readDraft, writeDraft, clearDraft, readRecoverable, writeRecoverable, draftLanded, readTranslationSettings, writeTranslationSettings } from './storage.js';
import { FONTS, defaultAppearance } from './appearance.js';
import { VoiceSensor, VoiceStallWatchdog } from './voice-watchdog.js';

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const prefs = readPreferences();
const store = new TranscriptStore();
const packageStates = new Map();
const FOOTNOTE = '文字自動保存在此瀏覽器 · 語音辨識可能需要網路連線';
let ready = false;
let storeReady = false; // The saved transcript loaded and may be written back.
let owner = true; // This tab holds the single-editor lock; only the owner records and saves.
let noticeTimer;
let saveTimer = null;
let saveWarning = false;
let rawBackup;
let speechState = 'idle';
let interimText = '';
let follow = true;
let skipTopScroll = false;
let preparing = false;
let checking = false;
let sensorWarning = false;
const nodes = new Map();
const signatures = new WeakMap();
const stateLabels = { idle: '準備就緒', starting: '正在啟動麥克風…', listening: '正在聆聽', switching: '正在切換辨識語言…', stopping: '正在收妥最後一句…', reconnecting: '服務中斷，正在重新連線…', resuming: '持續聆聽中…' };
const packageLabels = { same: '同語言，無需模型', unsupported: '瀏覽器不支援', unavailable: '此配對不支援', downloadable: '尚待下載', downloading: '正在準備', available: '已就緒', error: '檢查或準備失敗' };
const placeholders = { pending: '翻譯中…', waiting: '等待翻譯包下載完成…' };

function notify(message, error = false) {
  clearTimeout(noticeTimer);
  // Errors interrupt assistive technology (alert); routine notices wait their turn (status).
  $('notice').setAttribute('role', error ? 'alert' : 'status');
  $('notice').setAttribute('aria-live', error ? 'assertive' : 'polite');
  $('notice').textContent = message;
  $('notice').dataset.error = String(error);
  $('notice').hidden = false;
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, error ? 10000 : 5000);
}
function savePreferences() {
  try { writePreferences(prefs); }
  catch { notify('無法保存設定；本次調整仍會生效，請確認瀏覽器允許儲存網站資料。', true); }
}
function setFootnote(text) { $('footnote-text').textContent = text; }
const canSave = () => storeReady && owner;
function saveTranscript() {
  // Coalesce bursts (a final, then its translation) into one write of the whole transcript.
  if (canSave() && saveTimer === null) saveTimer = setTimeout(flushSave, 300);
}
function flushSave({ urgent = false } = {}) {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!canSave()) return;
  void store.save(model.segments, { urgent }).then(() => {
    if (saveWarning) { saveWarning = false; setFootnote(FOOTNOTE); }
    // Everything recognised so far is stored and nothing is mid-sentence: the draft is no longer needed.
    if (saveTimer === null && !interimText.trim()) dropDraft();
  }).catch(error => {
    if (error?.code === 'fenced') { editorLost(); return; } // A newer editing tab exists; never overwrite it.
    setFootnote('本機保存失敗，請匯出文字備份 · 語音辨識可能需要網路連線');
    if (!saveWarning) notify('逐字稿無法保存到瀏覽器，請匯出 TXT 備份，避免重整後遺失。', true);
    saveWarning = true;
  });
}
// Leaving the page writes only unsaved changes, never an untouched (possibly empty) model over saved data.
function flushPendingSave(options) { if (saveTimer !== null) flushSave(options); }

// Recovery draft of the sentence being recognised (see storage.js). Written about once a second
// while recognising and synchronously when the page hides or closes, so a sentence cut off by a
// closed or crashed tab can be offered back even if the transcript write never finished.
let draftTimer = null;
// `after` anchors the draft to the last paragraph so far: its final can only land after that one.
function keepDraft() {
  const text = interimText.trim();
  if (owner && text) writeDraft({ text, source: speech.current?.source || prefs.source, target: prefs.target, at: Date.now(), id: null, after: model.segments.at(-1)?.id ?? null });
}
function scheduleDraft() {
  if (draftTimer === null) draftTimer = setTimeout(() => { draftTimer = null; keepDraft(); }, 1000);
}
function dropDraft() {
  clearTimeout(draftTimer);
  draftTimer = null;
  if (owner) clearDraft();
}
// On opening (or taking over), a live draft that never reached the transcript:
// - names a paragraph (the tail landed on close, but the fenced write could not finish before the
//   page went): the intent is known, so it is restored as that paragraph without asking;
// - is a periodic draft (the tab crashed or was killed mid-sentence): offered to restore or discard.
function collectDraft() {
  if (!owner) return;
  const live = readDraft();
  if (live) {
    clearDraft();
    if (draftLanded(live, model.segments)) { /* already saved */ }
    else if (live.id) {
      model.append(live.text, live.source, live.target);
      notify('已恢復上次關閉前仍在辨識的那一句。');
    } else writeRecoverable([...readRecoverable(), live]);
  }
  showRecovery();
}
function showRecovery() {
  const list = owner ? readRecoverable().filter(draft => !draftLanded(draft, model.segments)) : [];
  if (owner) writeRecoverable(list);
  $('draft-banner').hidden = !list.length;
  if (!list.length) return;
  const first = list[0].text.length > 60 ? `${list[0].text.slice(0, 60)}…` : list[0].text;
  $('draft-text').textContent = `上次關閉前有 ${list.length} 句辨識中的內容沒有存進逐字稿：「${first}」${list.length > 1 ? ` 等 ${list.length} 句` : ''}。`;
}
function download(parts, name, type) {
  const url = URL.createObjectURL(new Blob(parts, { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function populateLanguages(element, selected) {
  element.replaceChildren(...LANGUAGES.map(item => new Option(item.label, item.code)));
  element.value = selected;
}
for (const [id, value] of [['source-language', prefs.source], ['target-language', prefs.target], ['package-source', prefs.source], ['package-target', prefs.target]]) populateLanguages($(id), value);
$('display-mode').value = prefs.mode;

// Custom colours are kept per theme, so a dark text colour picked in light mode never lands on the dark background.
const colorField = () => prefs.theme === 'dark' ? 'darkColor' : 'color';
function applyAppearance(syncControls = false) {
  document.body.dataset.theme = prefs.theme;
  $('author').setAttribute('aria-pressed', String(prefs.theme === 'dark'));
  const themeColors = prefs.theme === 'dark' ? { source: '#e0e7ef', translation: '#9ebfe4' } : { source: '#233243', translation: '#426e9d' };
  for (const kind of ['source', 'translation']) {
    const item = prefs.appearance[kind];
    const color = item[colorField()] || themeColors[kind];
    document.body.style.setProperty(`--${kind}-font`, FONTS.find(font => font.id === item.font).css);
    document.body.style.setProperty(`--${kind}-size`, `${item.size}px`);
    document.body.style.setProperty(`--${kind}-color`, color);
    $(`${kind}-size-output`).value = `${item.size} px`;
    if (syncControls) {
      $(`${kind}-font`).value = item.font;
      $(`${kind}-size`).value = item.size;
      $(`${kind}-color`).value = color;
    }
  }
  document.body.style.setProperty('--line-height', String(prefs.appearance.lineHeight));
  $('line-height-output').value = `${prefs.appearance.lineHeight.toFixed(2)} 倍`;
  if (syncControls) $('line-height').value = prefs.appearance.lineHeight;
  if (ready) scrollAfterRender();
}
for (const kind of ['source', 'translation']) {
  $(`${kind}-font`).replaceChildren(...FONTS.map(font => new Option(font.label, font.id)));
  for (const key of ['font', 'size', 'color']) {
    $(`${kind}-${key}`).addEventListener('input', event => {
      const field = key === 'color' ? colorField() : key;
      prefs.appearance[kind][field] = key === 'size' ? Number(event.target.value) : event.target.value;
      applyAppearance();
      savePreferences();
    });
  }
}
$('line-height').addEventListener('input', event => {
  prefs.appearance.lineHeight = Number(Number(event.target.value).toFixed(2));
  applyAppearance();
  savePreferences();
});
applyAppearance(true);
$('appearance-reset').addEventListener('click', () => { prefs.appearance = defaultAppearance(); applyAppearance(true); savePreferences(); });
$('author').addEventListener('click', () => { prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark'; applyAppearance(true); savePreferences(); });

function nearBottom() {
  return document.documentElement.scrollHeight - window.scrollY - window.innerHeight <= window.innerHeight / 3;
}
function scrollAfterRender() {
  if (follow || $('force-bottom').checked) window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
  $('scroll-bottom').hidden = follow || nearBottom();
}
window.addEventListener('scroll', () => {
  if (skipTopScroll) { skipTopScroll = false; return; }
  if ($('force-bottom').checked) {
    scrollAfterRender();
    return;
  }
  follow = nearBottom();
  $('scroll-bottom').hidden = follow;
}, { passive: true });
$('scroll-bottom').addEventListener('click', () => { follow = true; skipTopScroll = false; scrollAfterRender(); });
$('force-bottom').addEventListener('change', () => {
  skipTopScroll = false;
  follow = $('force-bottom').checked || nearBottom();
  scrollAfterRender();
});
$('scroll-top').addEventListener('click', () => {
  $('force-bottom').checked = false;
  follow = false;
  skipTopScroll = window.scrollY !== 0;
  window.scrollTo({ top: 0, behavior: 'instant' });
  $('scroll-bottom').hidden = nearBottom();
});

function createSegmentNode() {
  const article = document.createElement('article');
  article.className = 'segment';
  for (const cls of ['source', 'translation', 'error']) {
    const node = document.createElement('p');
    node.className = cls;
    article.append(node);
  }
  return article;
}
function renderSegment(segment) {
  let node = nodes.get(segment.id);
  if (!node) { node = createSegmentNode(); nodes.set(segment.id, node); $('segments').append(node); }
  // Skip DOM writes for paragraphs whose visible content has not changed.
  const signature = [prefs.mode, segment.status, segment.target, segment.sourceText, segment.translation, segment.error].join('\u0001');
  if (signatures.get(node) === signature) return;
  signatures.set(node, signature);
  const [source, translation, error] = node.children;
  source.textContent = segment.sourceText;
  source.hidden = prefs.mode === 'translation';
  translation.hidden = prefs.mode === 'source';
  const hasTranslation = !!segment.translation;
  translation.textContent = hasTranslation ? segment.translation : placeholders[segment.status] || '尚無譯文';
  translation.classList.toggle('placeholder', !hasTranslation);
  const target = language(segment.target).label;
  error.textContent = segment.status === 'error' ? `翻譯失敗：${segment.error}${hasTranslation ? '（保留原譯文）' : ''}`
    : hasTranslation && segment.status === 'pending' ? `正在重新翻譯為${target}…`
    : hasTranslation && segment.status === 'waiting' ? `等待${target}翻譯包下載完成後重新翻譯…` : '';
  error.hidden = prefs.mode === 'source' || !error.textContent;
}
function renderInterim() {
  $('interim').hidden = !interimText;
  $('interim').querySelector('.source').textContent = interimText;
  $('interim').querySelector('.source').hidden = prefs.mode === 'translation';
  $('interim').querySelector('.translation').hidden = prefs.mode === 'source';
  $('empty').hidden = !!model.segments.length || !!interimText;
  scrollAfterRender();
}
const recordDisabled = () => !ready || !Recognition || !window.isSecureContext || !owner || speechState === 'stopping';
function updateActions() {
  const segments = model.segments;
  let pending = 0, waiting = 0, errors = 0, hasText = false;
  for (const s of segments) {
    if (s.status === 'pending') pending++;
    else if (s.status === 'waiting') waiting++;
    else if (s.status === 'error') errors++;
    hasText ||= (prefs.mode !== 'translation' && !!s.sourceText) || (prefs.mode !== 'source' && !!s.translation);
  }
  $('copy').disabled = !ready || !hasText;
  $('export').disabled = $('copy').disabled;
  $('retranslate').disabled = !ready || !owner || !segments.length || model.batch;
  $('retranslate').textContent = model.batch ? '全文重譯中…' : '全文重新翻譯';
  $('retry').disabled = !owner || model.batch || !errors;
  $('clear').disabled = !ready || !owner || (!segments.length && !interimText && speechState === 'idle');
  $('paragraph-count').textContent = `${segments.length} 段`;
  const parts = [];
  if (pending) parts.push(`${pending} 段翻譯中`);
  if (waiting) parts.push(`${waiting} 段等待翻譯包`);
  if (errors) parts.push(`${errors} 段待重試${pending || waiting ? '' : ' · 請開啟設定'}`);
  $('translation-status').textContent = parts.join(' · ') || (segments.length ? '翻譯已完成' : '等待轉錄');
}
function render(changed) {
  const count = model.segments.length;
  // A single changed or newly appended paragraph needs no full pass over a long transcript.
  if (changed && nodes.size === count && nodes.has(changed.id)) renderSegment(changed);
  else if (changed && nodes.size === count - 1 && model.segments.at(-1) === changed) renderSegment(changed);
  else {
    const ids = new Set(model.segments.map(s => s.id));
    for (const [id, node] of nodes) if (!ids.has(id)) { node.remove(); nodes.delete(id); }
    for (const segment of model.segments) renderSegment(segment);
  }
  renderInterim();
  updateActions();
}
function packageUpdate(source, target, state, progress = null) {
  const key = pairKey(source, target);
  packageStates.set(key, { source, target, state, progress });
  renderPackages();
}
function renderPackages() {
  const list = [];
  for (const entry of packageStates.values()) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    const status = document.createElement('span');
    name.textContent = `${language(entry.source).label} → ${language(entry.target).label}`;
    status.textContent = `${packageLabels[entry.state] || entry.state}${entry.progress == null ? '' : ` ${Math.round(entry.progress * 100)}%`}`;
    li.append(name, status);
    list.push(li);
  }
  $('package-list').replaceChildren(...list);
  const current = packageStates.get(pairKey($('package-source').value, $('package-target').value));
  const downloading = current?.state === 'downloading';
  $('package-progress').hidden = !downloading;
  if (downloading && current.progress != null) $('package-progress').value = current.progress;
  else $('package-progress').removeAttribute('value');
  $('prepare').disabled = preparing || checking || !globalThis.Translator || $('package-source').value === $('package-target').value;
  $('prepare').textContent = preparing ? '正在準備，請稍候…' : '檢查並預先下載';
}
const translator = new TranslationService({ api: globalThis.Translator, onPackage: packageUpdate });
// Translation engine chosen in settings: the browser's offline packages or a custom API.
let translation = readTranslationSettings();
const apiTranslator = new ApiTranslator({ getConfig: () => translation });
const usingApi = () => translation.method === 'api';
const routedTranslator = { translate: (...args) => (usingApi() ? apiTranslator : translator).translate(...args) };
const model = new Transcript({ translator: routedTranslator, onChange: segment => { render(segment); saveTranscript(); } });
function refreshPair(source, target) {
  if (source === target) return;
  const key = pairKey(source, target);
  const before = packageStates.get(key);
  void translator.availability(source, target).then(state => {
    if (packageStates.get(key) === before) packageUpdate(source, target, state);
  }).catch(() => {});
}
// Deliberately not async: Translator.create() must run while the click's user activation is live.
function autoPrepare(source, target) {
  if (usingApi() || source === target || !globalThis.Translator) return;
  const state = packageStates.get(pairKey(source, target))?.state;
  if (state === 'unavailable' || state === 'unsupported') return;
  const download = state !== 'available';
  const label = `${language(source).label} → ${language(target).label}`;
  const pending = translator.prepare(source, target);
  if (state === 'downloadable' || state === 'downloading') notify(`正在準備 ${label} 翻譯包，完成後自動翻譯；原文會先持續轉錄。`);
  void pending.then(() => {
    if (download) model.retry();
    else model.resume();
  }).catch(error => {
    model.resume(); // Paragraphs parked for this download now fail with an actionable message.
    notify(`${label} 翻譯包準備失敗：${error.message || error}。原文轉錄不受影響，可到「設定」重試。`, true);
  });
}
const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
const watchdog = new VoiceStallWatchdog({ onStall: count => {
  if (!speech.wanted) return;
  if (count > 5) {
    speech.stop();
    notify('有聲音卻無文字的狀況連續發生，已暫停轉錄。請檢查網路及麥克風後重新開始。', true);
    return;
  }
  notify('偵測到累計 5 秒明顯聲音卻沒有文字進展，正在重新啟動辨識。');
  speech.restart(prefs.source);
} });
const sensor = new VoiceSensor({ onFrame: (voiced, durationMs) => watchdog.sample(voiced, durationMs), onUnavailable: () => {
  if (!sensorWarning && speech.wanted) {
    sensorWarning = true;
    notify('音量監測目前無法使用；語音轉錄仍可繼續，卡住時可按 F9 重新啟動。', true);
  }
} });
const speech = new SpeechController({
  Recognition,
  onFinal: (text, source) => model.append(text, source, prefs.target),
  onInterim: text => { interimText = text; if (text.trim()) scheduleDraft(); renderInterim(); updateActions(); },
  onState: state => {
    speechState = state;
    if (state === 'listening') { watchdog.begin(); void sensor.start(); }
    else watchdog.end();
    if (state === 'idle' || state === 'stopping') sensor.stop();
    const active = state !== 'idle';
    $('speech-status').replaceChildren();
    const dot = document.createElement('span');
    dot.className = `status-dot${state === 'listening' ? ' active' : ''}`;
    $('speech-status').append(dot, stateLabels[state]);
    $('record').dataset.active = String(active);
    $('record-label').textContent = state === 'stopping' ? '收妥尾句中…' : active ? '停止轉錄' : '開始轉錄';
    $('record').disabled = recordDisabled();
    updateActions();
  },
  onError: message => notify(message, true),
});
speech.onProgress = () => watchdog.progress();
$('record').title = '開始／停止語音轉錄；轉錄中按 F9 可強制重啟';
function retryFailed(viaShortcut = false) {
  const count = model.segments.filter(s => s.status === 'error' || s.status === 'waiting').length;
  if (!count) { notify('目前沒有需要重試的翻譯。'); return; }
  model.retry();
  notify(`已將 ${count} 段未完成的翻譯重新加入佇列${viaShortcut ? '（F8）' : ''}。`);
}
window.addEventListener('keydown', event => {
  if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
  if (event.key === 'F8') {
    event.preventDefault();
    if (ready && owner && !model.batch) retryFailed(true);
    return;
  }
  if (event.key !== 'F9' || !speech.wanted) return;
  event.preventDefault();
  watchdog.reset();
  speech.restart(prefs.source);
  notify('已強制重啟語音辨識（F9）。');
});
$('record').disabled = true;
$('record').addEventListener('click', () => {
  if (speech.wanted || speech.current) speech.stop();
  else if (owner) { autoPrepare(prefs.source, prefs.target); follow = true; skipTopScroll = false; watchdog.reset(); sensorWarning = false; scrollAfterRender(); speech.start(prefs.source); }
});
$('source-language').addEventListener('change', event => {
  prefs.source = event.target.value;
  if (speech.wanted) autoPrepare(prefs.source, prefs.target);
  else refreshPair(prefs.source, prefs.target);
  watchdog.reset();
  speech.switchLanguage(prefs.source);
  savePreferences();
});
$('target-language').addEventListener('change', event => {
  prefs.target = event.target.value;
  if (speech.wanted) autoPrepare(prefs.source, prefs.target);
  else refreshPair(prefs.source, prefs.target);
  savePreferences();
  notify(`後續段落將翻譯為${language(prefs.target).label}；舊段落可按「全文重新翻譯」更新。`);
});
$('display-mode').addEventListener('change', event => { prefs.mode = event.target.value; savePreferences(); render(); });
$('retranslate').addEventListener('click', () => { void model.retranslate(prefs.target); });
$('retry').addEventListener('click', () => retryFailed());

function exportNotice() {
  return prefs.mode !== 'source' && model.segments.some(s => s.status !== 'done') ? '；尚有未完成的翻譯，已排除狀態提示' : '';
}
$('copy').addEventListener('click', async () => {
  const text = exportText(model.segments, prefs.mode);
  if (!text) return;
  const suffix = exportNotice();
  try { await navigator.clipboard.writeText(text); notify(`已複製${suffix}`); }
  catch { notify('無法存取剪貼簿，請允許剪貼簿權限，或使用「匯出 TXT」。', true); }
});
$('export').addEventListener('click', () => {
  const text = exportText(model.segments, prefs.mode);
  if (!text) return;
  download(['﻿', text], filename(), 'text/plain;charset=utf-8');
  notify(`已匯出 TXT${exportNotice()}`);
});
$('clear').addEventListener('click', () => $('clear-dialog').showModal());
$('clear-cancel').addEventListener('click', () => $('clear-dialog').close());
$('clear-confirm').addEventListener('click', () => {
  speech.reset();
  model.clear();
  flushSave();
  dropDraft();
  writeRecoverable([]);
  showRecovery();
  $('clear-dialog').close();
  follow = true;
  notify('已清空逐字稿，設定及翻譯包已保留。');
});

async function checkPackages() {
  if (checking || preparing) return;
  checking = true;
  $('check-packages').disabled = true;
  renderPackages();
  const checks = [];
  for (const source of LANGUAGES) for (const target of LANGUAGES) {
    if (source.code === target.code) continue;
    const key = pairKey(source.code, target.code);
    const before = packageStates.get(key);
    checks.push(translator.availability(source.code, target.code).then(state => {
      if (packageStates.get(key) === before) packageUpdate(source.code, target.code, state);
    }).catch(() => { if (packageStates.get(key) === before) packageUpdate(source.code, target.code, 'error'); }));
  }
  await Promise.all(checks);
  checking = false;
  $('check-packages').disabled = false;
  renderPackages();
}
// ---- Translation method settings ----
function showTranslationPanel() {
  $('translation-method').value = translation.method;
  $('panel-offline').hidden = usingApi();
  $('panel-api').hidden = !usingApi();
}
function syncTranslationForm() {
  showTranslationPanel();
  $('api-format').value = translation.format;
  $('api-url').value = translation.url;
  $('api-model').value = translation.model;
  $('api-token').value = translation.token;
  $('api-prompt').value = translation.prompt || DEFAULT_PROMPT;
  $('api-url').placeholder = API_FORMATS[translation.format].url;
  $('api-model').placeholder = API_FORMATS[translation.format].model ? `例如 ${API_FORMATS[translation.format].model}` : '模型名稱';
}
function saveTranslation(patch) {
  translation = { ...translation, ...patch };
  if (!writeTranslationSettings(translation)) notify('無法保存翻譯設定；本次調整仍會生效，請確認瀏覽器允許儲存網站資料。', true);
}
$('translation-method').addEventListener('change', event => {
  saveTranslation({ method: event.target.value === 'api' ? 'api' : 'offline' });
  showTranslationPanel();
  const problem = usingApi() ? checkApiConfig(translation) : '';
  $('api-message').textContent = problem ? `尚未完成設定：${problem}。` : '';
  notify(`後續段落改用${usingApi() ? '自定義 API' : '瀏覽器離線翻譯包'}翻譯；舊段落可按「全文重新翻譯」更新。`);
});
$('api-format').addEventListener('change', event => {
  const format = event.target.value === 'anthropic' ? 'anthropic' : 'openai';
  // Suggest the format's usual endpoint and model only where the field is still empty.
  saveTranslation({ format, url: translation.url || API_FORMATS[format].url, model: translation.model || API_FORMATS[format].model });
  syncTranslationForm();
});
for (const [id, field] of [['api-url', 'url'], ['api-model', 'model'], ['api-token', 'token']]) {
  $(id).addEventListener('input', event => saveTranslation({ [field]: event.target.value.trim() }));
}
// The default prompt is stored as '' so it can improve in later versions without overriding edits.
$('api-prompt').addEventListener('input', event => saveTranslation({ prompt: event.target.value.trim() === DEFAULT_PROMPT ? '' : event.target.value }));
$('api-prompt-reset').addEventListener('click', () => { saveTranslation({ prompt: '' }); syncTranslationForm(); });
$('api-token-toggle').addEventListener('click', () => {
  const show = $('api-token').type === 'password';
  $('api-token').type = show ? 'text' : 'password';
  $('api-token-toggle').textContent = show ? '隱藏' : '顯示';
  $('api-token-toggle').setAttribute('aria-pressed', String(show));
});
$('api-clear-token').addEventListener('click', () => {
  saveTranslation({ token: '' });
  syncTranslationForm();
  $('api-message').textContent = '已從此瀏覽器清除 Token。';
});
$('api-test').addEventListener('click', async () => {
  const source = 'en';
  const target = prefs.target === 'en' ? 'zh-TW' : prefs.target;
  $('api-test').disabled = true;
  $('api-message').textContent = '測試中…';
  try {
    const result = await apiTranslator.translate('Hello, this is a quick translation test.', source, target);
    $('api-message').textContent = `連線成功，${language(target).label}譯文：「${result.slice(0, 120)}」`;
  } catch (error) {
    $('api-message').textContent = `測試失敗：${error.message}`;
  } finally { $('api-test').disabled = false; }
});
// Another tab changed the translation settings: follow them here too.
window.addEventListener('storage', event => {
  if (event.key !== 'echoflow.translation') return;
  translation = readTranslationSettings();
  if ($('settings').open) syncTranslationForm();
});

$('settings-open').addEventListener('click', () => {
  $('package-source').value = prefs.source;
  $('package-target').value = prefs.target;
  syncTranslationForm();
  $('api-message').textContent = '';
  $('settings').showModal();
  applyAppearance(true);
  renderPackages();
  void checkPackages();
});
$('settings-close').addEventListener('click', () => $('settings').close());
$('check-packages').addEventListener('click', checkPackages);
for (const id of ['package-source', 'package-target']) $(id).addEventListener('change', () => {
  renderPackages();
  $('package-message').textContent = $('package-source').value === $('package-target').value ? '來源與目標相同，直接保留原文，無需下載模型。' : '';
});
$('prepare').addEventListener('click', () => {
  const source = $('package-source').value;
  const target = $('package-target').value;
  // No await before prepare(): preserve the click's transient activation for model download.
  const pending = translator.prepare(source, target);
  preparing = true;
  $('check-packages').disabled = true;
  $('package-source').disabled = $('package-target').disabled = true;
  $('package-message').textContent = `正在準備 ${language(source).label} → ${language(target).label}…`;
  renderPackages();
  void pending.then(() => {
    $('package-message').textContent = `${language(source).label} → ${language(target).label} 已就緒。需要其他配對時，請換一組再按一次。`;
    model.retry();
  }).catch(error => {
    packageUpdate(source, target, 'error');
    model.resume();
    $('package-message').textContent = `準備失敗：${error.message || error}。請檢查網路及瀏覽器支援後重試。`;
  }).finally(() => {
    preparing = false;
    $('check-packages').disabled = false;
    $('package-source').disabled = $('package-target').disabled = false;
    renderPackages();
  });
});
$('capabilities').textContent = `目前瀏覽器：語音辨識${Recognition ? '可用' : '不可用'}；Translator API ${globalThis.Translator ? '可用' : '不可用，請更新 Edge 並檢查瀏覽器設定'}。`;
$('browser-ack').addEventListener('click', () => { prefs.warned = true; savePreferences(); $('browser-warning').close(); });

// Read LICENSE as UTF-8 text and show it in place: an extensionless file may be served as a download.
$('license-link').addEventListener('click', async event => {
  event.preventDefault();
  try {
    const response = await fetch(event.currentTarget.href, { cache: 'no-cache' });
    if (!response.ok) throw new Error(String(response.status));
    $('license-text').textContent = await response.text();
    $('license-dialog').showModal();
  } catch { notify('無法載入授權全文，請參閱專案中的 LICENSE 檔案。', true); }
});
$('license-close').addEventListener('click', () => $('license-dialog').close());

$('export-raw').addEventListener('click', () => {
  download([JSON.stringify(rawBackup, null, 2)], filename().replace(/\.txt$/, '_原始備份.json'), 'application/json');
  $('discard-raw').disabled = false;
  notify('已下載原始備份。確認備份無誤後，可按「捨棄舊資料並開始保存」。');
});
$('discard-raw').addEventListener('click', () => {
  storeReady = true;
  rawBackup = undefined;
  $('recovery').hidden = true;
  setFootnote(FOOTNOTE);
  flushSave();
  notify('已捨棄無法讀取的舊資料，之後的逐字稿會自動保存。');
});

// One editing tab per site: a second tab could otherwise overwrite the saved transcript.
// Hand-off order: the editing tab saves its tail and waits for the write to finish, stops
// writing, then releases the lock; only after acquiring the lock does the new tab claim the
// fencing token and read. A tab that does not answer in time loses the lock by force, and the
// token then refuses any write it attempts later.
const HANDOFF_MS = 3000;
const editorChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('echoflow-editor') : null;
let releaseLock = null;
let handingOff = false;
function requestEditor(options) {
  return new Promise((resolve, reject) => {
    let granted = false;
    navigator.locks.request('echoflow-editor', options, lock => {
      if (!lock) { resolve(false); return undefined; }
      granted = true;
      resolve(true);
      return new Promise(release => { releaseLock = release; }); // Held until hand-off or page close.
    }).catch(error => { if (granted) editorLost(); else reject(error); });
  });
}
async function claimEditor() {
  if (!navigator.locks) return true;
  if (await requestEditor({ ifAvailable: true })) return true;
  await sleep(400); // A reloading page may still be releasing its own lock.
  return requestEditor({ ifAvailable: true });
}
function setOwner(value, message = '') {
  owner = value;
  $('tab-banner').hidden = value;
  $('tab-banner-text').textContent = message;
  $('record').disabled = recordDisabled();
  updateActions();
}
// Another tab asked to take over: land the tail, finish writing, then step aside.
async function handOff() {
  if (!owner || handingOff) return;
  handingOff = true;
  try {
    speech.reset({ keepInterim: true });
    clearTimeout(saveTimer);
    saveTimer = null;
    // Created after any write in flight, so it completes last: resolving means everything this tab had is stored.
    if (canSave() && await store.save(model.segments).then(() => true, () => false)) clearDraft();
  } finally {
    store.revoke();
    setOwner(false, '已改由另一個分頁使用，這個分頁已保存最後內容並停止轉錄與保存，只能檢視及匯出。');
    releaseLock?.();
    releaseLock = null;
    handingOff = false;
  }
}
editorChannel?.addEventListener('message', ({ data }) => { if (data?.type === 'handoff-request') void handOff(); });
// The lock was taken by force (this tab did not answer in time) or the token showed a newer editor.
function editorLost() {
  if (!owner) return;
  store.revoke();
  releaseLock = null;
  speech.reset({ keepInterim: true }); // Kept on screen for export; it can no longer be saved here.
  setOwner(false, '另一個分頁已接手編輯，這個分頁已停止轉錄與保存。若有尚未保存的內容，請先匯出備份。');
}
// After this tab holds the lock: bump the token so older editors are fenced, then read the latest copy.
async function adoptLatest() {
  if (!store.db) return;
  await store.claim();
  if (!storeReady) return;
  try { model.replace(await store.load()); }
  catch (error) {
    storeReady = false; // Never save a stale copy over data we could not read.
    notify(`無法載入最新逐字稿：${error.message}。此分頁暫停保存，請匯出備份。`, true);
  }
}
$('tab-takeover').addEventListener('click', async () => {
  $('tab-takeover').disabled = true;
  try {
    editorChannel?.postMessage({ type: 'handoff-request' });
    let granted = await requestEditor({ signal: AbortSignal.timeout(HANDOFF_MS) }).catch(() => false);
    if (!granted) granted = await requestEditor({ steal: true }); // The other tab did not answer.
    if (!granted) return;
    await adoptLatest();
    setOwner(true);
    collectDraft(); // A tab that was taken over by force may have left an unsaved sentence.
    notify('已改在此分頁使用，內容已更新為最新保存的逐字稿。');
  } catch (error) { notify(`無法改在此分頁使用：${error.message}`, true); }
  finally { $('tab-takeover').disabled = false; }
});

async function initialize() {
  // Take the editing lock before reading, so the copy we load is the one this tab may write back.
  owner = await claimEditor();
  try {
    await store.open();
    if (owner && navigator.locks) await store.claim().catch(() => {});
    model.restore(await store.load());
    storeReady = true;
  } catch (error) {
    if (error.raw !== undefined) {
      rawBackup = error.raw;
      $('recovery').hidden = false;
      setFootnote('舊逐字稿無法讀取，已暫停保存以免覆蓋 ·');
      notify(`${error.message}。請先下載原始備份。`, true);
    } else {
      notify(`無法載入本機逐字稿：${error.message}。本次文字請匯出備份。`, true);
      setFootnote('本機保存目前不可用，請匯出備份 · 語音辨識可能需要網路連線');
    }
  }
  ready = true;
  render();
  collectDraft();
  refreshPair(prefs.source, prefs.target);
  if (!owner) setOwner(false, '這個工具已在其他分頁開啟。為避免互相覆蓋，此分頁暫停轉錄與保存，只能檢視及匯出。');
  $('record').disabled = recordDisabled();
  if (!window.isSecureContext) notify('請透過 HTTPS 或 localhost 開啟，才能使用麥克風及瀏覽器翻譯功能。', true);
  else if (!Recognition) notify('目前瀏覽器不支援語音辨識，請使用 Windows 電腦版 Edge。', true);
  if (!isWindowsEdge() && !prefs.warned) $('browser-warning').showModal();
}
void initialize();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return;
  keepDraft();
  flushPendingSave();
});
// Best effort on close: land the sentence being recognised as a paragraph and start writing it.
// The draft is written first and synchronously, naming that paragraph; if the transcript write
// does not finish before the page goes, reopening finds the paragraph missing and offers the draft.
window.addEventListener('pagehide', () => {
  const tail = interimText.trim();
  const source = speech.current?.source || prefs.source;
  speech.reset();
  if (tail && owner) {
    const segment = model.append(tail, source, prefs.target);
    writeDraft({ text: tail, source, target: prefs.target, at: Date.now(), id: segment.id });
  }
  flushPendingSave({ urgent: true });
  sensor.stop();
  watchdog.reset();
});
$('draft-restore').addEventListener('click', () => {
  const list = readRecoverable();
  for (const draft of list) model.append(draft.text, draft.source, draft.target);
  writeRecoverable([]);
  showRecovery();
  notify(`已恢復 ${list.length} 句未保存的內容，並加入翻譯佇列。`);
});
$('draft-discard').addEventListener('click', () => {
  writeRecoverable([]);
  showRecovery();
  notify('已捨棄未保存的辨識內容。');
});
