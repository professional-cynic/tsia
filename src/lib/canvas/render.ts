import { CLASS_COLORS, HANDLE_SIZE } from '$lib/constants';
import { hexToRgba, getHandlePositions } from './geometry';
import type { ImageEntry, Measurement } from '$lib/types';
import { measureLengthPx, measureLengthMm } from '$lib/types';

interface RenderParams {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  image: HTMLImageElement;
  imageEntry: ImageEntry;
  zoom: number;
  offsetX: number;
  offsetY: number;
  selectedBox: number | null;
  // All boxes in the multi-selection (highlighted). Includes selectedBox.
  selectedBoxes?: Set<number>;
  activeClass: number;
  drawing: { x: number; y: number; w: number; h: number } | null;
  classes: string[];
  // Transient drag preview: if set, the box with this id is drawn using
  // these coordinates instead of its committed value. Lets drag update
  // visuals at 60Hz without mutating the reactive store on every
  // mousemove (which on large projects cascades through derived getters
  // and the sidebar render).
  dragOverride?: { boxId: number; x: number; y: number; w: number; h: number } | null;
  // Live group-drag delta (image-space px) applied to every box in
  // selectedBoxes. Lets a multi-box move render at 60Hz without mutating
  // the store on each mousemove.
  groupOffset?: { dx: number; dy: number } | null;
  // ── Measurement overlay ──
  // When measureMode is on, each box's stored measurement is drawn as a line
  // with its length labelled. measureDraw is the live drag; scratchMeasure is
  // an unattached reference line (drawn distinctly, never persisted).
  measureMode?: boolean;
  measureDraw?: Measurement | null;
  scratchMeasure?: Measurement | null;
  pixelPitch?: number;
}

export function renderCanvas(p: RenderParams) {
  const { canvas, ctx, image, imageEntry, zoom, offsetX, offsetY, selectedBox, selectedBoxes, activeClass, drawing, classes, dragOverride, groupOffset, measureDraw, scratchMeasure, pixelPitch } = p;
  // Size the backing buffer to the canvas's own displayed box. NOT the
  // parent wrap: the wrap also contains the toolbar strip, so wrap.clientHeight
  // overstates the drawable area and the image gets scaled into a shorter box
  // than the fit math assumed (bottom cropped). clientWidth/Height of the
  // canvas element is the true drawable area.
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;

  // Pull theme-dependent colours from CSS vars. They inherit, so reading
  // from the canvas element works and avoids a separate wrap reference.
  const styles = getComputedStyle(canvas);
  const handleFill = styles.getPropertyValue('--handle-fill').trim() || '#fff';

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const dw = image.naturalWidth * zoom;
  const dh = image.naturalHeight * zoom;
  ctx.drawImage(image, offsetX, offsetY, dw, dh);

  // Committed boxes (with optional transient drag/group overrides applied)
  for (const box of imageEntry.boxes) {
    const inSelection = box.id === selectedBox || (selectedBoxes?.has(box.id) ?? false);
    let live: { x: number; y: number; w: number; h: number } = box;
    if (dragOverride && dragOverride.boxId === box.id) {
      live = dragOverride;
    } else if (groupOffset && inSelection) {
      live = { x: box.x + groupOffset.dx, y: box.y + groupOffset.dy, w: box.w, h: box.h };
    }
    drawBox(ctx, live.x, live.y, live.w, live.h,
      CLASS_COLORS[box.classIdx] || '#fff', inSelection,
      classes[box.classIdx] || '', false, zoom, offsetX, offsetY, handleFill,
      box.id === selectedBox && !groupOffset);
  }

  // In-progress drawing
  if (drawing) {
    drawBox(ctx, drawing.x, drawing.y, drawing.w, drawing.h,
      CLASS_COLORS[activeClass] || '#fff', false, '', true, zoom, offsetX, offsetY, handleFill, false);
  }

  // ── Measurement overlay ──
  // Stored measurements are drawn whenever they exist, so you can see at a
  // glance which boxes are measured even outside measure mode.
  for (const box of imageEntry.boxes) {
    if (!box.measure) continue;
    const isSel = box.id === selectedBox;
    drawMeasurement(ctx, box.measure, zoom, offsetX, offsetY, pixelPitch, isSel, false);
  }
  // The transient scratch line and the live drag only exist in measure mode.
  if (scratchMeasure) {
    drawMeasurement(ctx, scratchMeasure, zoom, offsetX, offsetY, pixelPitch, false, true);
  }
  if (measureDraw && measureLengthPx(measureDraw) > 0) {
    drawMeasurement(ctx, measureDraw, zoom, offsetX, offsetY, pixelPitch, false, true);
  }
}

/// Draw a measurement segment with end ticks and a length label at the midpoint.
/// `transient` renders it dashed, marking a line that isn't stored.
///
/// Measurements use their own fixed colour rather than the box's class colour:
/// a measurement is a different kind of object, and some class colours are too
/// dark to read against the image.
const MEASURE_COLOR = '#ffd166';        // stored, attached to a box
const MEASURE_COLOR_TRANSIENT = '#8ecae6'; // scratch / in-progress

function drawMeasurement(
  ctx: CanvasRenderingContext2D,
  m: Measurement,
  zoom: number, offsetX: number, offsetY: number,
  pixelPitch: number | undefined,
  selected: boolean,
  transient: boolean,
) {
  const color = transient ? MEASURE_COLOR_TRANSIENT : MEASURE_COLOR;
  const ax = offsetX + m.ax * zoom, ay = offsetY + m.ay * zoom;
  const bx = offsetX + m.bx * zoom, by = offsetY + m.by * zoom;

  ctx.strokeStyle = color;
  ctx.lineWidth = selected ? 2.5 : 1.5;
  ctx.setLineDash(transient ? [6, 4] : []);
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
  ctx.setLineDash([]);

  // End ticks perpendicular to the line, so the exact endpoints are readable.
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len; // unit normal to the segment
  const tick = 5;
  ctx.beginPath();
  ctx.moveTo(ax - nx * tick, ay - ny * tick);
  ctx.lineTo(ax + nx * tick, ay + ny * tick);
  ctx.moveTo(bx - nx * tick, by - ny * tick);
  ctx.lineTo(bx + nx * tick, by + ny * tick);
  ctx.stroke();

  // Length label, offset perpendicular to the line so it never sits on top of
  // the measurement itself. Pixels lead; the physical length follows in
  // brackets when a pitch is set. Only the mm value is ever exported.
  const px = measureLengthPx(m);
  const mm = measureLengthMm(m, pixelPitch);
  const text = mm !== null
    ? `${px.toFixed(1)} px (${mm.toFixed(2)} mm)`
    : `${px.toFixed(1)} px`;
  const fontSize = Math.max(10, 11 * zoom);
  ctx.font = `bold ${fontSize}px -apple-system, sans-serif`;
  const tw = ctx.measureText(text).width;
  const th = fontSize + 4;

  // Push the chip clear of the line along the normal. Pick a consistent side
  // so the label doesn't flip depending on which way the line was dragged.
  // For near-vertical lines ny is ~0, so fall back to nx as the tie-break.
  const side = Math.abs(ny) < 1e-6 ? (nx > 0 ? 1 : -1) : (ny > 0 ? -1 : 1);
  const gap = th / 2 + 6;
  const mx = (ax + bx) / 2 + nx * side * gap;
  const my = (ay + by) / 2 + ny * side * gap;

  ctx.fillStyle = hexToRgba('#000000', 0.7);
  ctx.fillRect(mx - tw / 2 - 4, my - th / 2, tw + 8, th);
  // The chip is always dark, so the text is always light: reading a theme var
  // here gave black-on-black on dark themes.
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, mx - tw / 2, my + fontSize / 2 - 2);
}

function drawBox(
  ctx: CanvasRenderingContext2D,
  ix: number, iy: number, iw: number, ih: number,
  color: string, selected: boolean, label: string, isDraft: boolean,
  zoom: number, offsetX: number, offsetY: number,
  handleFill: string,
  showHandles: boolean,
) {
  const sx = offsetX + ix * zoom, sy = offsetY + iy * zoom;
  const sw = iw * zoom, sh = ih * zoom;

  ctx.strokeStyle = color;
  ctx.lineWidth = selected ? 2.5 : 1.5;
  ctx.setLineDash(isDraft ? [5, 3] : []);
  ctx.strokeRect(sx, sy, sw, sh);
  ctx.setLineDash([]);

  ctx.fillStyle = hexToRgba(color, selected ? 0.22 : 0.08);
  ctx.fillRect(sx, sy, sw, sh);

  // Selection marquee: a contrasting dashed outline just outside the box,
  // so selection is obvious even when the class colour is close to the
  // image or canvas background. handleFill is white on dark themes and
  // near-black on light themes, so it always contrasts.
  if (selected && !isDraft) {
    ctx.strokeStyle = handleFill;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(sx - 2, sy - 2, sw + 4, sh + 4);
    ctx.setLineDash([]);
  }

  // Class label. Drawn above the box by default; if there's no room
  // (box at the top of the image), flip it inside the top of the box
  // so it stays visible at any zoom.
  if (label && !isDraft) {
    const fontSize = Math.max(10, 11 * zoom);
    ctx.font = `bold ${fontSize}px -apple-system, sans-serif`;
    const tw = ctx.measureText(label).width;
    const th = fontSize + 4;
    const fitsAbove = sy - th >= 0;
    const labelY = fitsAbove ? sy - th : sy;
    const textY = fitsAbove ? sy - 3 : sy + fontSize - 1;
    ctx.fillStyle = color;
    ctx.fillRect(sx, labelY, tw + 6, th);
    ctx.fillStyle = '#000';
    ctx.fillText(label, sx + 3, textY);
  }

  // Dimensions
  if (showHandles || isDraft) {
    const dimText = `${Math.round(iw)}×${Math.round(ih)}`;
    const dimFont = Math.max(9, 10 * zoom);
    ctx.font = `${dimFont}px -apple-system, sans-serif`;
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
  if (showHandles) {
    for (const [hx, hy] of getHandlePositions(ix, iy, iw, ih)) {
      const shx = offsetX + hx * zoom;
      const shy = offsetY + hy * zoom;
      ctx.fillStyle = handleFill;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.fillRect(shx - HANDLE_SIZE / 2, shy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
      ctx.strokeRect(shx - HANDLE_SIZE / 2, shy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
    }
  }
}
