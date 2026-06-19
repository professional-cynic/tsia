import { invoke, Channel } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { Project } from '$lib/types';

export type MergeProgressEvent =
  | { kind: 'start'; data: { total: number; outPath: string } }
  | { kind: 'item'; data: { current: number; filename: string } }
  | { kind: 'warning'; data: { filename: string; message: string } }
  | { kind: 'done'; data: { outPath: string } }
  | { kind: 'cancelled' }
  | { kind: 'failed'; data: { message: string } };

// A reconciliation plan for N projects. classMaps[k][sourceClassIdx] = merged
// class index, for the k-th project (same order as the projects array passed
// to mergeProjects).
export interface MergePlan {
  mergedClasses: string[];
  classMaps: number[][];
  projectName: string;
  projectId: string;
}

export interface MergeOptions {
  outDir: string;
  onProgress: (e: MergeProgressEvent) => void;
}

export async function pickMergeFolder(): Promise<string | null> {
  const dirPath = await open({ title: 'Select folder for the merged project', directory: true });
  return dirPath ? (dirPath as string) : null;
}

// Filesystem-safe slug mirroring the Rust `slug()` so the frontend preview and
// the actual written names agree.
function slug(s: string): string {
  let out = Array.from(s).map(c => {
    if (/[A-Za-z0-9]/.test(c)) return c;
    if (c === '-' || c === '_') return c;
    if (/\s/.test(c)) return '_';
    return '-';
  }).join('');
  out = out.replace(/^[-_]+/, '').replace(/[-_]+$/, '');
  return out === '' ? 'project' : out;
}

// Build the flat copy-manifest for one source project: each image gets a
// source-prefixed, sanitised destination name and its boxes remapped to the
// merged class ordering. `prefix` is supplied by the caller so it can be made
// unique across all projects being merged.
function manifestFor(project: Project, classMap: number[], prefix: string) {
  return project.images.map(img => ({
    srcPath: joinPath(project.imageDirPath, img.filename),
    destFilename: `${prefix}_${img.filename}`,
    boxes: img.boxes.map(b => ({
      id: b.id,
      classIdx: classMap[b.classIdx] ?? 0,
      x: b.x, y: b.y, w: b.w, h: b.h,
    })),
    reviewed: img.reviewed ?? null,
    dims: img.dims ?? null,
  }));
}

// Sanitised, collision-free prefixes for each project. If two projects sanitise
// to the same slug, later ones get a numeric suffix so destination filenames
// stay unique across the whole merge.
function uniquePrefixes(projects: Project[]): string[] {
  const seen = new Map<string, number>();
  return projects.map(p => {
    const base = slug(p.name);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n + 1}`;
  });
}

// Simple path join that respects the separator already used by the source
// path (so we don't mix \ and / on Windows). imageDirPath is absolute native.
function joinPath(dir: string, file: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  const trimmed = dir.endsWith('/') || dir.endsWith('\\') ? dir.slice(0, -1) : dir;
  return `${trimmed}${sep}${file}`;
}

export async function mergeProjects(
  projects: Project[],
  plan: MergePlan,
  opts: MergeOptions,
): Promise<string> {
  const channel = new Channel<MergeProgressEvent>();
  channel.onmessage = opts.onProgress;

  const prefixes = uniquePrefixes(projects);
  const images = projects.flatMap((p, k) => manifestFor(p, plan.classMaps[k], prefixes[k]));

  // The command returns the new project's folder path directly (empty string
  // if cancelled), which avoids racing the Done channel event against the
  // invoke resolving.
  const outPath = await invoke<string>('merge_projects', {
    req: {
      outDir: opts.outDir,
      projectName: plan.projectName,
      projectId: plan.projectId,
      classes: plan.mergedClasses,
      createdAt: new Date().toISOString(),
      images,
    },
    onEvent: channel,
  });
  return outPath;
}

export async function cancelMerge(): Promise<void> {
  await invoke('merge_cancel');
}
