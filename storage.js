import { language, deadline } from './core.js';
import { defaultAppearance, normalizeAppearance } from './appearance.js';

export class TranscriptStore {
  constructor(indexedDB = globalThis.indexedDB) { this.indexedDB = indexedDB; this.token = null; this.revoked = false; }
  async open() {
    if (!this.indexedDB) throw new Error('此瀏覽器無法使用本機資料庫');
    this.db = await deadline(new Promise((resolve, reject) => {
      const request = this.indexedDB.open('echoflow', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('documents');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('本機資料庫被其他分頁阻擋'));
    }), 5000, { onLate: database => database.close() });
    this.db.onversionchange = () => this.db.close();
  }
  async load() {
    if (!this.db) throw new Error('本機資料庫尚未開啟');
    const value = await deadline(new Promise((resolve, reject) => {
      const request = this.db.transaction('documents', 'readonly').objectStore('documents').get('current');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }), 5000);
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some(s => !s || typeof s.id !== 'string' || typeof s.sourceText !== 'string' ||
      typeof s.translation !== 'string' || !language(s.source) || !language(s.target) ||
      !['pending', 'waiting', 'done', 'error'].includes(s.status) || (s.translationTarget != null && !language(s.translationTarget)))) {
      // Carry the unreadable value so the page can offer it as a raw backup before anything overwrites it.
      throw Object.assign(new Error('儲存的逐字稿格式無法讀取，已暫停保存以免覆蓋'), { raw: value });
    }
    return value;
  }
  // Fencing for tab hand-off: the editing tab bumps a token stored beside the transcript, and every
  // ordinary save checks it inside the same transaction. A tab that lost editing (even one that was
  // frozen and wakes later) therefore cannot overwrite what the new editing tab saved.
  claim() {
    if (!this.db) return Promise.reject(new Error('本機資料庫尚未開啟'));
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction('documents', 'readwrite');
      const documents = transaction.objectStore('documents');
      let token;
      const request = documents.get('editor');
      request.onsuccess = () => {
        token = (Number.isInteger(request.result) ? request.result : 0) + 1;
        documents.put(token, 'editor');
      };
      transaction.oncomplete = () => { this.token = token; this.revoked = false; resolve(token); };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('無法取得編輯權'));
    });
  }
  // Called when this tab stops being the editor: future writes are refused.
  revoke() { this.revoked = true; }
  // Every save opens its transaction immediately, with no promise queue in front of it. IndexedDB
  // runs read-write transactions on the same store in the order they were created, so a newer save
  // is never overtaken by an older one, and a save made while the page closes is never stuck behind
  // a write still in flight.
  // Every transcript write verifies the editor token inside its transaction, urgent ones included:
  // a tab that lost editing but has not noticed yet must never overwrite the new editor. urgent
  // (page closing) additionally commits as soon as the write is queued. Because the token read is a
  // round-trip, a write started while the page unloads may not finish; the recovery draft below
  // is the backstop for that sentence.
  save(segments, { urgent = false } = {}) {
    const snapshot = structuredClone(segments);
    return new Promise((resolve, reject) => {
      if (!this.db) { reject(new Error('本機資料庫無法使用')); return; }
      if (this.revoked) { reject(Object.assign(new Error('此分頁已不是編輯分頁'), { code: 'fenced' })); return; }
      const transaction = this.db.transaction('documents', 'readwrite');
      const documents = transaction.objectStore('documents');
      let fenced = false;
      // Commit right after the write instead of when the event loop idles, e.g. while the page unloads.
      const write = () => { documents.put(snapshot, 'current'); if (urgent) transaction.commit?.(); };
      if (this.token == null) write(); // No lock support or no claim: single-tab mode, nothing to fence.
      else {
        const check = documents.get('editor');
        check.onsuccess = () => {
          if (check.result === this.token) write();
          else { fenced = true; this.revoked = true; transaction.abort(); }
        };
      }
      transaction.oncomplete = resolve;
      transaction.onerror = () => { if (!fenced) reject(transaction.error); };
      transaction.onabort = () => reject(fenced ? Object.assign(new Error('另一個分頁已接手編輯'), { code: 'fenced' }) : transaction.error || new Error('儲存已中斷'));
    });
  }
}

// Recovery draft: the sentence still being recognised, kept in localStorage because its write is
// synchronous and small, so it survives a tab closing (or crashing) mid-sentence even when the
// transcript write does not. `id` names the paragraph the tail was landed as when the page closed,
// so reopening can tell whether that paragraph reached the transcript.
// The live draft is rewritten while recognising; on reopening, a draft that did not reach the
// transcript moves to the recoverable list, which stays until the person restores or discards it.
const DRAFT_KEY = 'echoflow.draft';
const RECOVER_KEY = 'echoflow.draft.recover';
function validDraft(draft) {
  if (!draft || typeof draft.text !== 'string' || !draft.text.trim() || !language(draft.source) || !language(draft.target)) return null;
  return { text: draft.text.trim(), source: draft.source, target: draft.target, at: Number(draft.at) || 0,
    id: typeof draft.id === 'string' ? draft.id : null, after: typeof draft.after === 'string' ? draft.after : null };
}
// Storage is looked up inside try: a blocked localStorage throws on access, and drafts are optional.
const local = storage => storage || globalThis.localStorage;
export function readDraft(storage) {
  try { return validDraft(JSON.parse(local(storage).getItem(DRAFT_KEY) || 'null')); } catch { return null; }
}
export function writeDraft(draft, storage) {
  try { local(storage).setItem(DRAFT_KEY, JSON.stringify(draft)); return true; } catch { return false; }
}
export function clearDraft(storage) {
  try { local(storage).removeItem(DRAFT_KEY); } catch {}
}
export function readRecoverable(storage) {
  try {
    storage = local(storage);
    const list = JSON.parse(storage.getItem(RECOVER_KEY) || '[]');
    return Array.isArray(list) ? list.map(validDraft).filter(Boolean) : [];
  } catch { return []; }
}
export function writeRecoverable(list, storage) {
  try {
    storage = local(storage);
    if (list.length) storage.setItem(RECOVER_KEY, JSON.stringify(list));
    else storage.removeItem(RECOVER_KEY);
  } catch {}
}
// True when the draft already reached the saved transcript.
// - With an id (the tail landed as that paragraph on close), only that id decides: the same words
//   may well have been said earlier ("好的"), so text must not be trusted.
// - Without an id (a periodic draft), `after` is the last paragraph that existed when it was
//   written. Its final can only appear after that anchor, and a saved snapshot that holds the final
//   also holds the anchor, so a missing anchor means not landed. After the anchor, paragraphs are
//   compared by words, since an interim usually differs from its final only in punctuation,
//   spacing and case. A null anchor means the transcript was empty, so every paragraph is after it.
export function draftLanded(draft, segments) {
  if (draft.id) return segments.some(s => s.id === draft.id);
  const words = text => text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
  const wanted = words(draft.text);
  if (!wanted) return true; // Punctuation only: nothing worth offering back.
  let start = 0;
  if (draft.after) {
    const anchor = segments.findIndex(s => s.id === draft.after);
    if (anchor < 0) return false;
    start = anchor + 1;
  }
  return segments.slice(start).some(s => words(s.sourceText).includes(wanted));
}

export function readPreferences(storage) {
  const defaults = { source: 'en', target: 'zh-TW', mode: 'both', theme: 'light', warned: false, appearance: defaultAppearance() };
  try {
    storage ||= globalThis.localStorage;
    const value = JSON.parse(storage.getItem('echoflow.preferences') || '{}');
    return {
      source: language(value.source)?.code || defaults.source,
      target: language(value.target)?.code || defaults.target,
      mode: ['source', 'translation', 'both'].includes(value.mode) ? value.mode : defaults.mode,
      theme: value.theme === 'dark' ? 'dark' : 'light',
      warned: value.warned === true,
      appearance: normalizeAppearance(value.appearance),
    };
  } catch { return defaults; }
}

export function writePreferences(value, storage = globalThis.localStorage) {
  storage.setItem('echoflow.preferences', JSON.stringify(value));
}
