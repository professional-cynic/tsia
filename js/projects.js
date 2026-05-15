// ══════════════════════════════════════════════════════
// PROJECTS — CRUD, list rendering, open, reload folder
// ══════════════════════════════════════════════════════
import { state, resetAnn } from './state.js';
import { saveProjects, saveDirHandle, loadDirHandle } from './storage.js';
import { showScreen }     from './screens.js';
import { loadImage }      from './navigation.js';
import { ann }            from './state.js';

// ── Render project list ───────────────────────────────

export function renderProjects() {
  const list  = document.getElementById('projects-list');
  const empty = document.getElementById('projects-empty');
  if (state.projects.length === 0) {
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  list.innerHTML = state.projects.map(p => {
    const totalBoxes = p.images.reduce((s, img) => s + img.boxes.length, 0);
    const annotated  = p.images.filter(img => img.boxes.length > 0).length;
    const date       = new Date(p.createdAt).toLocaleDateString();
    return `<div class="project-item">
      <div class="project-info">
        <div class="project-name">${p.name}</div>
        <div class="project-detail">${date} &nbsp;|&nbsp; ${p.images.length} images &nbsp;|&nbsp; ${annotated} annotated &nbsp;|&nbsp; ${totalBoxes} boxes &nbsp;|&nbsp; Classes: ${p.classes.join(', ')}</div>
      </div>
      <div class="project-actions">
        <button class="btn-sm btn-primary" onclick="openProject('${p.id}')">Open</button>
        <button class="btn-sm" onclick="renameProject('${p.id}')">Rename</button>
        <button class="btn-sm" onclick="importProjectJSON('${p.id}')">Import JSON</button>
        <button class="btn-sm btn-danger" onclick="deleteProject('${p.id}')">Delete</button>
      </div>
    </div>`;
  }).join('');
}

// ── CRUD ──────────────────────────────────────────────

export function renameProject(id) {
  const p = state.projects.find(p => p.id === id);
  if (!p) return;
  const n = prompt('New project name:', p.name);
  if (n && n.trim()) { p.name = n.trim(); saveProjects(); renderProjects(); }
}

export function deleteProject(id) {
  if (!confirm('Delete this project and all its annotations? This cannot be undone.')) return;
  state.projects = state.projects.filter(p => p.id !== id);
  saveProjects();
  renderProjects();
}

// ── Open ──────────────────────────────────────────────

export async function openProject(id) {
  const p = state.projects.find(p => p.id === id);
  if (!p) return;

  const stored = await loadDirHandle(id);
  if (stored) {
    const perm = await stored.requestPermission({ mode: 'read' }).catch(() => 'denied');
    if (perm === 'granted') {
      await loadHandlesFromDir(stored, p);
      await finaliseOpen(p);
      return;
    }
  }

  try {
    const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
    await saveDirHandle(id, dirHandle);
    await loadHandlesFromDir(dirHandle, p);
  } catch (e) {
    if (e.name === 'AbortError') return;
    alert('Could not load folder: ' + e.message);
    return;
  }

  await finaliseOpen(p);
}

async function finaliseOpen(p) {
  state.current = p;
  resetAnn(p);
  showScreen('annotate');
  loadImage(0);
}

// ── Directory handle helpers ──────────────────────────

export async function loadHandlesFromDir(dirHandle, p) {
  const handles = {};
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file' && /\.(png|jpg|jpeg|bmp|webp)$/i.test(entry.name)) {
      handles[entry.name] = entry;
    }
  }
  state.fileHandles = handles;
  if (p) {
    const matched = p.images.filter(img => handles[img.filename]).length;
    if (matched < p.images.length) {
      alert(`Matched ${matched} of ${p.images.length} images. Make sure the correct folder is selected.`);
    }
  }
}

export async function reloadFolder() {
  try {
    const p = state.current;
    const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
    if (p) await saveDirHandle(p.id, dirHandle);
    await loadHandlesFromDir(dirHandle, p);
    loadImage(ann.imgIndex);
  } catch (e) {
    if (e.name !== 'AbortError') alert('Could not load folder: ' + e.message);
  }
}

// Expose for HTML onclick
window.openProject    = openProject;
window.renameProject  = renameProject;
window.deleteProject  = deleteProject;
window.reloadFolder   = reloadFolder;
