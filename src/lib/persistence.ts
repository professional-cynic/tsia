import {
  readTextFile, writeTextFile, exists, mkdir, readDir, remove,
  BaseDirectory,
} from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import type { Project, ImageEntry, Box, AnnotationFilter, ReviewFilter } from '$lib/types';

// The project file now lives INSIDE the image folder, so it travels with the
// dataset when you back up, move, or sync that folder. One project per folder.
const PROJECT_FILE = 'tsia-project.json';

// App-data keeps only a tiny registry: the list of image-folder paths the app
// knows about. It holds NO annotations. Kept under $APPDATA/projects because
// that subdir (and only that subdir) is in the fs scope — the AppData root
// itself is not, so a registry at the root would be a 'forbidden path'.
const REGISTRY = 'projects/registry.json';
const LEGACY_DIR = 'projects';              // old per-id files lived here
const LEGACY_BACKUP = 'projects/_backup';   // migrated originals moved here

// A folder path is safe to grant scope to / write into only if it's absolute
// and has no '..' traversal. Used for both registry entries and project-file
// imageDirPath, so neither route can drive a scope grant to a crafted path.
function isSafeAbsoluteDir(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (/[\x00-\x1f]/.test(p)) return false;
  const isAbsolute = p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
  if (!isAbsolute) return false;
  if (p.split(/[\\/]/).includes('..')) return false;
  return true;
}

// ── fs-scope: image folders must be granted at runtime ─────
// The static fs scope only covers $APPDATA. Reading/writing a project file by
// absolute path inside a user-picked image folder requires extending the fs
// plugin scope to that folder first. Safe to call repeatedly.
async function allowFolder(dir: string): Promise<void> {
  if (!isSafeAbsoluteDir(dir)) {
    console.warn(`Refusing to grant fs scope to unsafe path: ${dir}`);
    return;
  }
  try {
    await invoke('allow_fs_dir', { dir });
  } catch (e) {
    console.warn(`Could not extend fs scope to ${dir}:`, e);
  }
}

// ── Registry ───────────────────────────────────────────────

async function readRegistry(): Promise<string[]> {
  try {
    if (!(await exists(REGISTRY, { baseDir: BaseDirectory.AppData }))) return [];
    const text = await readTextFile(REGISTRY, { baseDir: BaseDirectory.AppData });
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string');
  } catch (e) {
    console.warn('Failed to read project registry:', e);
    return [];
  }
}

async function writeRegistry(folders: string[]): Promise<void> {
  // Dedupe while preserving order.
  const seen = new Set<string>();
  const unique = folders.filter(f => (seen.has(f) ? false : (seen.add(f), true)));
  await writeTextFile(REGISTRY, JSON.stringify(unique, null, 2), { baseDir: BaseDirectory.AppData });
}

async function registerFolder(dir: string): Promise<void> {
  const folders = await readRegistry();
  if (!folders.includes(dir)) {
    folders.push(dir);
    await writeRegistry(folders);
  }
}

async function unregisterFolder(dir: string): Promise<void> {
  const folders = await readRegistry();
  await writeRegistry(folders.filter(f => f !== dir));
}

// ── Validation (unchanged logic) ───────────────────────────

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
const REV_FILTERS: ReviewFilter[] = ['all', 'reviewed', 'unreviewed', 'rereview'];

function parseProject(v: unknown): Project | null {
  if (!isObject(v)) return null;
  const { id, name, classes, images, imageDirPath, nextBoxId, createdAt,
    filterAnnotation, filterReview, filterClass } = v;
  if (!isStr(id) || !isStr(name) || !isStr(imageDirPath) || !isStr(createdAt)) return null;
  if (!isNum(nextBoxId) || !Array.isArray(classes) || !Array.isArray(images)) return null;
  if (/[\\/\x00-\x1f]/.test(id)) return null;
  // imageDirPath drives fs-scope grants and the write location, so validate it
  // with the same care as filename: absolute, no '..' traversal.
  if (!isSafeAbsoluteDir(imageDirPath)) return null;
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

// ── Project file path inside the image folder ──────────────

async function projectFilePath(imageDirPath: string): Promise<string> {
  return await join(imageDirPath, PROJECT_FILE);
}

// ── Migration: old app-data projects → image folders ───────
//
// Pre-this-version, projects lived at $APPDATA/projects/<id>.json with the
// image dir referenced inside. We move each into <imageDir>/tsia-project.json,
// register the folder, and back up the original under $APPDATA/projects-backup
// (kept, not deleted). Runs once; idempotent (skips folders already migrated).

async function migrateLegacyProjects(): Promise<void> {
  let entries;
  try {
    if (!(await exists(LEGACY_DIR, { baseDir: BaseDirectory.AppData }))) return;
    entries = await readDir(LEGACY_DIR, { baseDir: BaseDirectory.AppData });
  } catch {
    return;
  }
  if (!entries.length) return;

  await mkdir(LEGACY_BACKUP, { baseDir: BaseDirectory.AppData, recursive: true }).catch(() => {});

  for (const entry of entries) {
    if (!entry.name?.endsWith('.json')) continue;
    if (entry.name === 'registry.json') continue; // our own registry, not a project
    try {
      const text = await readTextFile(`${LEGACY_DIR}/${entry.name}`, { baseDir: BaseDirectory.AppData });
      const project = parseProject(JSON.parse(text));
      if (!project) continue;

      await allowFolder(project.imageDirPath);
      const dest = await projectFilePath(project.imageDirPath);
      // Don't clobber a project file that already exists in the folder.
      const destExists = await exists(dest).catch(() => false);
      if (!destExists) {
        await writeTextFile(dest, JSON.stringify(project, null, 2));
      }
      await registerFolder(project.imageDirPath);

      // Back up the original before removing it from the live legacy dir
      // (so migration doesn't repeat). Copy-then-verify-then-remove: we write
      // the backup with writeTextFile (known to work under the projects scope,
      // unlike the two-baseDir rename which was being denied), confirm it
      // landed, and only then delete the original. If the backup can't be
      // confirmed, we KEEP the original — never delete an un-backed-up file.
      const backupRel = `${LEGACY_BACKUP}/${entry.name}`;
      let backedUp = false;
      try {
        await writeTextFile(backupRel, text, { baseDir: BaseDirectory.AppData });
        backedUp = await exists(backupRel, { baseDir: BaseDirectory.AppData }).catch(() => false);
      } catch (e) {
        console.warn(`Could not back up ${entry.name}; keeping the original in place:`, e);
      }
      if (backedUp) {
        await remove(`${LEGACY_DIR}/${entry.name}`, { baseDir: BaseDirectory.AppData }).catch(() => {});
      }
    } catch (e) {
      console.warn(`Migration of ${entry.name} failed; leaving it in place:`, e);
    }
  }
}

// ── API ────────────────────────────────────────────────────

export async function loadAllProjects(): Promise<Project[]> {
  await migrateLegacyProjects();

  const folders = await readRegistry();
  const projects: Project[] = [];
  const stillValid: string[] = [];

  for (const dir of folders) {
    try {
      await allowFolder(dir);
      const path = await projectFilePath(dir);
      if (!(await exists(path).catch(() => false))) {
        // Folder moved/deleted, or project file removed. Drop from registry.
        continue;
      }
      const text = await readTextFile(path);
      const project = parseProject(JSON.parse(text));
      if (project) {
        // The folder is the source of truth for where images are. If the
        // stored imageDirPath drifted (folder was moved), correct it.
        if (project.imageDirPath !== dir) project.imageDirPath = dir;
        projects.push(project);
        stillValid.push(dir);
      } else {
        console.warn(`Project in ${dir} failed validation; skipping.`);
        stillValid.push(dir); // keep registered; don't lose a corrupt-but-present file
      }
    } catch (e) {
      console.warn(`Failed to load project from ${dir}:`, e);
    }
  }

  // Prune folders that no longer have a project file.
  if (stillValid.length !== folders.length) {
    await writeRegistry(stillValid);
  }

  return projects.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function saveProject(project: Project): Promise<void> {
  await allowFolder(project.imageDirPath);
  const path = await projectFilePath(project.imageDirPath);
  await writeTextFile(path, JSON.stringify(project, null, 2));
  await registerFolder(project.imageDirPath);
}

/// Remove a project from the app's known list. Deletes the tsia-project.json
/// from the image folder (the images themselves are untouched) and unregisters
/// the folder.
export async function deleteProjectFile(project: Project): Promise<void> {
  await unregisterFolder(project.imageDirPath);
  try {
    await allowFolder(project.imageDirPath);
    const path = await projectFilePath(project.imageDirPath);
    if (await exists(path).catch(() => false)) {
      await remove(path);
    }
  } catch (e) {
    console.warn(`Could not delete project file in ${project.imageDirPath}:`, e);
  }
}
