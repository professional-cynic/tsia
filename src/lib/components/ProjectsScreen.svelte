<script lang="ts">
  import { app } from '$lib/stores/app.svelte';
  import { deleteProjectFile, loadAllProjects, saveProject, openExistingProjectFolder } from '$lib/persistence';
  import { open } from '@tauri-apps/plugin-dialog';
  import { invoke } from '@tauri-apps/api/core';
  import type { Project } from '$lib/types';
  import { allowAssetDir } from '$lib/io/import';
  import InputModal from './InputModal.svelte';
  import ConfirmModal from './ConfirmModal.svelte';
  import ReconcileModal from './ReconcileModal.svelte';
  import ExportDialog from './ExportDialog.svelte';

  let renameTarget = $state<Project | null>(null);
  let deleteTarget = $state<Project | null>(null);
  let exportTarget = $state<Project | null>(null);
  let relocateTarget = $state<Project | null>(null);
  let reconcileState = $state<{
    project: Project;
    newDir: string;
    matched: number;
    missing: string[];
    added: string[];
  } | null>(null);

  async function openProject(p: Project) {
    const exists = await invoke<boolean>('dir_exists', { path: p.imageDirPath });
    if (!exists) {
      relocateTarget = p;
      return;
    }
    await allowAssetDir(p.imageDirPath);
    app.resetAnnotationState(p);
    app.setImageIndex(0);
    app.screen = 'annotate';
  }

  async function doRelocate() {
    if (!relocateTarget) return;
    const dir = await open({ title: `Locate image folder for ${relocateTarget.name}`, directory: true });
    if (!dir) return;
    const newDir = dir as string;
    const exists = await invoke<boolean>('dir_exists', { path: newDir });
    if (!exists) return;

    // Diff the new folder against the project's image list.
    let scanned: string[] = [];
    try {
      scanned = await invoke<string[]>('scan_image_folder', { dir: newDir });
    } catch {
      // Treat scan failure as "everything missing"; the user can cancel out.
      scanned = [];
    }

    const projectFiles = new Set(relocateTarget.images.map(i => i.filename));
    const scannedSet = new Set(scanned);
    const missing = relocateTarget.images.map(i => i.filename).filter(f => !scannedSet.has(f));
    const added = scanned.filter(f => !projectFiles.has(f));
    const matched = relocateTarget.images.length - missing.length;

    // Persist the new path regardless of which branch we take.
    relocateTarget.imageDirPath = newDir;

    if (missing.length === 0 && added.length === 0) {
      // Clean relocate, no divergence. Open silently.
      await saveProject(relocateTarget);
      await allowAssetDir(newDir);
      const p = relocateTarget;
      relocateTarget = null;
      app.resetAnnotationState(p);
      app.setImageIndex(0);
      app.screen = 'annotate';
      return;
    }

    // Divergence: hand off to the reconciliation modal.
    reconcileState = {
      project: relocateTarget,
      newDir,
      matched,
      missing,
      added,
    };
    relocateTarget = null;
  }

  async function cancelReconcile() {
    if (!reconcileState) return;
    // The user picked the new folder — keep that. They just declined to
    // clean up the divergence. Persist the new path; the canvas will show
    // blanks for missing files, which the user can resolve later.
    await saveProject(reconcileState.project);
    reconcileState = null;
  }

  async function resolveReconcile(action: { dropMissing: boolean; addNew: boolean }) {
    if (!reconcileState) return;
    const { project, missing, added } = reconcileState;

    if (action.dropMissing && missing.length > 0) {
      const missingSet = new Set(missing);
      project.images = project.images.filter(img => !missingSet.has(img.filename));
    }
    if (action.addNew && added.length > 0) {
      for (const filename of added) {
        project.images.push({ filename, boxes: [] });
      }
      // Re-sort so subdir/foo.jpg appears with its siblings (matches scan order).
      project.images.sort((a, b) => a.filename.localeCompare(b.filename));
    }

    await saveProject(project);
    await allowAssetDir(project.imageDirPath);
    reconcileState = null;
    app.resetAnnotationState(project);
    app.setImageIndex(0);
    app.screen = 'annotate';
  }

  let openMessage = $state<string | null>(null);

  /// Open a project's image folder in the system file manager. The path comes
  /// from the project file; the Rust command validates it before handing it to
  /// the OS (see opener_bridge).
  async function openSourceFolder(p: Project) {
    openMessage = null;
    try {
      await invoke('open_source_folder', { dir: p.imageDirPath });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      openMessage = `Could not open ${p.imageDirPath}: ${msg}`;
    }
  }

  async function openExisting() {
    openMessage = null;
    const dir = await open({ title: 'Open existing project folder', directory: true });
    if (!dir) return;
    const result = await openExistingProjectFolder(dir as string);
    if (result.ok) {
      app.projects = await loadAllProjects();
    } else if (result.reason === 'no-project') {
      openMessage = "That folder doesn't contain a TSIA project (no tsia-project.json found in it).";
    } else if (result.reason === 'invalid') {
      openMessage = 'That folder has a project file, but it could not be read. It may be corrupted.';
    } else {
      openMessage = 'That folder path could not be used.';
    }
  }

  async function doDelete() {
    if (!deleteTarget) return;
    await deleteProjectFile(deleteTarget);
    app.projects = await loadAllProjects();
    deleteTarget = null;
  }

  async function confirmRename(name: string) {
    if (renameTarget) {
      renameTarget.name = name;
      await saveProject(renameTarget);
    }
    renameTarget = null;
  }
</script>

<div class="screen-projects">
  <div class="topbar">
    <span class="topbar-title">Projects</span>
    <span style="flex:1"></span>
    <button class="btn-primary" onclick={() => app.screen = 'new'}>+ New Project</button>
    {#if app.projects.length >= 2}
      <button onclick={() => app.screen = 'merge'}>Merge</button>
    {/if}
    <button onclick={() => app.screen = 'home'}>Home</button>
  </div>
  <div class="list" class:list-empty={app.projects.length === 0}>
    {#if app.projects.length === 0}
      <div class="empty">No projects yet. Create one to get started.</div>
    {:else}
      {#each app.projects as p (p.id)}
        {@const totalBoxes = p.images.reduce((s, img) => s + img.boxes.length, 0)}
        {@const annotated = p.images.filter(img => img.boxes.length > 0).length}
        {@const measurements = p.images.reduce((s, img) => s + img.boxes.filter(b => b.measure).length, 0)}
        <div class="project-item">
          <div class="project-info">
            <div class="project-name">{p.name}</div>
            <div class="project-detail">{p.images.length} images · {annotated} annotated · {totalBoxes} boxes{measurements > 0 ? ` · ${measurements} measurements` : ''} · {p.classes.join(', ')}</div>
          </div>
          <div class="project-actions">
            <button class="btn-sm btn-primary" onclick={() => openProject(p)}>Open</button>
            <button class="btn-sm" onclick={() => exportTarget = p}>Export</button>
            <button class="btn-sm" onclick={() => openSourceFolder(p)} title="Open the image folder in your file manager">Folder</button>
            <button class="btn-sm" onclick={() => renameTarget = p}>Rename</button>
            <button class="btn-sm btn-danger" onclick={() => deleteTarget = p}>Delete</button>
          </div>
        </div>
      {/each}
    {/if}

    <div class="open-existing">
      <button class="btn-open-existing" onclick={openExisting}>Open Existing Project</button>
      <button type="button" class="info" aria-label="What is this?">i
        <span class="tip">Each project is stored as a <code>tsia-project.json</code> inside its image folder. If a project isn't listed (after a reinstall, or on another machine), use this to pick its folder and restore it.</span>
      </button>
    </div>
    {#if openMessage}
      <div class="open-msg">{openMessage}</div>
    {/if}
  </div>
</div>

{#if renameTarget}
  <InputModal title="Rename project" defaultValue={renameTarget.name} onconfirm={confirmRename} oncancel={() => renameTarget = null} />
{/if}

{#if deleteTarget}
  <ConfirmModal title="Delete project" message="Permanently delete this project's annotations? The tsia-project.json file will be removed from the image folder. Your image files are NOT deleted, only the annotations. This cannot be undone." onconfirm={doDelete} oncancel={() => deleteTarget = null} />
{/if}

{#if relocateTarget}
  <ConfirmModal
    title="Image folder not found"
    message={`The image folder for "${relocateTarget.name}" no longer exists at:\n${relocateTarget.imageDirPath}\n\nLocate it on disk?`}
    onconfirm={doRelocate}
    oncancel={() => relocateTarget = null}
  />
{/if}

{#if reconcileState}
  <ReconcileModal
    projectName={reconcileState.project.name}
    matched={reconcileState.matched}
    missing={reconcileState.missing}
    added={reconcileState.added}
    onresolve={resolveReconcile}
    oncancel={cancelReconcile}
  />
{/if}

{#if exportTarget}
  <ExportDialog project={exportTarget} onclose={() => exportTarget = null} />
{/if}

<style>
  .screen-projects { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .topbar { background: var(--bg2); border-bottom: 1px solid var(--border); padding: 10px 20px; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
  .topbar-title { font-size: 14px; font-weight: 700; letter-spacing: 0.05em; }
  .list { flex: 1; overflow-y: auto; max-width: 860px; margin: 0 auto; padding: 24px; width: 100%; display: flex; flex-direction: column; }
  .empty { color: var(--text2); text-align: center; padding: 0 0 20px; }

  /* When there are no projects, center the open-existing block (and the empty
     note) vertically in the list area instead of sitting at the top. */
  .list-empty { justify-content: center; align-items: center; }

  .open-existing {
    display: flex; align-items: center; justify-content: center; gap: 10px;
    padding: 16px 0;
  }
  .btn-open-existing {
    background: var(--bg3); border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); padding: 9px 18px; font-size: 13px; cursor: pointer;
  }
  .btn-open-existing:hover { background: var(--bg2); border-color: var(--text2); }

  .info {
    display: inline-flex; align-items: center; justify-content: center;
    width: 16px; height: 16px; border-radius: 50%;
    border: 1px solid var(--text2); color: var(--text2);
    font-size: 10px; font-style: italic; font-weight: 700;
    cursor: help; position: relative; user-select: none;
    background: none; padding: 0; font-family: inherit;
  }
  .info .tip {
    position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%);
    width: 280px; padding: 10px 12px;
    background: var(--bg2); border: 1px solid var(--border); border-radius: 8px;
    color: var(--text2); font-size: 11px; font-style: normal; font-weight: 400;
    line-height: 1.5; text-align: left;
    opacity: 0; visibility: hidden; transition: opacity 0.12s; z-index: 10;
    box-shadow: 0 4px 14px rgba(0,0,0,0.3);
  }
  .info:hover { background: none; }
  .info:hover .tip, .info:focus .tip { opacity: 1; visibility: visible; }
  .info .tip code { font-size: 10px; color: var(--text); }

  .open-msg { font-size: 12px; color: var(--warn); text-align: center; padding-bottom: 12px; }
  .project-item { display: flex; align-items: center; gap: 12px; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 8px; background: var(--bg2); }
  .project-info { flex: 1; }
  .project-name { font-weight: 600; margin-bottom: 4px; }
  .project-detail { font-size: 11px; color: var(--text2); }
  .project-actions { display: flex; gap: 6px; }
</style>
