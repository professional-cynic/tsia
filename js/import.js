// ══════════════════════════════════════════════════════
// IMPORT — new project form, COCO/YOLO/JSON import
// ══════════════════════════════════════════════════════
import { CLASS_COLORS }  from './constants.js';
import { state }         from './state.js';
import { saveProjects, saveDirHandle } from './storage.js';
import { showScreen }    from './screens.js';
import { renderProjects, openProject } from './projects.js';

// ── New-project transient state ───────────────────────

let newProjectFiles       = [];
let newProjectAnnotations = {};
let newProjectDirHandle   = null;

// ── Init form ─────────────────────────────────────────

export function initNewProject() {
  newProjectFiles       = [];
  newProjectAnnotations = {};
  newProjectDirHandle   = null;
  document.getElementById('new-project-name').value = '';
  document.getElementById('new-folder-status').textContent = '';
  document.getElementById('import-status').textContent = '';
  document.getElementById('btn-create-project').disabled = true;
  document.getElementById('classes-list').innerHTML = '';
  addClassRow('defect');
}

// ── Class row helpers ─────────────────────────────────

export function addClassRow(name = '') {
  const list = document.getElementById('classes-list');
  const idx  = list.children.length;
  if (idx >= 9) return;
  const color = CLASS_COLORS[idx];
  const row = document.createElement('div');
  row.className = 'class-row';
  row.innerHTML = `
    <div class="class-swatch" style="background:${color}"></div>
    <input type="text" placeholder="Class name" value="${name}" oninput="checkNewReady()">
    <button class="btn-sm btn-danger" onclick="removeClassRow(this)">✕</button>
  `;
  list.appendChild(row);
  checkNewReady();
}

export function removeClassRow(btn) {
  btn.closest('.class-row').remove();
  document.querySelectorAll('#classes-list .class-row').forEach((row, i) => {
    row.querySelector('.class-swatch').style.background = CLASS_COLORS[i];
  });
  checkNewReady();
}

function clearDefaultClasses() {
  const rows = [...document.querySelectorAll('#classes-list .class-row')];
  rows.forEach(row => {
    const val = row.querySelector('input').value.trim();
    if (!val || val === 'defect') row.remove();
  });
}

export function getClassNames() {
  return [...document.querySelectorAll('#classes-list .class-row input')]
    .map(i => i.value.trim()).filter(Boolean);
}

function checkNewReady() {
  const hasName    = document.getElementById('new-project-name').value.trim().length > 0;
  const hasFolder  = newProjectFiles.length > 0;
  const hasClasses = getClassNames().length > 0;
  document.getElementById('btn-create-project').disabled = !(hasName && hasFolder && hasClasses);
}

// ── Load image folder ─────────────────────────────────

export async function loadNewProjectFolder() {
  try {
    const dirHandle = await window.showDirectoryPicker();
    newProjectDirHandle = dirHandle;
    newProjectFiles = [];
    state.fileHandles = {};
    for await (const entry of dirHandle.values()) {
      if (entry.kind === 'file' && /\.(png|jpg|jpeg|bmp|webp)$/i.test(entry.name)) {
        newProjectFiles.push({ name: entry.name, handle: entry });
        state.fileHandles[entry.name] = entry;
      }
    }
    newProjectFiles.sort((a, b) => a.name.localeCompare(b.name));
    document.getElementById('new-folder-status').textContent =
      `${newProjectFiles.length} image(s) found.`;
    checkNewReady();
  } catch (e) {
    if (e.name !== 'AbortError') alert('Could not load folder: ' + e.message);
  }
}

// ── COCO import ───────────────────────────────────────

export async function importCOCO() {
  const [fh] = await window.showOpenFilePicker({
    types: [{ description: 'COCO JSON', accept: { 'application/json': ['.json'] } }],
  });
  const data = JSON.parse(await (await fh.getFile()).text());

  // Prepopulate project name
  const nameField = document.getElementById('new-project-name');
  if (!nameField.value.trim() && data.info?.description) {
    nameField.value = data.info.description
      .replace(/\s*—\s*Toni's Simple Image Annotator$/i, '').trim();
  }

  clearDefaultClasses();

  // Merge categories
  const importedClasses = (data.categories || []).map(c => c.name);
  const existing = getClassNames();
  importedClasses.forEach(cn => { if (!existing.includes(cn)) addClassRow(cn); });

  const catMap = {};
  (data.categories || []).forEach(c => { catMap[c.id] = c.name; });

  const imgMap = {};
  (data.images || []).forEach(img => { imgMap[img.id] = img.file_name; });

  newProjectAnnotations = {};
  (data.annotations || []).forEach(annItem => {
    const fn = imgMap[annItem.image_id];
    if (!fn) return;
    if (!newProjectAnnotations[fn]) newProjectAnnotations[fn] = [];
    const allClasses = getClassNames();
    const classIdx = allClasses.indexOf(catMap[annItem.category_id]);
    newProjectAnnotations[fn].push({
      classIdx: classIdx >= 0 ? classIdx : 0,
      x: annItem.bbox[0], y: annItem.bbox[1],
      w: annItem.bbox[2], h: annItem.bbox[3],
    });
  });

  const count = Object.values(newProjectAnnotations).reduce((s, a) => s + a.length, 0);
  document.getElementById('import-status').textContent =
    `COCO: ${count} annotation(s) imported across ${Object.keys(newProjectAnnotations).length} image(s).`;
  checkNewReady();
}

// ── YOLO import ───────────────────────────────────────

export async function importYOLO() {
  const dirHandle = await window.showDirectoryPicker();

  // Try to read classes.txt from the selected directory
  let yoloClasses = [];
  try {
    const classesFile = await dirHandle.getFileHandle('classes.txt');
    const text = await (await classesFile.getFile()).text();
    yoloClasses = text.trim().split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    // No classes.txt found — ask the user
    const classInput = prompt(
      'No classes.txt found in the selected folder.\n' +
      'Enter class names in order, comma-separated (e.g. lump,crack,corrosion):'
    );
    if (!classInput) return;
    yoloClasses = classInput.split(',').map(s => s.trim()).filter(Boolean);
  }

  if (yoloClasses.length === 0) {
    alert('No classes defined. Import cancelled.');
    return;
  }

  clearDefaultClasses();

  const existing = getClassNames();
  yoloClasses.forEach(cn => { if (!existing.includes(cn)) addClassRow(cn); });

  newProjectAnnotations = {};
  let count = 0;

  // Load image dimensions
  const dimMap = {};
  for (const f of newProjectFiles) {
    const url = URL.createObjectURL(await f.handle.getFile());
    await new Promise(res => {
      const img = new Image();
      img.onload = () => {
        dimMap[f.name] = { w: img.naturalWidth, h: img.naturalHeight };
        URL.revokeObjectURL(url);
        res();
      };
      img.src = url;
    });
  }

  for await (const entry of dirHandle.values()) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.txt') || entry.name === 'classes.txt') continue;
    const baseName = entry.name.replace(/\.txt$/, '');
    const imgFile  = newProjectFiles.find(f => f.name.replace(/\.[^.]+$/, '') === baseName);
    if (!imgFile) continue;
    const dims = dimMap[imgFile.name];
    if (!dims) continue;

    const text = await (await entry.getFile()).text();
    const anns = [];
    for (const line of text.trim().split('\n')) {
      const parts = line.trim().split(/\s+/).map(Number);
      if (parts.length < 5) continue;
      const [ci, cx, cy, nw, nh] = parts;
      anns.push({
        classIdx: ci,
        x: (cx - nw / 2) * dims.w,
        y: (cy - nh / 2) * dims.h,
        w: nw * dims.w,
        h: nh * dims.h,
      });
      count++;
    }
    if (anns.length) newProjectAnnotations[imgFile.name] = anns;
  }

  const classSource = yoloClasses.length > 0 ? ` (classes: ${yoloClasses.join(', ')})` : '';
  document.getElementById('import-status').textContent =
    `YOLO: ${count} annotation(s) imported${classSource}.`;
  checkNewReady();
}

// ── Create project ────────────────────────────────────

export function createProject() {
  const classes = getClassNames();
  const images  = newProjectFiles.map(f => ({
    filename: f.name,
    boxes: (newProjectAnnotations[f.name] || []).map((a, i) => ({
      id: i + 1,
      classIdx: Math.min(a.classIdx, classes.length - 1),
      x: a.x, y: a.y, w: a.w, h: a.h,
    })),
  }));

  const project = {
    id:        'proj_' + Date.now(),
    name:      document.getElementById('new-project-name').value.trim(),
    classes,
    createdAt: new Date().toISOString(),
    images,
    nextBoxId: images.reduce((max, img) =>
      Math.max(max, ...img.boxes.map(b => b.id), 0), 0) + 1,
  };

  state.projects.push(project);
  state.current = project;
  saveProjects();

  if (newProjectDirHandle) saveDirHandle(project.id, newProjectDirHandle);
  openProject(project.id);
}

// ── Project JSON import ───────────────────────────────

export async function importNewProjectJSON() {
  try {
    const [fh] = await window.showOpenFilePicker({
      types: [{ description: 'TSIA Project JSON', accept: { 'application/json': ['.json'] } }],
    });
    const imported = JSON.parse(await (await fh.getFile()).text());
    const project = {
      ...imported,
      id: 'proj_' + Date.now(),
      createdAt: imported.createdAt || new Date().toISOString(),
    };
    if (!project.name || !project.classes || !project.images) {
      alert('Invalid project JSON: must contain name, classes, and images.');
      return;
    }
    state.projects.push(project);
    saveProjects();
    renderProjects();
    showScreen('projects');
    alert(`Project "${project.name}" imported. Open it and use "Reload Folder" to re-link the image directory.`);
  } catch (e) {
    if (e.name !== 'AbortError') alert('Import failed: ' + e.message);
  }
}

export async function importProjectJSON(id) {
  try {
    const [fh] = await window.showOpenFilePicker({
      types: [{ description: 'TSIA Project JSON', accept: { 'application/json': ['.json'] } }],
    });
    const imported = JSON.parse(await (await fh.getFile()).text());
    const idx = state.projects.findIndex(p => p.id === id);
    if (idx >= 0) {
      state.projects[idx] = { ...imported, id };
      saveProjects();
      renderProjects();
      alert('Project annotations imported successfully.');
    }
  } catch (e) {
    if (e.name !== 'AbortError') alert('Import failed: ' + e.message);
  }
}

// ── Expose for HTML onclick ───────────────────────────
window.addClassRow          = addClassRow;
window.removeClassRow       = removeClassRow;
window.checkNewReady        = checkNewReady;
window.loadNewProjectFolder = loadNewProjectFolder;
window.importCOCO           = importCOCO;
window.importYOLO           = importYOLO;
window.createProject        = createProject;
window.importNewProjectJSON = importNewProjectJSON;
window.importProjectJSON    = importProjectJSON;
