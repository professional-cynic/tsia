import type { Project } from '$lib/types';
import { open } from '@tauri-apps/plugin-dialog';
import { writeTextFile, readTextFile, mkdir, exists, copyFile } from '@tauri-apps/plugin-fs';
import { convertFileSrc } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';

// ── Pick folder (separate from export so UI can update) ──

export async function pickExportFolder(): Promise<string | null> {
  const dirPath = await open({ title: 'Select export folder', directory: true });
  return dirPath ? (dirPath as string) : null;
}

// ── Export (called after folder is chosen and UI shows progress) ──

export async function runCOCOExport(
  project: Project,
  dirPath: string,
  trainRatio: number,
  onProgress: (current: number, total: number) => void,
  shouldCancel: () => boolean,
): Promise<void> {
  const annDir = await join(dirPath, 'annotations');
  const imgTrainDir = await join(dirPath, 'images', 'train');
  const imgValDir = await join(dirPath, 'images', 'val');
  for (const d of [annDir, imgTrainDir, imgValDir]) {
    if (!(await exists(d))) await mkdir(d, { recursive: true });
  }

  const categories = project.classes.map((name, i) => ({ id: i + 1, name, supercategory: 'object' }));
  const annotated = project.images.filter(img => img.boxes.length > 0);
  const splitIdx = Math.round(annotated.length * trainRatio);
  const total = annotated.length;
  let processed = 0;

  const trainCocoImages: any[] = [];
  const trainAnnotations: any[] = [];
  const valCocoImages: any[] = [];
  const valAnnotations: any[] = [];
  let annId = 1;

  for (let i = 0; i < annotated.length; i++) {
    if (shouldCancel()) return;

    const img = annotated[i];
    const isTrain = i < splitIdx;
    const dims = await getImageDims(project.imageDirPath, img.filename);

    if (dims) {
      const imageId = (isTrain ? trainCocoImages : valCocoImages).length + 1;
      (isTrain ? trainCocoImages : valCocoImages).push({
        id: imageId, file_name: img.filename, width: dims.w, height: dims.h,
      });

      for (const box of img.boxes) {
        (isTrain ? trainAnnotations : valAnnotations).push({
          id: annId++, image_id: imageId, category_id: box.classIdx + 1,
          bbox: [r(box.x), r(box.y), r(box.w), r(box.h)],
          area: r(box.w * box.h), segmentation: [], iscrowd: 0,
        });
      }

      const srcPath = await join(project.imageDirPath, img.filename);
      const dstDir = isTrain ? imgTrainDir : imgValDir;
      try { await copyFile(srcPath, await join(dstDir, img.filename)); } catch { /* skip */ }
    }

    processed++;
    onProgress(processed, total);
    await new Promise(r => setTimeout(r, 0));
  }

  if (shouldCancel()) return;

  const makeCoco = (images: any[], annotations: any[]) => ({
    info: { description: project.name, version: '1.0', year: new Date().getFullYear() },
    licenses: [], categories, images, annotations,
  });

  await writeTextFile(await join(annDir, 'instances_train.json'), JSON.stringify(makeCoco(trainCocoImages, trainAnnotations), null, 2));
  await writeTextFile(await join(annDir, 'instances_val.json'), JSON.stringify(makeCoco(valCocoImages, valAnnotations), null, 2));
}

// ── Import ─────────────────────────────────────────────

export async function importCOCO(): Promise<{ classes: string[]; annotations: Record<string, { classIdx: number; x: number; y: number; w: number; h: number }[]>; name?: string } | null> {
  const path = await open({ title: 'Import COCO JSON', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (!path) return null;

  const data = JSON.parse(await readTextFile(path as string));
  const classes = (data.categories || []).map((c: any) => c.name);
  const catMap: Record<number, string> = {};
  (data.categories || []).forEach((c: any) => { catMap[c.id] = c.name; });

  const imgMap: Record<number, string> = {};
  (data.images || []).forEach((img: any) => { imgMap[img.id] = img.file_name; });

  const annotations: Record<string, { classIdx: number; x: number; y: number; w: number; h: number }[]> = {};
  for (const ann of (data.annotations || [])) {
    const fn = imgMap[ann.image_id];
    if (!fn) continue;
    if (!annotations[fn]) annotations[fn] = [];
    const classIdx = classes.indexOf(catMap[ann.category_id]);
    annotations[fn].push({ classIdx: classIdx >= 0 ? classIdx : 0, x: ann.bbox[0], y: ann.bbox[1], w: ann.bbox[2], h: ann.bbox[3] });
  }

  const name = data.info?.description?.trim();
  return { classes, annotations, name };
}

// ── Helpers ────────────────────────────────────────────

function r(n: number): number { return Math.round(n * 10) / 10; }

async function getImageDims(dirPath: string, filename: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const src = convertFileSrc(`${dirPath}/${filename}`);
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
