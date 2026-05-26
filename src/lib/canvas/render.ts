import { CLASS_COLORS, HANDLE_SIZE } from '$lib/constants';
import { hexToRgba, getHandlePositions } from './geometry';
import type { ImageEntry } from '$lib/types';

interface RenderParams {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  image: HTMLImageElement;
  imageEntry: ImageEntry;
  zoom: number;
  offsetX: number;
  offsetY: number;
  selectedBox: number | null;
  activeClass: number;
  drawing: { x: number; y: number; w: number; h: number } | null;
  classes: string[];
  // Transient drag preview: if set, the box with this id is drawn using
  // these coordinates instead of its committed value. Lets drag update
  // visuals at 60Hz without mutating the reactive store on every
  // mousemove (which on large projects cascades through derived getters
  // and the sidebar render).
  dragOverride?: { boxId: number; x: number; y: number; w: number; h: number } | null;
}

export function renderCanvas(p: RenderParams) {
  const { canvas, ctx, image, imageEntry, zoom, offsetX, offsetY, selectedBox, activeClass, drawing, classes, dragOverride } = p;
  const wrap = canvas.parentElement!;
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight;

  // Pull theme-dependent colours from CSS vars on the canvas's parent.
  // Cheap once per render; lets the @media (prefers-color-scheme) switch
  // drive canvas rendering too without a JS theme observer.
  const styles = getComputedStyle(wrap);
  const handleFill = styles.getPropertyValue('--handle-fill').trim() || '#fff';

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const dw = image.naturalWidth * zoom;
  const dh = image.naturalHeight * zoom;
  ctx.drawImage(image, offsetX, offsetY, dw, dh);

  // Committed boxes (with optional transient drag override applied)
  for (const box of imageEntry.boxes) {
    const live = dragOverride && dragOverride.boxId === box.id ? dragOverride : box;
    drawBox(ctx, live.x, live.y, live.w, live.h,
      CLASS_COLORS[box.classIdx] || '#fff', box.id === selectedBox,
      classes[box.classIdx] || '', false, zoom, offsetX, offsetY, handleFill);
  }

  // In-progress drawing
  if (drawing) {
    drawBox(ctx, drawing.x, drawing.y, drawing.w, drawing.h,
      CLASS_COLORS[activeClass] || '#fff', false, '', true, zoom, offsetX, offsetY, handleFill);
  }
}

function drawBox(
  ctx: CanvasRenderingContext2D,
  ix: number, iy: number, iw: number, ih: number,
  color: string, selected: boolean, label: string, isDraft: boolean,
  zoom: number, offsetX: number, offsetY: number,
  handleFill: string,
) {
  const sx = offsetX + ix * zoom, sy = offsetY + iy * zoom;
  const sw = iw * zoom, sh = ih * zoom;

  ctx.strokeStyle = color;
  ctx.lineWidth = selected ? 2.5 : 1.5;
  ctx.setLineDash(isDraft ? [5, 3] : []);
  ctx.strokeRect(sx, sy, sw, sh);
  ctx.setLineDash([]);

  ctx.fillStyle = hexToRgba(color, selected ? 0.18 : 0.08);
  ctx.fillRect(sx, sy, sw, sh);

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
  if (selected || isDraft) {
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
  if (selected) {
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
