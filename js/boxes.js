// ══════════════════════════════════════════════════════
// BOXES — CRUD, selection, undo
// ══════════════════════════════════════════════════════
import { MAX_UNDO }   from './constants.js';
import { state, ann } from './state.js';
import { saveProjects } from './storage.js';
import { render }       from './canvas.js';
import { renderBoxList, renderImageList } from './annotate-ui.js';

// ── Shared post-mutation refresh ──────────────────────

function afterMutation() {
  saveProjects();
  renderBoxList();
  renderImageList();
  render();
}

// ── Undo ──────────────────────────────────────────────

export function pushUndo() {
  const p   = state.current;
  const img = p.images[ann.imgIndex];
  const key = img.filename;
  if (!ann.undoStack[key]) ann.undoStack[key] = [];
  ann.undoStack[key].push(JSON.stringify(img.boxes));
  if (ann.undoStack[key].length > MAX_UNDO) ann.undoStack[key].shift();
}

export function undoAnnotation() {
  const p = state.current;
  if (!p) return;
  const img = p.images[ann.imgIndex];
  const key = img.filename;
  if (!ann.undoStack[key] || ann.undoStack[key].length === 0) return;
  img.boxes = JSON.parse(ann.undoStack[key].pop());
  ann.selectedBox = null;
  afterMutation();
}

// ── Delete ────────────────────────────────────────────

export function deleteBox(id) {
  const p   = state.current;
  const img = p.images[ann.imgIndex];
  pushUndo();
  img.boxes = img.boxes.filter(b => b.id !== id);
  if (ann.selectedBox === id) ann.selectedBox = null;
  afterMutation();
}

export function deleteLastBox() {
  const p = state.current;
  if (!p) return;
  const img = p.images[ann.imgIndex];
  if (img.boxes.length === 0) return;
  pushUndo();
  const last = img.boxes[img.boxes.length - 1];
  img.boxes.pop();
  if (ann.selectedBox === last.id) ann.selectedBox = null;
  afterMutation();
}

// ── Copy from previous ────────────────────────────────

export function copyBoxesFromPrevious() {
  const p = state.current;
  if (!p || ann.imgIndex === 0) return;
  const prevImg = p.images[ann.imgIndex - 1];
  if (prevImg.boxes.length === 0) return;
  pushUndo();
  const img = p.images[ann.imgIndex];
  prevImg.boxes.forEach(box => {
    img.boxes.push({
      id: ann.nextBoxId++,
      classIdx: box.classIdx,
      x: box.x, y: box.y, w: box.w, h: box.h,
    });
  });
  p.nextBoxId = ann.nextBoxId;
  afterMutation();
}

// ── Reassign class ────────────────────────────────────

export function reassignBoxClass(classIdx) {
  const p = state.current;
  if (!p || ann.selectedBox === null) return false;
  const img = p.images[ann.imgIndex];
  const box = img.boxes.find(b => b.id === ann.selectedBox);
  if (!box || box.classIdx === classIdx) return false;
  pushUndo();
  box.classIdx = classIdx;
  saveProjects();
  renderBoxList();
  render();
  return true;
}

// ── Mark as unreviewed ────────────────────────────────

export function unmarkReviewed() {
  const p = state.current;
  if (!p) return;
  const img = p.images[ann.imgIndex];
  img.reviewed = false;
  saveProjects();
  renderImageList();
}

// Expose for HTML onclick
window.undoAnnotation       = undoAnnotation;
window.deleteLastBox        = deleteLastBox;
window.deleteBox            = deleteBox;
window.reassignBoxClass     = reassignBoxClass;
window.copyBoxesFromPrevious = copyBoxesFromPrevious;
window.unmarkReviewed       = unmarkReviewed;
