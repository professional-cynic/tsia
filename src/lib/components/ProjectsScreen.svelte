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
  import { exportDataset, cancelExport, pickExportFolder, type Format, type LinkMode } from '$lib/io/export';

  let renameTarget = $state<Project | null>(null);
  let deleteTarget = $state<Project | null>(null);
  let splitRatio = $state(80);
  let linkMode = $state<LinkMode>('copy');
  let reviewedOnly = $state(false);
  // Target percentage of negative (box-less) images in the exported set.
  // -1 = no target: include every negative as-is. 0..100 = trim the surplus
  // side (positives or negatives) to hit exactly that fraction of negatives.
  let negTarget = $state(-1);
  // Guards the backdrop dismiss against stray pointerup from a slider drag
  // released outside the modal (same class of bug as the titlebar close).
  let backdropPressed = $state(false);

  // Plan how many positives/negatives to keep to hit a negative-fraction
  // target. Mirrors the Rust apply_neg_target logic exactly.
  function planNegatives(pos: number, neg: number, targetPct: number): { pos: number; neg: number } {
    if (targetPct < 0) return { pos, neg };           // no target
    const t = targetPct / 100;
    if (t <= 0) return { pos, neg: 0 };
    if (t >= 1) return neg > 0 ? { pos: 0, neg } : { pos, neg: 0 };
    if (neg === 0) return { pos, neg: 0 };
    if (pos === 0) return { pos: 0, neg };
    const avail = neg / (pos + neg);
    if (avail >= t) {
      return { pos, neg: Math.min(Math.round(pos * t / (1 - t)), neg) };
    }
    return { pos: Math.min(Math.round(neg * (1 - t) / t), pos), neg };
  }

  // Live preview of what the negative-target slider would export. Computed
  // here (not via {@const} in markup, which must be a block child) so the
  // modal can show a stable, always-present line.
  let negPreview = $derived.by(() => {
    if (exportState.kind !== 'configuring') return null;
    const imgs = reviewedOnly
      ? exportState.project.images.filter(i => i.reviewed === true)
      : exportState.project.images;
    const pos = imgs.filter(i => i.boxes.length > 0).length;
    const neg = imgs.length - pos;
    const plan = negTarget < 0 ? { pos, neg } : planNegatives(pos, neg, negTarget);
    return {
      pos, neg,
      keptPos: plan.pos, keptNeg: plan.neg,
      total: plan.pos + plan.neg,
      droppedPos: pos - plan.pos,
      droppedNeg: neg - plan.neg,
    };
  });

  // Export state machine. One union variant at a time means the UI can
  // pattern-match cleanly instead of guessing from a soup of booleans.
  type ExportState =
    | { kind: 'idle' }
    | { kind: 'configuring'; project: Project }
    | { kind: 'running'; format: Format; current: number; total: number;
        outPath: string; cancelled: boolean;
        warnings: { filename: string; message: string }[] }
    | { kind: 'done'; outPath: string;
        warnings: { filename: string; message: string }[] }
    | { kind: 'error'; message: string };

  let exportState = $state<ExportState>({ kind: 'idle' });

  async function doExport(format: Format) {
    if (exportState.kind !== 'configuring') return;
    const src = exportState.project;

    const folder = await pickExportFolder();
    if (!folder) return;

    // Make sure any pending edits are persisted and settled before we read
    // the project for export.
    await app.flushSave();

    // Optionally restrict to reviewed images. Empty reviewed images are
    // KEPT — a reviewed image with no boxes is a valid negative/background
    // sample (COCO: image entry with no annotations; YOLO: image with an
    // empty or absent label file). Shallow-clone so the original is
    // untouched.
    const p: Project = reviewedOnly
      ? { ...src, images: src.images.filter(img => img.reviewed === true) }
      : src;

    const total = p.images.filter(img => img.boxes.length > 0).length;
    exportState = {
      kind: 'running',
      format, current: 0, total,
      outPath: '',
      cancelled: false, warnings: [],
    };

    try {
      await exportDataset(p, {
        format, linkMode, outDir: folder,
        trainRatio: splitRatio / 100,
        negRatio: negTarget < 0 ? -1 : negTarget / 100,
        onProgress: (e) => {
          if (exportState.kind !== 'running') return;
          switch (e.kind) {
            case 'start':
              exportState.total = e.data.total;
              exportState.outPath = e.data.outPath;
              break;
            case 'item':
              exportState.current = e.data.current;
              break;
            case 'warning':
              exportState.warnings.push(e.data);
              break;
            case 'cancelled':
              exportState.cancelled = true;
              break;
            case 'failed':
              exportState = { kind: 'error', message: e.data.message };
              break;
            case 'done':
              exportState = {
                kind: 'done',
                outPath: e.data.outPath,
                warnings: exportState.warnings,
              };
              break;
          }
        },
      });
      // If the run ended without a 'done'/'failed' event (cancel path),
      // settle to idle so the modal closes.
      if (exportState.kind === 'running') {
        exportState = { kind: 'idle' };
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      exportState = { kind: 'error', message };
    }
  }

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
    app.setImageIndex(0, false);
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
      app.setImageIndex(0, false);
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
    app.setImageIndex(0, false);
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
            <button class="btn-sm" onclick={() => exportState = { kind: 'configuring', project: p }}>Export</button>
            <button class="btn-sm" onclick={() => openSourceFolder(p)} title="Open the image folder in your file manager">Folder</button>
            <button class="btn-sm" onclick={() => renameTarget = p}>Rename</button>
            <button class="btn-sm btn-danger" onclick={() => deleteTarget = p}>Delete</button>
          </div>
        </div>
      {/each}
    {/if}

    <div class="open-existing">
      <button class="btn-open-existing" onclick={openExisting}>Open Existing Project</button>
      <span class="info" tabindex="0" role="img" aria-label="What is this?">i
        <span class="tip">Each project is stored as a <code>tsia-project.json</code> inside its image folder. If a project isn't listed (after a reinstall, or on another machine), use this to pick its folder and restore it.</span>
      </span>
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

{#if exportState.kind === 'configuring'}
  <div class="export-backdrop" role="presentation"
    onpointerdown={(e) => { backdropPressed = e.target === e.currentTarget; }}
    onpointerup={(e) => { if (backdropPressed && e.target === e.currentTarget) exportState = { kind: 'idle' }; backdropPressed = false; }}>
    <div class="export-modal" role="dialog" aria-modal="true" aria-labelledby="export-title" tabindex="-1">
      <div id="export-title" class="export-title">Export "{exportState.project.name}"</div>
      <div class="export-row">
        <span class="export-label">Train / Val split: {splitRatio}% / {100 - splitRatio}%</span>
        <input type="range" min="50" max="100" step="5" bind:value={splitRatio} />
      </div>
      <div class="export-row export-mode">
        <label class="mode-opt">
          <input type="radio" name="linkmode" value="copy" bind:group={linkMode} />
          <span>Copy images</span>
          <span class="mode-hint">Independent files. Works across drives.</span>
        </label>
        <label class="mode-opt">
          <input type="radio" name="linkmode" value="link" bind:group={linkMode} />
          <span>Hardlink images</span>
          <span class="mode-hint">Zero disk space, instant. Same filesystem as source only.</span>
        </label>
      </div>
      <div class="export-row">
        <label class="reviewed-opt">
          <input type="checkbox" bind:checked={reviewedOnly} />
          <span>Export reviewed images only</span>
        </label>
        {#if reviewedOnly}
          {@const n = exportState.project.images.filter(i => i.reviewed === true).length}
          {@const withBoxes = exportState.project.images.filter(i => i.reviewed === true && i.boxes.length > 0).length}
          <span class="reviewed-count">{n} reviewed image{n === 1 ? '' : 's'} ({withBoxes} with boxes, {n - withBoxes} negative)</span>
        {/if}
      </div>
      <div class="export-row">
        <span class="export-label">
          Negative samples: {negTarget < 0 ? 'include all' : `target ${negTarget}%`}
        </span>
        <input type="range" min="-5" max="50" step="5" bind:value={negTarget} />
        <span class="reviewed-count negatives-preview">
          {#if negPreview}Would export {negPreview.total} images: {negPreview.keptPos} with boxes, {negPreview.keptNeg} negative{#if negPreview.droppedPos > 0 || negPreview.droppedNeg > 0} (dropping {negPreview.droppedPos} positive, {negPreview.droppedNeg} negative){/if}{/if}
        </span>
      </div>
      <div class="export-actions">
        <button class="btn-sm btn-success" onclick={() => doExport('coco')}>COCO</button>
        <button class="btn-sm btn-success" onclick={() => doExport('yolo')}>YOLO</button>
        <button class="btn-sm" onclick={() => exportState = { kind: 'idle' }}>Cancel</button>
      </div>
    </div>
  </div>
{:else if exportState.kind === 'running'}
  <div class="export-backdrop" role="presentation">
    <div class="export-modal" role="dialog" aria-modal="true" aria-labelledby="export-progress-title" tabindex="-1">
      <div id="export-progress-title" class="export-title">
        {exportState.cancelled ? 'Cancelling…' : `Exporting ${exportState.format.toUpperCase()}…`}
      </div>
      <div class="export-progress-bar"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax={exportState.total}
        aria-valuenow={exportState.current}>
        <div class="export-progress-fill" style:width="{exportState.total > 0 ? (exportState.current / exportState.total * 100) : 0}%"></div>
      </div>
      <div class="export-progress-text">{exportState.current} / {exportState.total} images</div>
      <div class="export-actions" style="margin-top:12px; justify-content:center;">
        <button class="btn-sm btn-danger" disabled={exportState.cancelled} onclick={() => cancelExport()}>Cancel</button>
      </div>
    </div>
  </div>
{:else if exportState.kind === 'error'}
  <div class="export-backdrop" role="presentation">
    <div class="export-modal" role="dialog" aria-modal="true" aria-labelledby="export-error-title" tabindex="-1">
      <div id="export-error-title" class="export-title">Export failed</div>
      <div class="export-error">{exportState.message}</div>
      <div class="export-actions" style="margin-top:12px; justify-content:flex-end;">
        <button class="btn-sm" onclick={() => exportState = { kind: 'idle' }}>Close</button>
      </div>
    </div>
  </div>
{:else if exportState.kind === 'done'}
  <div class="export-backdrop" role="presentation">
    <div class="export-modal" role="dialog" aria-modal="true" aria-labelledby="export-done-title" tabindex="-1">
      <div id="export-done-title" class="export-title">
        Export complete{exportState.warnings.length > 0 ? `: ${exportState.warnings.length} warning${exportState.warnings.length === 1 ? '' : 's'}` : ''}
      </div>
      {#if exportState.outPath}
        <div class="export-row">
          <span class="export-label">Saved to:</span>
          <div class="export-path">{exportState.outPath}</div>
        </div>
      {/if}
      {#if exportState.warnings.length > 0}
        <div class="export-warnings">
          {#each exportState.warnings.slice(0, 20) as w}
            <div class="warning-row"><span class="warning-file">{w.filename}</span>: {w.message}</div>
          {/each}
          {#if exportState.warnings.length > 20}
            <div class="warning-row">…and {exportState.warnings.length - 20} more.</div>
          {/if}
        </div>
      {/if}
      <div class="export-actions" style="margin-top:12px; justify-content:flex-end;">
        <button class="btn-sm" onclick={() => exportState = { kind: 'idle' }}>Close</button>
      </div>
    </div>
  </div>
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
  .info:hover .tip, .info:focus .tip { opacity: 1; visibility: visible; }
  .info .tip code { font-size: 10px; color: var(--text); }

  .open-msg { font-size: 12px; color: var(--warn); text-align: center; padding-bottom: 12px; }
  .project-item { display: flex; align-items: center; gap: 12px; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 8px; background: var(--bg2); }
  .project-info { flex: 1; }
  .project-name { font-weight: 600; margin-bottom: 4px; }
  .project-detail { font-size: 11px; color: var(--text2); }
  .project-actions { display: flex; gap: 6px; }
  .export-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 200; display: flex; align-items: center; justify-content: center; }
  .export-modal { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 20px; min-width: 320px; max-width: 480px; text-align: left; }
  .export-title { font-size: 13px; font-weight: 700; margin-bottom: 12px; }
  .export-row { margin-bottom: 14px; display: flex; flex-direction: column; gap: 4px; }
  .export-label { font-size: 11px; color: var(--text2); }
  .export-row input[type="range"] { width: 100%; accent-color: var(--accent); }
  .export-mode { gap: 8px; }
  .mode-opt { display: grid; grid-template-columns: auto 1fr; row-gap: 2px; column-gap: 8px; font-size: 12px; cursor: pointer; align-items: baseline; }
  .mode-opt input { grid-row: span 2; align-self: center; accent-color: var(--accent); }
  .mode-hint { font-size: 10px; color: var(--text2); }
  .reviewed-opt { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--text); cursor: pointer; }
  .reviewed-opt input { cursor: pointer; }
  .reviewed-count { font-size: 10px; color: var(--text2); margin-top: 3px; }
  .negatives-preview {
    display: block;
    min-height: 26px;   /* reserve ~2 lines so toggling the target text
                           never reflows the modal and shifts it under the
                           cursor mid-drag */
    line-height: 1.3;
  }
  .export-actions { display: flex; gap: 8px; }
  .export-progress-bar { height: 4px; background: var(--bg3); border-radius: 2px; margin-bottom: 8px; overflow: hidden; }
  .export-progress-fill { height: 100%; background: var(--accent); transition: width 0.15s; }
  .export-progress-text { font-size: 11px; color: var(--text2); text-align: center; }
  .export-error { font-size: 12px; color: var(--danger); white-space: pre-wrap; word-break: break-word; }
  .export-warnings { font-size: 11px; max-height: 240px; overflow-y: auto; background: var(--bg3); border-radius: 4px; padding: 8px; }
  .warning-row { padding: 2px 0; color: var(--text2); word-break: break-word; }
  .warning-file { font-family: var(--font-mono, monospace); color: var(--warn); }
  .export-path { font-family: var(--font-mono, monospace); font-size: 11px; word-break: break-all; background: var(--bg3); padding: 6px 8px; border-radius: 4px; color: var(--text); }
</style>
