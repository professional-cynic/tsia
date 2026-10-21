import { invoke, Channel } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { Project, ImageEntry, Box } from '$lib/types';
import type { ProgressEvent } from './progress';

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

export type MergeProgressEvent = ProgressEvent;

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

// Filesystem-safe slug mirroring `slug()` in src-tauri/src/util.rs.
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

/// Build the merged project and the list of files to copy into it. Each image
/// gets a source-prefixed destination name and its boxes remapped to the
/// merged class ordering. The project is complete except for imageDirPath,
/// which Rust fills in once the folder exists.
function buildMerge(projects: Project[], plan: MergePlan) {
  const prefixes = uniquePrefixes(projects);
  const copies: { srcPath: string; destFilename: string }[] = [];
  const images: ImageEntry[] = [];
  let maxId = 0;

  projects.forEach((p, k) => {
    const classMap = plan.classMaps[k];
    for (const img of p.images) {
      const destFilename = `${prefixes[k]}_${img.filename}`;
      copies.push({ srcPath: joinPath(p.imageDirPath, img.filename), destFilename });
      const entry: ImageEntry = {
        filename: destFilename,
        boxes: img.boxes.map(b => {
          maxId = Math.max(maxId, b.id);
          const box: Box = {
            id: b.id,
            classIdx: classMap[b.classIdx] ?? 0,
            x: b.x, y: b.y, w: b.w, h: b.h,
          };
          // Measurements are stored as pixel endpoints and are
          // pitch-independent, so they carry straight through. The merge is
          // gated on all sources sharing one pixel pitch (see
          // pitchCompatibility), so the copied endpoints stay comparable.
          if (b.measure) box.measure = { ...b.measure };
          return box;
        }),
      };
      if (img.reviewed !== undefined) entry.reviewed = img.reviewed;
      if (img.dims) entry.dims = { ...img.dims };
      images.push(entry);
    }
  });

  const project: Omit<Project, 'imageDirPath'> = {
    id: plan.projectId,
    name: plan.projectName,
    classes: plan.mergedClasses,
    images,
    nextBoxId: maxId + 1,
    createdAt: new Date().toISOString(),
  };
  if (plan.pixelPitch !== null) project.pixelPitch = plan.pixelPitch;
  return { project, copies };
}

export async function mergeProjects(
  projects: Project[],
  plan: MergePlan,
  opts: MergeOptions,
): Promise<string> {
  const channel = new Channel<MergeProgressEvent>();
  channel.onmessage = opts.onProgress;

  const { project, copies } = buildMerge(projects, plan);

  // The command returns the new project's folder path directly (empty string
  // if cancelled), which avoids racing the Done channel event against the
  // invoke resolving.
  return await invoke<string>('merge_projects', {
    req: { outDir: opts.outDir, project, copies },
    onEvent: channel,
  });
}

export async function cancelMerge(): Promise<void> {
  await invoke('merge_cancel');
}
