import { invoke, Channel } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { Project } from '$lib/types';
import { measureLengthMm } from '$lib/types';
import type { ProgressEvent } from './progress';

export type { ProgressEvent };
export type Format = 'coco' | 'yolo';
export type LinkMode = 'copy' | 'link';

export interface ExportOptions {
  format: Format;
  linkMode: LinkMode;
  trainRatio: number;     // 0..1
  negRatio: number;       // target negative fraction 0..1, or -1 for "include all"
  outDir: string;
  onProgress: (e: ProgressEvent) => void;
}

export async function pickExportFolder(): Promise<string | null> {
  const dirPath = await open({ title: 'Select export folder', directory: true });
  return dirPath ? (dirPath as string) : null;
}

export async function exportDataset(project: Project, opts: ExportOptions): Promise<void> {
  const channel = new Channel<ProgressEvent>();
  channel.onmessage = opts.onProgress;

  await invoke('export_dataset', {
    req: {
      format: opts.format,
      linkMode: opts.linkMode,
      outDir: opts.outDir,
      imageDir: project.imageDirPath,
      projectName: project.name,
      projectId: project.id,
      classes: project.classes,
      trainRatio: opts.trainRatio,
      negRatio: opts.negRatio,
      images: project.images.map(img => ({
        filename: img.filename,
        boxes: img.boxes.map(b => ({
          classIdx: b.classIdx, x: b.x, y: b.y, w: b.w, h: b.h,
          // Physical width in millimetres, derived from the project's pixel
          // pitch. Null when the box is unmeasured or no pitch is set: a raw
          // pixel length has no physical meaning to a consumer, so we omit it
          // rather than export a unitless number.
          measurementMm: b.measure ? measureLengthMm(b.measure, project.pixelPitch) : null,
        })),
      })),
    },
    onEvent: channel,
  });
}

export async function cancelExport(): Promise<void> {
  await invoke('export_cancel');
}

/// How many images with boxes (pos) and without (neg) an export would keep
/// for a target negative percentage (< 0 = include everything). Computed by
/// the same Rust code the export uses, so the preview can't drift from it.
export async function planNegatives(
  positives: number, negatives: number, targetPct: number,
): Promise<{ pos: number; neg: number }> {
  return await invoke('plan_negatives', {
    positives, negatives,
    target: targetPct < 0 ? -1 : targetPct / 100,
  });
}
