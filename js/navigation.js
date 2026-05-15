// ══════════════════════════════════════════════════════
// NAVIGATION — image loading, prev/next, back/forward history
// ══════════════════════════════════════════════════════
import { MAX_NAV }      from './constants.js';
import { state, ann }   from './state.js';
import { saveProjects } from './storage.js';
import { canvas, ctx, setCurrentImage, fitToView, render }
  from './canvas.js';
import { getFilteredImages, renderImageList, renderBoxList } from './annotate-ui.js';

// ── Load a single image ───────────────────────────────

export async function loadImage(idx, pushHistory = true) {
  const p = state.current;
  if (!p || idx < 0 || idx >= p.images.length) return;

  if (pushHistory && ann.imgIndex !== idx && ann.imgIndex >= 0) {
    ann.navBack.push(ann.imgIndex);
    if (ann.navBack.length > MAX_NAV) ann.navBack.shift();
    ann.navForward = [];
  }

  ann.imgIndex    = idx;
  ann.selectedBox = null;
  ann.drawing     = null;
  ann.drag        = null;

  const img = p.images[idx];

  // Auto-mark as reviewed when first seen (undefined = never visited)
  // Don't override explicit unmark (reviewed === false means user pressed X)
  if (img.reviewed === undefined) {
    img.reviewed = true;
    saveProjects();
  }

  document.getElementById('ann-img-label').textContent =
    `${idx + 1} / ${p.images.length}  —  ${img.filename}`;
  document.getElementById('btn-prev-img').disabled = idx === 0;
  document.getElementById('btn-next-img').disabled = idx === p.images.length - 1;

  renderImageList();
  renderBoxList();

  const handle = state.fileHandles[img.filename];
  if (!handle) {
    setCurrentImage(null);
    document.getElementById('canvas-placeholder').style.display = 'flex';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  document.getElementById('canvas-placeholder').style.display = 'none';

  const file = await handle.getFile();
  const url  = URL.createObjectURL(file);
  await new Promise((res, rej) => {
    const i = new Image();
    i.onload  = () => { setCurrentImage(i); URL.revokeObjectURL(url); res(); };
    i.onerror = () => { URL.revokeObjectURL(url); rej(); };
    i.src = url;
  });

  fitToView();
  render();
}

// ── Arrow-key navigation with back/forward stacks ─────

export function navigateImage(delta) {
  const p = state.current;
  if (!p) return;
  const filtered = getFilteredImages();
  if (filtered.length === 0) return;

  const pos = filtered.findIndex(({ i }) => i === ann.imgIndex);

  if (delta < 0) {
    // Backward: pop from back stack if available
    if (ann.navBack.length > 0) {
      const prevIdx = ann.navBack.pop();
      ann.navForward.push(ann.imgIndex);
      if (ann.navForward.length > MAX_NAV) ann.navForward.shift();
      loadImage(prevIdx, false);
      return;
    }
    // No history — filtered navigation
    if (pos === -1) {
      for (let j = filtered.length - 1; j >= 0; j--) {
        if (filtered[j].i < ann.imgIndex) {
          ann.navBack.push(ann.imgIndex);
          ann.navForward = [];
          loadImage(filtered[j].i, false);
          return;
        }
      }
      return;
    }
    if (pos - 1 < 0) return;
    ann.navBack.push(ann.imgIndex);
    ann.navForward = [];
    loadImage(filtered[pos - 1].i, false);
  } else {
    // Forward: pop from forward stack if available
    if (ann.navForward.length > 0) {
      const nextIdx = ann.navForward.pop();
      ann.navBack.push(ann.imgIndex);
      if (ann.navBack.length > MAX_NAV) ann.navBack.shift();
      loadImage(nextIdx, false);
      return;
    }
    // No forward history — filtered navigation
    let nextPos;
    if (pos === -1) {
      nextPos = filtered.findIndex(({ i }) => i > ann.imgIndex);
      if (nextPos === -1) return;
    } else {
      nextPos = pos + 1;
      if (nextPos >= filtered.length) return;
    }
    ann.navBack.push(ann.imgIndex);
    loadImage(filtered[nextPos].i, false);
  }
}

// Expose for HTML onclick
window.loadImage      = loadImage;
window.navigateImage  = navigateImage;
