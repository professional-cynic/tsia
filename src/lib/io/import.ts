import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

export interface ImportedAnnotation {
  classIdx: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImportedDataset {
  classes: string[];
  annotations: Record<string, ImportedAnnotation[]>;
  name?: string;
  needsClasses?: boolean;
}

export async function scanImageFolder(dir: string): Promise<string[]> {
  return await invoke<string[]>('scan_image_folder', { dir });
}

export async function importCOCO(): Promise<ImportedDataset | null> {
  const path = await open({
    title: 'Import COCO JSON',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!path) return null;
  return await invoke<ImportedDataset>('import_coco', { path: path as string });
}

export async function importYOLO(
  imageFilenames: string[],
  fallbackClasses?: string[],
): Promise<ImportedDataset | null> {
  const labelsDir = await open({ title: 'Select YOLO labels folder', directory: true });
  if (!labelsDir) return null;
  return await invoke<ImportedDataset>('import_yolo', {
    labelsDir: labelsDir as string,
    imageFilenames,
    fallbackClasses: fallbackClasses ?? null,
  });
}
