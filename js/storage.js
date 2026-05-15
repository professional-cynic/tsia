// ══════════════════════════════════════════════════════
// STORAGE — localStorage for projects, IndexedDB for dir handles
// ══════════════════════════════════════════════════════
import { STORAGE_KEY, IDB_NAME, IDB_STORE } from './constants.js';
import { state } from './state.js';

// ── localStorage ──────────────────────────────────────

export function saveProjects() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.projects));
  } catch (e) {
    console.warn('Storage full — export JSON backup.', e);
  }
}

export function loadProjects() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state.projects = JSON.parse(raw);
  } catch {
    state.projects = [];
  }
}

// ── IndexedDB (directory handles) ─────────────────────

function openIDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

export async function saveDirHandle(projectId, handle) {
  try {
    const db = await openIDB();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(handle, projectId);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    db.close();
  } catch (e) {
    console.warn('Could not save dir handle:', e);
  }
}

export async function loadDirHandle(projectId) {
  try {
    const db = await openIDB();
    const handle = await new Promise((res, rej) => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(projectId);
      req.onsuccess = e => res(e.target.result);
      req.onerror   = e => rej(e.target.error);
    });
    db.close();
    return handle || null;
  } catch {
    return null;
  }
}
