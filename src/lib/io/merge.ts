import { invoke, Channel } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { Project } from '$lib/types';

/// Whether a set of projects can be merged given their pixel pitches.
/// Measurements are stored in pixels and interpreted through the project's
/// pitch, so mixing pitches (or mixing pitched with unpitched) would make the
/// merged measurements meaningless. `ok` carries the shared pitch (null if all
/// unset); otherwise `reason` explains the block.
export type PitchCompat =
  | { ok: true; pitch: number | null }
  | { ok: false; reason: string };

export function pitchCompatibility(projects: Project[]): PitchCompat {
  if (projects.length === 0) return { ok: true, pitch: null };
  const hasPitch = projects.filter(p => typeof p.pixelPitch === 'number');
  const noPitch = projects.filter(p => typeof p.pixelPitch !== 'number');

  if (hasPitch.length > 0 && noPitch.length > 0) {
    return {
      ok: false,
      reason: 'Some selected projects have a pixel pitch and others don\u2019t. Measurements can only be merged when every project shares the same pitch.',
    };
  }
  if (hasPitch.length === 0) return { ok: true, pitch: null }; // all unset

  // All have a pitch: they must agree within a small relative tolerance so a
  // re-serialised 0.05 vs 0.0500000001 doesn't falsely block.
  const first = hasPitch[0].pixelPitch as number;
  const tol = Math.max(1e-9, Math.abs(first) * 1e-6);
  const distinct = hasPitch.every(p => Math.abs((p.pixelPitch as number) - first) <= tol);
  if (!distinct) {
    const values = Array.from(new Set(hasPitch.map(p => p.pixelPitch))).join(', ');
    return {
      ok: false,
      reason: `Selected projects have different pixel pitches (${values}). They must match to merge measurements.`,
    };
  }
  return { ok: true, pitch: first };
}

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
  /// Shared pixel pitch of all source projects (they must match to merge), or
  /// null when none of them had one.
  pixelPitch: number | null;
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
      // Measurements are stored as pixel endpoints and are pitch-independent,
      // so they carry straight through. The merge is gated on all sources
      // sharing one pixel pitch (see pitchCompatibility), so the copied
      // endpoints remain comparable in the merged project.
      measure: b.measure ?? null,
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
      pixelPitch: plan.pixelPitch,
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
