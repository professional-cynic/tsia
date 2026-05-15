// ══════════════════════════════════════════════════════
// INTERACTION — mouse events, keyboard shortcuts, zoom, pan
// ══════════════════════════════════════════════════════
import { MAX_UNDO }      from './constants.js';
import { state, ann }    from './state.js';
import { saveProjects }  from './storage.js';
import {
  canvas, render, currentImage,
  clientToImage, clampToImage, clampBox,
  hitTestBox, hitTestHandle, applyHandleDrag,
  updateZoomLabel, setMousePos,
} from './canvas.js';
import { renderBoxList, renderImageList, setActiveClass } from './annotate-ui.js';
import { navigateImage } from './navigation.js';
import { pushUndo, undoAnnotation, deleteBox, deleteLastBox,
         reassignBoxClass, copyBoxesFromPrevious, unmarkReviewed } from './boxes.js';

let panStart = null;

// ── Mouse down ────────────────────────────────────────

canvas.addEventListener('mousedown', e => {
  if (e.button === 1) {
    panStart = { x: e.clientX, y: e.clientY, ox: ann.offsetX, oy: ann.offsetY };
    e.preventDefault();
    return;
  }
  if (e.button !== 0) return;
  e.preventDefault();

  const p = state.current;
  if (!p || !currentImage) return;
  const img = p.images[ann.imgIndex];
  const [ix, iy] = clientToImage(e.clientX, e.clientY);

  // Handle hit (resize)
  if (ann.selectedBox !== null) {
    const selBox = img.boxes.find(b => b.id === ann.selectedBox);
    if (selBox) {
      const hi = hitTestHandle(ix, iy, selBox);
      if (hi >= 0) {
        ann.drag = {
          type: 'handle', handleIdx: hi, boxId: selBox.id,
          startImgX: ix, startImgY: iy,
          origBox: { ...selBox },
          undoSnapshot: JSON.stringify(img.boxes),
        };
        return;
      }
    }
  }

  // Box hit (move)
  for (let i = img.boxes.length - 1; i >= 0; i--) {
    const box = img.boxes[i];
    if (hitTestBox(ix, iy, box)) {
      ann.selectedBox = box.id;
      ann.drag = {
        type: 'move', boxId: box.id,
        startImgX: ix, startImgY: iy,
        origBox: { ...box },
        undoSnapshot: JSON.stringify(img.boxes),
      };
      renderBoxList();
      render();
      return;
    }
  }

  // Start drawing
  ann.selectedBox = null;
  const [cx, cy] = clampToImage(ix, iy);
  ann.drawing = { startX: cx, startY: cy, x: cx, y: cy, w: 0, h: 0 };
  renderBoxList();
  render();
});

// ── Mouse move ────────────────────────────────────────

canvas.addEventListener('mousemove', e => {
  // Track mouse position for crosshair
  if (ann.showCrosshair) {
    const rect = canvas.getBoundingClientRect();
    setMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  }

  if (panStart) {
    ann.offsetX = panStart.ox + (e.clientX - panStart.x);
    ann.offsetY = panStart.oy + (e.clientY - panStart.y);
    render();
    return;
  }
  if (!currentImage) return;
  const [ix, iy] = clientToImage(e.clientX, e.clientY);

  if (ann.drag) {
    const p   = state.current;
    const img = p.images[ann.imgIndex];
    const box = img.boxes.find(b => b.id === ann.drag.boxId);
    if (!box) return;

    const dx = ix - ann.drag.startImgX;
    const dy = iy - ann.drag.startImgY;

    if (ann.drag.type === 'move') {
      const moved = clampBox({
        x: ann.drag.origBox.x + dx,
        y: ann.drag.origBox.y + dy,
        w: ann.drag.origBox.w,
        h: ann.drag.origBox.h,
      });
      box.x = moved.x; box.y = moved.y; box.w = moved.w; box.h = moved.h;
    } else {
      const updated = applyHandleDrag(ann.drag.origBox, ann.drag.handleIdx, dx, dy);
      Object.assign(box, clampBox(updated));
    }
    render();
    renderBoxList();
    return;
  }

  if (ann.drawing) {
    const d = ann.drawing;
    const [cx, cy] = clampToImage(ix, iy);
    d.x = Math.min(cx, d.startX);
    d.y = Math.min(cy, d.startY);
    d.w = Math.abs(cx - d.startX);
    d.h = Math.abs(cy - d.startY);
    render();
    return;
  }

  // Crosshair-only update (no drag, no drawing)
  if (ann.showCrosshair) render();
});

// Clear crosshair when mouse leaves canvas
canvas.addEventListener('mouseleave', () => {
  setMousePos(null);
  render();
});

// ── Mouse up ──────────────────────────────────────────

window.addEventListener('mouseup', e => {
  if (panStart) { panStart = null; return; }
  if (!currentImage) return;

  if (ann.drag) {
    const p   = state.current;
    const img = p.images[ann.imgIndex];
    const box = img.boxes.find(b => b.id === ann.drag.boxId);
    if (box && ann.drag.undoSnapshot) {
      const orig = ann.drag.origBox;
      const changed = box.x !== orig.x || box.y !== orig.y ||
                      box.w !== orig.w || box.h !== orig.h;
      if (changed) {
        const key = img.filename;
        if (!ann.undoStack[key]) ann.undoStack[key] = [];
        ann.undoStack[key].push(ann.drag.undoSnapshot);
        if (ann.undoStack[key].length > MAX_UNDO) ann.undoStack[key].shift();
      }
    }
    ann.drag = null;
    saveProjects();
    return;
  }

  if (ann.drawing) {
    const d = ann.drawing;
    ann.drawing = null;
    if (d.w > 4 && d.h > 4) {
      pushUndo();
      const p   = state.current;
      const img = p.images[ann.imgIndex];
      const box = {
        id: ann.nextBoxId++, classIdx: ann.activeClass,
        x: d.x, y: d.y, w: d.w, h: d.h,
      };
      p.nextBoxId = ann.nextBoxId;
      img.boxes.push(box);
      ann.selectedBox = box.id;
      saveProjects();
      renderBoxList();
      renderImageList();
    }
    render();
  }
});

// ── Scroll to zoom ────────────────────────────────────

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const rect   = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  const imgX = (mouseX - ann.offsetX) / ann.zoom;
  const imgY = (mouseY - ann.offsetY) / ann.zoom;

  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  ann.zoom = Math.max(0.05, Math.min(20, ann.zoom * factor));

  ann.offsetX = mouseX - imgX * ann.zoom;
  ann.offsetY = mouseY - imgY * ann.zoom;

  updateZoomLabel();
  render();
}, { passive: false });

// ── Window resize ─────────────────────────────────────

window.addEventListener('resize', () => { if (currentImage) render(); });

// ── Keyboard shortcuts ────────────────────────────────

document.addEventListener('keydown', e => {
  const inAnnotate = document.getElementById('screen-annotate').classList.contains('active');
  if (!inAnnotate) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  // Ctrl/Cmd shortcuts
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'z') { e.preventDefault(); undoAnnotation(); return; }
    return; // don't intercept other Ctrl combos
  }

  // Number keys 1-9: reassign selected box class, or switch active class if no box selected
  const num = parseInt(e.key);
  if (!isNaN(num) && num >= 1 && num <= 9) {
    e.preventDefault();
    const p = state.current;
    if (!p || num - 1 >= p.classes.length) return;
    if (ann.selectedBox !== null) {
      reassignBoxClass(num - 1);
    } else {
      setActiveClass(num - 1);
    }
    return;
  }

  switch (e.key) {
    // Navigation
    case 'a': case 'A': case 'ArrowLeft':
      e.preventDefault(); navigateImage(-1); break;
    case 'd': case 'D': case 'ArrowRight':
      e.preventDefault(); navigateImage(1);  break;

    // Copy boxes from previous image
    case 'c': case 'C':
      e.preventDefault(); copyBoxesFromPrevious(); break;

    // Mark as unreviewed (needs another look)
    case 'x': case 'X':
      e.preventDefault(); unmarkReviewed(); break;

    // Toggle crosshair
    case 'h': case 'H':
      e.preventDefault(); ann.showCrosshair = !ann.showCrosshair; render(); break;

    // Toggle help overlay
    case '?':
      e.preventDefault();
      document.getElementById('shortcuts-overlay').classList.toggle('visible');
      break;

    // Undo
    case 'z': case 'Z':
      e.preventDefault(); undoAnnotation(); break;

    // Delete
    case 'Delete':
    case 'Backspace':
      e.preventDefault();
      if (ann.selectedBox !== null) deleteBox(ann.selectedBox);
      else deleteLastBox();
      break;

    // Deselect
    case 'Escape':
      e.preventDefault();
      ann.selectedBox = null;
      ann.drawing = null;
      render();
      renderBoxList();
      break;
  }
});
