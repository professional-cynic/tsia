// ══════════════════════════════════════════════════════
// ANNOTATE UI — sidebar, class list, image list, box list, filters
// ══════════════════════════════════════════════════════
import { CLASS_COLORS } from './constants.js';
import { state, ann }   from './state.js';
import { saveProjects } from './storage.js';
import { render, currentImage } from './canvas.js';
import { loadImage }    from './navigation.js';
import { deleteBox }    from './boxes.js';

// ── Class list ────────────────────────────────────────

export function setActiveClass(idx) {
  ann.activeClass = idx;
  document.querySelectorAll('.class-btn').forEach((b, i) =>
    b.classList.toggle('active', i === idx));
}

// ── Image filter ──────────────────────────────────────

/** Filter by annotation status and class only (for progress bar denominator). */
export function getBaseFilteredImages() {
  const p      = state.current;
  const annFil = document.getElementById('filter-annotation')?.value || 'all';
  const clsFil = document.getElementById('filter-class')?.value     || 'all';

  return p.images.map((img, i) => ({ img, i })).filter(({ img }) => {
    if (annFil === 'annotated'   && img.boxes.length === 0) return false;
    if (annFil === 'unannotated' && img.boxes.length  > 0) return false;
    if (clsFil !== 'all') {
      const ci = parseInt(clsFil);
      if (!img.boxes.some(b => b.classIdx === ci)) return false;
    }
    return true;
  });
}

/** Full filter including review status (for image list display). */
export function getFilteredImages() {
  const revFil = document.getElementById('filter-review')?.value || 'all';
  return getBaseFilteredImages().filter(({ img }) => {
    if (revFil === 'reviewed'   && !img.reviewed) return false;
    if (revFil === 'unreviewed' && img.reviewed)  return false;
    return true;
  });
}

export function applyImageFilter() {
  const filtered = getFilteredImages();
  const currentInFilter = filtered.some(({ i }) => i === ann.imgIndex);
  if (!currentInFilter && filtered.length > 0) {
    const nearest = filtered.reduce((best, { i }) => {
      const d = Math.abs(i - ann.imgIndex);
      return d < best.d ? { d, i } : best;
    }, { d: Infinity, i: filtered[0].i });
    loadImage(nearest.i);
    return;
  }
  renderImageList();
}

export function populateClassFilter() {
  const p  = state.current;
  const el = document.getElementById('filter-class');
  if (!el || !p) return;
  el.innerHTML = '<option value="all">All classes</option>' +
    p.classes.map((c, i) => `<option value="${i}">${c}</option>`).join('');
}

// ── Image list ────────────────────────────────────────

export function renderImageList() {
  const p        = state.current;
  const list     = document.getElementById('ann-img-list');
  const filtered = getFilteredImages();

  // Update progress bar — reviewed within annotation+class filter (ignoring review filter)
  const baseFiltered = getBaseFilteredImages();
  const reviewed  = baseFiltered.filter(({ img }) => img.reviewed === true).length;
  const baseTotal = baseFiltered.length;
  const pct       = baseTotal > 0 ? (reviewed / baseTotal * 100) : 0;
  const fill = document.getElementById('progress-fill');
  if (fill) fill.style.width = pct.toFixed(1) + '%';

  const currentInFilter = filtered.some(({ i }) => i === ann.imgIndex);

  // If filter is active but has no results, show empty message
  const hasActiveFilter = (document.getElementById('filter-annotation')?.value || 'all') !== 'all'
                       || (document.getElementById('filter-review')?.value || 'all') !== 'all'
                       || (document.getElementById('filter-class')?.value || 'all') !== 'all';

  if (filtered.length === 0 && hasActiveFilter) {
    document.getElementById('ann-img-count').textContent = '0';
    list.innerHTML = '<div style="padding:12px; font-size:11px; color:var(--text2); text-align:center;">No images match this filter.</div>';
    return;
  }

  const visible = currentInFilter
    ? filtered
    : [...filtered, { img: p.images[ann.imgIndex], i: ann.imgIndex }]
        .sort((a, b) => a.i - b.i);

  document.getElementById('ann-img-count').textContent =
    filtered.length + (currentInFilter ? '' : '*');

  const prevScroll = list.scrollTop;

  list.innerHTML = visible.map(({ img, i }) => {
    const isCurrent   = i === ann.imgIndex;
    const outOfFilter = isCurrent && !currentInFilter;
    // Dot state: true=green (reviewed), false=orange (needs re-review), undefined=grey (untouched)
    const dotClass = img.reviewed === true ? 'reviewed'
                   : img.reviewed === false ? 'needs-review'
                   : '';
    return `<div class="img-item ${isCurrent ? 'active' : ''} ${outOfFilter ? 'out-of-filter' : ''}"
                 onclick="loadImage(${i})"
                 title="${img.filename}${outOfFilter ? ' (outside current filter)' : ''}">
      <div class="ann-dot ${dotClass}"></div>
      <span class="img-name">${img.filename}</span>
      <span class="img-idx">${i + 1}</span>
    </div>`;
  }).join('');

  list.scrollTop = prevScroll;

  const active = list.querySelector('.img-item.active');
  if (active) {
    const itemTop    = active.offsetTop;
    const itemBottom = itemTop + active.offsetHeight;
    const listTop    = list.scrollTop;
    const listBottom = listTop + list.clientHeight;
    if (itemTop < listTop || itemBottom > listBottom) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }
}

// ── Box list (right panel) ────────────────────────────

export function renderBoxList() {
  const p = state.current;
  if (!p) return;
  const img = p.images[ann.imgIndex];
  document.getElementById('box-count').textContent = img.boxes.length;

  document.getElementById('box-list').innerHTML = img.boxes.map((box, i) => {
    const color = CLASS_COLORS[box.classIdx] || '#fff';
    const label = p.classes[box.classIdx] || 'unknown';
    const dims  = `${Math.round(box.w)}×${Math.round(box.h)}`;
    return `<div class="box-item ${box.id === ann.selectedBox ? 'selected' : ''}" onclick="selectBox(${box.id})">
      <div class="b-swatch" style="background:${color}"></div>
      <span class="b-label">${i + 1}. ${label}</span>
      <span class="b-dims">${dims}</span>
      <button class="b-del" onclick="event.stopPropagation(); deleteBox(${box.id})">✕</button>
    </div>`;
  }).join('');
}

export function selectBox(id) {
  ann.selectedBox = id;
  renderBoxList();
  render();
}

// ── Full annotate screen render ───────────────────────

export function renderAnnotateUI() {
  const p = state.current;
  if (!p) return;

  document.getElementById('ann-project-name').textContent = p.name;
  document.getElementById('canvas-placeholder').style.display = currentImage ? 'none' : 'block';

  populateClassFilter();

  const cl = document.getElementById('ann-class-list');
  cl.innerHTML = p.classes.map((c, i) => `
    <button class="class-btn ${i === ann.activeClass ? 'active' : ''}" onclick="setActiveClass(${i})">
      <span class="swatch" style="background:${CLASS_COLORS[i]}"></span>
      <span>${c}</span>
      <span class="shortcut">${i + 1}</span>
      ${p.classes.length > 1 ? `<span class="cls-del" onclick="event.stopPropagation(); removeProjectClass(${i})">✕</span>` : ''}
    </button>
  `).join('');

  renderImageList();
}

// ── Add class during annotation ───────────────────────

export function addProjectClass() {
  const p = state.current;
  if (!p) return;
  if (p.classes.length >= 9) { alert('Maximum 9 classes.'); return; }
  const name = prompt('New class name:');
  if (!name || !name.trim()) return;
  p.classes.push(name.trim());
  saveProjects();
  renderAnnotateUI();
  populateClassFilter();
}

export function removeProjectClass(idx) {
  const p = state.current;
  if (!p || p.classes.length <= 1) return;

  // Check if any boxes use this class
  const used = p.images.some(img => img.boxes.some(b => b.classIdx === idx));
  if (used && !confirm(`Class "${p.classes[idx]}" is used in annotations. Removing it will reassign those boxes to the first class. Continue?`)) return;

  p.classes.splice(idx, 1);

  // Remap box class indices
  p.images.forEach(img => {
    img.boxes.forEach(b => {
      if (b.classIdx === idx) b.classIdx = 0;
      else if (b.classIdx > idx) b.classIdx--;
    });
  });

  // Fix active class
  if (ann.activeClass >= p.classes.length) ann.activeClass = p.classes.length - 1;

  saveProjects();
  renderAnnotateUI();
  populateClassFilter();
  render();
}

// ── Batch operations ──────────────────────────────────

export function toggleFilteredReviewed() {
  const filtered = getFilteredImages();
  if (filtered.length === 0) return;
  // If all are reviewed, unmark them; otherwise mark all as reviewed
  const allReviewed = filtered.every(({ img }) => img.reviewed === true);
  filtered.forEach(({ img }) => { img.reviewed = allReviewed ? false : true; });
  saveProjects();
  renderImageList();
}

// ── Expose for HTML onclick handlers ──────────────────
window.setActiveClass         = setActiveClass;
window.applyImageFilter       = applyImageFilter;
window.selectBox              = selectBox;
window.deleteBox              = deleteBox;
window.addProjectClass        = addProjectClass;
window.removeProjectClass     = removeProjectClass;
window.toggleFilteredReviewed = toggleFilteredReviewed;
