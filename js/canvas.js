// ══════════════════════════════════════════════════════
// CANVAS — rendering, coordinate maths, hit testing
// ══════════════════════════════════════════════════════
import { CLASS_COLORS, HANDLE_SIZE } from './constants.js';
import { state, ann } from './state.js';
import { hexToRgba }  from './utils.js';

export const canvas = document.getElementById('ann-canvas');
export const ctx    = canvas.getContext('2d');
export let currentImage = null;

export function setCurrentImage(img) { currentImage = img; }

// ── Coordinate conversion ─────────────────────────────

export function clientToImage(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return [
    (clientX - rect.left - ann.offsetX) / ann.zoom,
    (clientY - rect.top  - ann.offsetY) / ann.zoom,
  ];
}

export function clampToImage(ix, iy) {
  if (!currentImage) return [ix, iy];
  return [
    Math.max(0, Math.min(ix, currentImage.naturalWidth)),
    Math.max(0, Math.min(iy, currentImage.naturalHeight)),
  ];
}

export function clampBox(box) {
  if (!currentImage) return box;
  const iw = currentImage.naturalWidth;
  const ih = currentImage.naturalHeight;
  let { x, y, w, h } = box;
  if (x < 0) { w += x; x = 0; }
  if (y < 0) { h += y; y = 0; }
  if (x + w > iw) w = iw - x;
  if (y + h > ih) h = ih - y;
  if (w < 1) w = 1;
  if (h < 1) h = 1;
  return { x, y, w, h };
}

// ── Hit testing ───────────────────────────────────────

export function getHandlePositions(x, y, w, h) {
  return [
    [x,     y    ], [x+w/2, y    ], [x+w,   y    ],
    [x,     y+h/2],                  [x+w,   y+h/2],
    [x,     y+h  ], [x+w/2, y+h  ], [x+w,   y+h  ],
  ];
}

export function hitTestBox(ix, iy, box) {
  return ix >= box.x && ix <= box.x + box.w &&
         iy >= box.y && iy <= box.y + box.h;
}

export function hitTestHandle(ix, iy, box) {
  const positions = getHandlePositions(box.x, box.y, box.w, box.h);
  const threshold = (HANDLE_SIZE / 2 + 2) / ann.zoom;
  for (let i = 0; i < positions.length; i++) {
    const [hx, hy] = positions[i];
    if (Math.abs(ix - hx) <= threshold && Math.abs(iy - hy) <= threshold) return i;
  }
  return -1;
}

export function applyHandleDrag(orig, handleIdx, dx, dy) {
  let { x, y, w, h } = orig;
  const top    = [0, 1, 2];
  const bottom = [5, 6, 7];
  const left   = [0, 3, 5];
  const right  = [2, 4, 7];

  if (left.includes(handleIdx))   { x += dx; w -= dx; }
  if (right.includes(handleIdx))  { w += dx; }
  if (top.includes(handleIdx))    { y += dy; h -= dy; }
  if (bottom.includes(handleIdx)) { h += dy; }

  if (w < 4) { if (left.includes(handleIdx)) x = orig.x + orig.w - 4; w = 4; }
  if (h < 4) { if (top.includes(handleIdx))  y = orig.y + orig.h - 4; h = 4; }

  return { x, y, w, h };
}

// ── Mouse position for crosshair ──────────────────────

let mousePos = null; // { x, y } in canvas coords, null when outside

export function setMousePos(pos) { mousePos = pos; }

// ── Rendering ─────────────────────────────────────────

function resizeCanvas() {
  const wrap = document.getElementById('canvas-wrap');
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
}

let _renderPending = false;

export function render() {
  if (_renderPending) return;
  _renderPending = true;
  requestAnimationFrame(_renderFrame);
}

function _renderFrame() {
  _renderPending = false;
  if (!currentImage) return;
  const p   = state.current;
  const img = p.images[ann.imgIndex];

  resizeCanvas();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const ox = ann.offsetX, oy = ann.offsetY;
  const z  = ann.zoom;
  const dw = currentImage.naturalWidth  * z;
  const dh = currentImage.naturalHeight * z;

  ctx.drawImage(currentImage, ox, oy, dw, dh);

  // Committed boxes
  img.boxes.forEach(box => {
    const isSelected = box.id === ann.selectedBox;
    drawBox(box.x, box.y, box.w, box.h,
            CLASS_COLORS[box.classIdx] || '#fff', isSelected,
            p.classes[box.classIdx] || '');
  });

  // In-progress drawing
  if (ann.drawing) {
    const d = ann.drawing;
    drawBox(d.x, d.y, d.w, d.h,
            CLASS_COLORS[ann.activeClass] || '#fff', false, '', true);
  }

  // Crosshair
  if (mousePos && ann.showCrosshair) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([4, 4]);
    // Vertical line
    ctx.beginPath();
    ctx.moveTo(mousePos.x, 0);
    ctx.lineTo(mousePos.x, canvas.height);
    ctx.stroke();
    // Horizontal line
    ctx.beginPath();
    ctx.moveTo(0, mousePos.y);
    ctx.lineTo(canvas.width, mousePos.y);
    ctx.stroke();
    ctx.restore();
  }
}

function drawBox(ix, iy, iw, ih, color, selected, label, drawing = false) {
  const z  = ann.zoom;
  const ox = ann.offsetX, oy = ann.offsetY;
  const sx = ox + ix * z, sy = oy + iy * z;
  const sw = iw * z,      sh = ih * z;

  // Outline
  ctx.strokeStyle = color;
  ctx.lineWidth   = selected ? 2.5 : 1.5;
  ctx.setLineDash(drawing ? [5, 3] : []);
  ctx.strokeRect(sx, sy, sw, sh);
  ctx.setLineDash([]);

  // Semi-transparent fill
  ctx.fillStyle = hexToRgba(color, selected ? 0.18 : 0.08);
  ctx.fillRect(sx, sy, sw, sh);

  // Class label
  if (label && !drawing) {
    ctx.font = `bold ${Math.max(10, 11 * z)}px JetBrains Mono, monospace`;
    const tw = ctx.measureText(label).width;
    const th = Math.max(10, 11 * z) + 4;
    ctx.fillStyle = color;
    ctx.fillRect(sx, sy - th, tw + 6, th);
    ctx.fillStyle = '#000';
    ctx.fillText(label, sx + 3, sy - 3);
  }

  // Dimensions label
  if (selected || drawing) {
    const dimText = `${Math.round(iw)}×${Math.round(ih)}`;
    const dimFont = Math.max(9, 10 * z);
    ctx.font = `${dimFont}px JetBrains Mono, monospace`;
    const dtw = ctx.measureText(dimText).width;
    const dth = dimFont + 3;
    const dx = sx + sw - dtw - 4;
    const dy = sy + sh + dth + 1;
    ctx.fillStyle = hexToRgba('#000000', 0.6);
    ctx.fillRect(dx - 2, dy - dth + 1, dtw + 4, dth);
    ctx.fillStyle = color;
    ctx.fillText(dimText, dx, dy - 2);
  }

  // Resize handles
  if (selected) {
    getHandlePositions(ix, iy, iw, ih).forEach(([hx, hy]) => {
      const shx = ann.offsetX + hx * z;
      const shy = ann.offsetY + hy * z;
      ctx.fillStyle   = '#fff';
      ctx.strokeStyle = color;
      ctx.lineWidth   = 1.5;
      ctx.fillRect(shx - HANDLE_SIZE / 2, shy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
      ctx.strokeRect(shx - HANDLE_SIZE / 2, shy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
    });
  }
}

// ── Zoom helpers ──────────────────────────────────────

export function fitToView() {
  if (!currentImage) return;
  const wrap = document.getElementById('canvas-wrap');
  const ww = wrap.clientWidth;
  const wh = wrap.clientHeight;
  const scale = Math.min(ww / currentImage.naturalWidth, wh / currentImage.naturalHeight);
  ann.zoom = scale;
  ann.offsetX = (ww - currentImage.naturalWidth  * scale) / 2;
  ann.offsetY = (wh - currentImage.naturalHeight * scale) / 2;
  updateZoomLabel();
}

export function resetZoom() {
  fitToView();
  render();
}

export function updateZoomLabel() {
  document.getElementById('ann-zoom-label').textContent = Math.round(ann.zoom * 100) + '%';
}

// Expose for HTML onclick
window.resetZoom = resetZoom;
