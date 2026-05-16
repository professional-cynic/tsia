import {
  readTextFile, writeTextFile, exists, mkdir, readDir, remove,
  BaseDirectory,
} from '@tauri-apps/plugin-fs';
import type { Project, ImageEntry, Box, AnnotationFilter, ReviewFilter } from '$lib/types';

const DIR = 'projects';

async function ensureDir() {
  const dirExists = await exists(DIR, { baseDir: BaseDirectory.AppData });
  if (!dirExists) {
    await mkdir(DIR, { baseDir: BaseDirectory.AppData, recursive: true });
  }
}

function projectPath(id: string): string {
  return `${DIR}/${id}.json`;
}

// ── Validation ─────────────────────────────────────────────
//
// Project JSON files live on the user's filesystem and could in principle be
// edited, corrupted, or replaced. We don't pretend this is a hardened sandbox —
// if an attacker can write to AppData, you've already lost — but we also don't
// blindly trust whatever JSON.parse hands back. Required fields are checked
// strictly; optional fields are sanitised; individual broken entries are
// dropped rather than tossing the whole project.

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStr(v: unknown): v is string { return typeof v === 'string'; }
function isNum(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }
function isBool(v: unknown): v is boolean { return typeof v === 'boolean'; }

function parseBox(v: unknown): Box | null {
  if (!isObject(v)) return null;
  const { id, classIdx, x, y, w, h } = v;
  if (!isNum(id) || !isNum(classIdx) || !isNum(x) || !isNum(y) || !isNum(w) || !isNum(h)) return null;
  if (classIdx < 0 || w < 0 || h < 0) return null;
  return { id, classIdx, x, y, w, h };
}

function parseImage(v: unknown): ImageEntry | null {
  if (!isObject(v)) return null;
  const { filename, boxes, reviewed, dims } = v;
  if (!isStr(filename) || !Array.isArray(boxes)) return null;
  // Filename must be a plain relative path. Reject anything that tries to
  // escape (absolute paths, parent dir refs). Image dirs are user-picked, so
  // legitimate filenames never start with / or ..
  if (filename.startsWith('/') || filename.startsWith('\\') || filename.includes('..')) return null;
  const cleanBoxes: Box[] = [];
  for (const b of boxes) {
    const box = parseBox(b);
    if (box) cleanBoxes.push(box);
  }
  const out: ImageEntry = { filename, boxes: cleanBoxes };
  if (isBool(reviewed)) out.reviewed = reviewed;
  if (isObject(dims) && isNum(dims.w) && isNum(dims.h) && dims.w > 0 && dims.h > 0) {
    out.dims = { w: dims.w, h: dims.h };
  }
  return out;
}

const ANN_FILTERS: AnnotationFilter[] = ['all', 'annotated', 'unannotated'];
const REV_FILTERS: ReviewFilter[] = ['all', 'reviewed', 'unreviewed'];

function parseProject(v: unknown): Project | null {
  if (!isObject(v)) return null;
  const { id, name, classes, images, imageDirPath, nextBoxId, createdAt,
    filterAnnotation, filterReview, filterClass } = v;
  if (!isStr(id) || !isStr(name) || !isStr(imageDirPath) || !isStr(createdAt)) return null;
  if (!isNum(nextBoxId) || !Array.isArray(classes) || !Array.isArray(images)) return null;
  // Sanity on id: AppData files are loaded by name, but we also use id inside
  // the JSON for renames. Reject anything with control characters or path
  // separators — those couldn't exist on disk anyway.
  if (/[\\/\x00-\x1f]/.test(id)) return null;
  const cleanClasses: string[] = [];
  for (const c of classes) if (isStr(c)) cleanClasses.push(c);
  if (cleanClasses.length === 0) return null;
  const cleanImages: ImageEntry[] = [];
  for (const im of images) {
    const img = parseImage(im);
    if (img) cleanImages.push(img);
  }
  const project: Project = {
    id, name, classes: cleanClasses,
    images: cleanImages, imageDirPath,
    nextBoxId, createdAt,
  };
  if (isStr(filterAnnotation) && (ANN_FILTERS as string[]).includes(filterAnnotation)) {
    project.filterAnnotation = filterAnnotation as AnnotationFilter;
  }
  if (isStr(filterReview) && (REV_FILTERS as string[]).includes(filterReview)) {
    project.filterReview = filterReview as ReviewFilter;
  }
  if (isStr(filterClass)) project.filterClass = filterClass;
  return project;
}

// ── API ────────────────────────────────────────────────────

export async function loadAllProjects(): Promise<Project[]> {
  await ensureDir();
  const entries = await readDir(DIR, { baseDir: BaseDirectory.AppData });
  const projects: Project[] = [];
  for (const entry of entries) {
    if (!entry.name?.endsWith('.json')) continue;
    try {
      const text = await readTextFile(`${DIR}/${entry.name}`, { baseDir: BaseDirectory.AppData });
      const parsed = JSON.parse(text);
      const project = parseProject(parsed);
      if (project) {
        projects.push(project);
      } else {
        console.warn(`Project ${entry.name} failed validation; skipping.`);
      }
    } catch (e) {
      console.warn(`Failed to load project ${entry.name}:`, e);
    }
  }
  return projects.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function saveProject(project: Project): Promise<void> {
  await ensureDir();
  await writeTextFile(projectPath(project.id), JSON.stringify(project, null, 2), {
    baseDir: BaseDirectory.AppData,
  });
}

export async function deleteProjectFile(id: string): Promise<void> {
  const path = projectPath(id);
  if (await exists(path, { baseDir: BaseDirectory.AppData })) {
    await remove(path, { baseDir: BaseDirectory.AppData });
  }
}
