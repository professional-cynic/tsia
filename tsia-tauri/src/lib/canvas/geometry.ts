import { HANDLE_SIZE } from '$lib/constants';
import type { Box } from '$lib/types';

export function clientToImage(
  clientX: number, clientY: number,
  canvasEl: HTMLCanvasElement, offsetX: number, offsetY: number, zoom: number
): [number, number] {
  const rect = canvasEl.getBoundingClientRect();
  return [
    (clientX - rect.left - offsetX) / zoom,
    (clientY - rect.top - offsetY) / zoom,
  ];
}

export function clampToImage(ix: number, iy: number, imgW: number, imgH: number): [number, number] {
  return [Math.max(0, Math.min(ix, imgW)), Math.max(0, Math.min(iy, imgH))];
}

export function clampBox(box: { x: number; y: number; w: number; h: number }, imgW: number, imgH: number) {
  let { x, y, w, h } = box;
  if (x < 0) { w += x; x = 0; }
  if (y < 0) { h += y; y = 0; }
  if (x + w > imgW) w = imgW - x;
  if (y + h > imgH) h = imgH - y;
  if (w < 1) w = 1;
  if (h < 1) h = 1;
  return { x, y, w, h };
}

export function getHandlePositions(x: number, y: number, w: number, h: number): [number, number][] {
  return [
    [x, y], [x + w / 2, y], [x + w, y],
    [x, y + h / 2],                      [x + w, y + h / 2],
    [x, y + h], [x + w / 2, y + h], [x + w, y + h],
  ];
}

export function hitTestBox(ix: number, iy: number, box: Box): boolean {
  return ix >= box.x && ix <= box.x + box.w && iy >= box.y && iy <= box.y + box.h;
}

export function hitTestHandle(ix: number, iy: number, box: Box, zoom: number): number {
  const positions = getHandlePositions(box.x, box.y, box.w, box.h);
  const threshold = (HANDLE_SIZE / 2 + 2) / zoom;
  for (let i = 0; i < positions.length; i++) {
    const [hx, hy] = positions[i];
    if (Math.abs(ix - hx) <= threshold && Math.abs(iy - hy) <= threshold) return i;
  }
  return -1;
}

export function applyHandleDrag(orig: Box, handleIdx: number, dx: number, dy: number) {
  let { x, y, w, h } = orig;
  const top = [0, 1, 2], bottom = [5, 6, 7], left = [0, 3, 5], right = [2, 4, 7];
  if (left.includes(handleIdx)) { x += dx; w -= dx; }
  if (right.includes(handleIdx)) { w += dx; }
  if (top.includes(handleIdx)) { y += dy; h -= dy; }
  if (bottom.includes(handleIdx)) { h += dy; }
  if (w < 4) { if (left.includes(handleIdx)) x = orig.x + orig.w - 4; w = 4; }
  if (h < 4) { if (top.includes(handleIdx)) y = orig.y + orig.h - 4; h = 4; }
  return { x, y, w, h };
}

export function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
