<script lang="ts">
  import { app } from '$lib/stores/app.svelte';
  import { saveProject } from '$lib/persistence';
  import { CLASS_COLORS, MAX_CLASSES } from '$lib/constants';
  import { open } from '@tauri-apps/plugin-dialog';
  import { importCOCO, importYOLO, scanImageFolder, allowAssetDir, type ImportedAnnotation } from '$lib/io/import';
  import type { Project } from '$lib/types';
  import InputModal from './InputModal.svelte';

  let name = $state('');
  let classes = $state<string[]>(['defect']);
  let imageDirPath = $state('');
  let imageFiles = $state<string[]>([]);
  let importedAnnotations = $state<Record<string, ImportedAnnotation[]>>({});
  let importStatus = $state('');
  let folderStatus = $state('');     // shown under the Images card
  let createError = $state('');      // shown above the Create button
  let creating = $state(false);
  let showYoloClassesModal = $state(false);

  let attempted = $state(false);
  let canCreate = $derived(name.trim() && imageFiles.length > 0 && classes.filter(c => c.trim()).length > 0);
  let nameError = $derived(attempted && !name.trim());
  let folderError = $derived(attempted && imageFiles.length === 0);
  let classError = $derived(attempted && classes.filter(c => c.trim()).length === 0);

  async function loadFolder() {
    folderStatus = '';
    const dir = await open({ title: 'Select image folder', directory: true });
    if (!dir) return;
    imageDirPath = dir as string;
    try {
      imageFiles = await scanImageFolder(imageDirPath);
      if (imageFiles.length === 0) {
        folderStatus = 'No supported images found in this folder (png, jpg, jpeg, bmp, webp).';
      }
    } catch (e) {
      imageFiles = [];
      folderStatus = `Could not scan folder: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function handleImportCOCO() {
    try {
      const result = await importCOCO();
      if (!result) return;
      if (result.name && !name.trim()) name = result.name;
      if (classes.length === 1 && classes[0] === 'defect') classes = [];
      for (const c of result.classes) { if (!classes.includes(c)) classes.push(c); }
      importedAnnotations = result.annotations;
      importStatus = `COCO: ${Object.values(result.annotations).reduce((s, a) => s + a.length, 0)} annotations imported.`;
    } catch (e) {
      importStatus = `COCO import failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function handleImportYOLO(fallbackClasses?: string[]) {
    if (imageFiles.length === 0) { importStatus = 'Load an image folder first.'; return; }
    try {
      const result = await importYOLO(imageFiles, fallbackClasses);
      if (!result) return;
      if (result.needsClasses) { showYoloClassesModal = true; return; }
      if (classes.length === 1 && classes[0] === 'defect') classes = [];
      for (const c of result.classes) { if (!classes.includes(c)) classes.push(c); }
      importedAnnotations = result.annotations;
      importStatus = `YOLO: ${Object.values(result.annotations).reduce((s, a) => s + a.length, 0)} annotations imported.`;
    } catch (e) {
      importStatus = `YOLO import failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  function confirmYoloClasses(input: string) {
    showYoloClassesModal = false;
    const cls = input.split(',').map(s => s.trim()).filter(Boolean);
    if (cls.length > 0) handleImportYOLO(cls);
  }

  async function create() {
    createError = '';
    creating = true;
    try {
      const validClasses = classes.filter(c => c.trim());
      const project: Project = {
        id: 'proj_' + Date.now(),
        name: name.trim(),
        classes: validClasses,
        imageDirPath,
        createdAt: new Date().toISOString(),
        nextBoxId: 1,
        images: imageFiles.map(fn => ({
          filename: fn,
          boxes: (importedAnnotations[fn] || []).map((a, i) => ({
            id: i + 1,
            classIdx: Math.min(a.classIdx, validClasses.length - 1),
            x: a.x, y: a.y, w: a.w, h: a.h,
          })),
        })),
      };
      project.nextBoxId = project.images.reduce(
        (max, img) => Math.max(max, ...img.boxes.map(b => b.id), 0), 0
      ) + 1;
      await saveProject(project);
      // Allow the canvas to load images from this folder this session. With
      // an empty static scope, every accessible directory must be added at
      // runtime — the user just picked this one from a dialog so it's a
      // safe moment to do so.
      await allowAssetDir(imageDirPath);
      app.projects.push(project);
      // Use the array element (a single shared $state proxy) as current,
      // NOT the raw local `project`. Assigning the plain object to both
      // app.projects and current separately can produce two proxies over
      // the same raw object — edits via current then aren't visible when
      // export reads the array element. Reading it back unifies them.
      const stored = app.projects[app.projects.length - 1];
      app.resetAnnotationState(stored);
      app.setImageIndex(0, false);
      app.screen = 'annotate';
    } catch (e) {
      createError = e instanceof Error ? e.message : String(e);
    } finally {
      creating = false;
    }
  }

  function tryCreate() {
    attempted = true;
    if (!canCreate) return;
    create();
  }
</script>

<div class="screen-new">
  <div class="topbar">
    <span class="topbar-title">New Project</span>
    <span style="flex:1"></span>
    <button onclick={() => app.screen = 'projects'}>Cancel</button>
  </div>
  <div class="inner">
    <div class="card">
      <div class="card-title">Project Name</div>
      <input type="text" bind:value={name} placeholder="e.g. Pipe_A defects" class:error={nameError} />
      {#if nameError}<div class="field-error">Project name is required.</div>{/if}
    </div>
    <div class="card">
      <div class="card-title">Images</div>
      <button onclick={loadFolder}>Load Image Folder</button>
      {#if imageDirPath}<div class="status path-status">{imageDirPath}</div>{/if}
      {#if imageFiles.length > 0}<div class="status">{imageFiles.length} image(s) found.</div>{/if}
      {#if folderStatus}<div class="field-error">{folderStatus}</div>{/if}
      {#if folderError && !folderStatus}<div class="field-error">Select an image folder.</div>{/if}
    </div>
    <div class="card">
      <div class="card-title">Import Annotations (optional)</div>
      <div class="hint">Import before editing classes — COCO/YOLO will auto-populate them.</div>
      <div class="import-row">
        <button onclick={handleImportCOCO}>Import COCO JSON</button>
        <button onclick={() => handleImportYOLO()}>Import YOLO</button>
      </div>
      {#if importStatus}<div class="status">{importStatus}</div>{/if}
    </div>
    <div class="card">
      <div class="card-title">Classes</div>
      {#each classes as _, i}
        <div class="class-row">
          <div class="swatch" style:background={CLASS_COLORS[i]}></div>
          <input type="text" bind:value={classes[i]} placeholder="Class name" />
          {#if classes.length > 1}
            <button class="btn-sm btn-danger" onclick={() => classes.splice(i, 1)}>✕</button>
          {/if}
        </div>
      {/each}
      {#if classes.length < MAX_CLASSES}
        <button class="btn-sm" onclick={() => classes.push('')} style="margin-top:4px;">+ Add Class</button>
      {/if}
      <div class="hint" style="margin-top:8px;">Up to {MAX_CLASSES} classes. Shortcuts: 1–9 for the first nine, 0 for the tenth.</div>
      {#if classError}<div class="field-error">At least one class is required.</div>{/if}
    </div>
    {#if createError}<div class="create-error">{createError}</div>{/if}
    <div class="actions">
      <button class="btn-primary" disabled={creating} onclick={tryCreate}>
        {creating ? 'Creating…' : 'Create Project'}
      </button>
    </div>
  </div>
</div>

{#if showYoloClassesModal}
  <InputModal title="No classes.txt found" placeholder="e.g. lump,crack,corrosion" onconfirm={confirmYoloClasses} oncancel={() => showYoloClassesModal = false} />
{/if}

<style>
  .screen-new { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .topbar { background: var(--bg2); border-bottom: 1px solid var(--border); padding: 10px 20px; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
  .topbar-title { font-size: 14px; font-weight: 700; letter-spacing: 0.05em; }
  .inner { flex: 1; overflow-y: auto; max-width: 540px; margin: 0 auto; padding: 24px; width: 100%; }
  .card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; margin-bottom: 12px; }
  .card-title { font-size: 12px; font-weight: 700; margin-bottom: 8px; text-transform: uppercase; letter-spacing: .05em; color: var(--text2); }
  .hint { font-size: 10px; color: var(--text2); margin-bottom: 6px; }
  .status { font-size: 11px; color: var(--text2); margin-top: 8px; }
  .path-status { font-family: var(--font-mono, monospace); word-break: break-all; }
  .import-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .actions { display: flex; justify-content: flex-end; margin-top: 16px; }
  .class-row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .class-row .swatch { width: 12px; height: 12px; border-radius: 3px; flex-shrink: 0; }
  .class-row input { flex: 1; }
  .field-error { font-size: 11px; color: var(--danger); margin-top: 4px; }
  .create-error { font-size: 11px; color: var(--danger); margin-bottom: 8px; word-break: break-word; }
  input.error { border-color: var(--danger); }
</style>
