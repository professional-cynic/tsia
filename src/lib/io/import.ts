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
  /// Keyed by the image's path relative to the project folder.
  annotations: Record<string, ImportedAnnotation[]>;
  name?: string;
  needsClasses?: boolean;
  /// Annotated entries that matched no image in the folder.
  unmatched: number;
  /// Boxes that couldn't be interpreted and were dropped.
  skippedBoxes: number;
}

export async function scanImageFolder(dir: string): Promise<string[]> {
  return await invoke<string[]>('scan_image_folder', { dir });
}

/// Expand the asset protocol's runtime scope to include an image folder so
/// the canvas can load images from it via convertFileSrc. Must be called
/// once per project session before any image is rendered; the static scope
/// in tauri.conf.json is empty by design.
export async function allowAssetDir(dir: string): Promise<void> {
  await invoke('allow_asset_dir', { dir });
}

export async function importCOCO(imageFilenames: string[]): Promise<ImportedDataset | null> {
  const path = await open({
    title: 'Import COCO JSON',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!path) return null;
  return await invoke<ImportedDataset>('import_coco', { path: path as string, imageFilenames });
}

/// Pick a YOLO labels folder and import it. `labelsDir` skips the dialog
/// (used to retry with fallback classes on the folder already picked).
export async function importYOLO(
  imageDir: string,
  imageFilenames: string[],
  fallbackClasses?: string[],
  labelsDir?: string,
): Promise<{ labelsDir: string; result: ImportedDataset } | null> {
  const dir = labelsDir ?? await open({ title: 'Select YOLO labels folder', directory: true });
  if (!dir) return null;
  const result = await invoke<ImportedDataset>('import_yolo', {
    labelsDir: dir as string,
    imageDir,
    imageFilenames,
    fallbackClasses: fallbackClasses ?? null,
  });
  return { labelsDir: dir as string, result };
}
