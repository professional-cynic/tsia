import {
  readTextFile, writeTextFile, exists, mkdir, readDir, remove,
  BaseDirectory,
} from '@tauri-apps/plugin-fs';
import type { Project } from '$lib/types';

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

export async function loadAllProjects(): Promise<Project[]> {
  await ensureDir();
  const entries = await readDir(DIR, { baseDir: BaseDirectory.AppData });
  const projects: Project[] = [];
  for (const entry of entries) {
    if (!entry.name?.endsWith('.json')) continue;
    try {
      const text = await readTextFile(`${DIR}/${entry.name}`, { baseDir: BaseDirectory.AppData });
      projects.push(JSON.parse(text));
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
