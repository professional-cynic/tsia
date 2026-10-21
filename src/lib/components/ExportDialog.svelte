<script lang="ts">
  import type { Project } from '$lib/types';
  import { app } from '$lib/stores/app.svelte';
  import { exportDataset, cancelExport, pickExportFolder, planNegatives, type Format, type LinkMode } from '$lib/io/export';

  let { project, onclose }: { project: Project; onclose: () => void } = $props();

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

  // Export state machine. One union variant at a time means the UI can
  // pattern-match cleanly instead of guessing from a soup of booleans.
  type ExportState =
    | { kind: 'configuring' }
    | { kind: 'running'; format: Format; current: number; total: number;
        outPath: string; cancelled: boolean;
        warnings: { filename: string; message: string }[] }
    | { kind: 'done'; outPath: string;
        warnings: { filename: string; message: string }[] }
    | { kind: 'error'; message: string };

  let exportState = $state<ExportState>({ kind: 'configuring' });

  let candidates = $derived(reviewedOnly ? project.images.filter(i => i.reviewed === true) : project.images);
  let counts = $derived.by(() => {
    const pos = candidates.filter(i => i.boxes.length > 0).length;
    return { pos, neg: candidates.length - pos };
  });

  // Live preview of what the negative-target slider would export, computed
  // by the same Rust function the export itself uses.
  let plan = $state<{ pos: number; neg: number } | null>(null);
  $effect(() => {
    const { pos, neg } = counts;
    let stale = false;
    planNegatives(pos, neg, negTarget)
      .then(p => { if (!stale) plan = p; })
      .catch(() => { if (!stale) plan = null; });
    return () => { stale = true; };
  });
  let negPreview = $derived(plan && {
    keptPos: plan.pos, keptNeg: plan.neg,
    total: plan.pos + plan.neg,
    droppedPos: counts.pos - plan.pos,
    droppedNeg: counts.neg - plan.neg,
  });

  async function doExport(format: Format) {
    if (exportState.kind !== 'configuring') return;

    const folder = await pickExportFolder();
    if (!folder) return;

    // Make sure any pending edits are persisted and settled before we read
    // the project for export.
    await app.flushSave();

    // Optionally restrict to reviewed images. Empty reviewed images are
    // KEPT — a reviewed image with no boxes is a valid negative/background
    // sample (COCO: image entry with no annotations; YOLO: image with no
    // label file). Shallow-clone so the original is untouched.
    const p: Project = reviewedOnly ? { ...project, images: candidates } : project;

    exportState = {
      kind: 'running',
      format, current: 0, total: 0,
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
      // close the dialog.
      if (exportState.kind === 'running') onclose();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      exportState = { kind: 'error', message };
    }
  }
</script>

{#if exportState.kind === 'configuring'}
  <div class="export-backdrop" role="presentation"
    onpointerdown={(e) => { backdropPressed = e.target === e.currentTarget; }}
    onpointerup={(e) => { if (backdropPressed && e.target === e.currentTarget) onclose(); backdropPressed = false; }}>
    <div class="export-modal" role="dialog" aria-modal="true" aria-labelledby="export-title" tabindex="-1">
      <div id="export-title" class="export-title">Export "{project.name}"</div>
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
          {@const n = candidates.length}
          <span class="reviewed-count">{n} reviewed image{n === 1 ? '' : 's'} ({counts.pos} with boxes, {counts.neg} negative)</span>
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
        <button class="btn-sm" onclick={() => onclose()}>Cancel</button>
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
        <button class="btn-sm" onclick={() => onclose()}>Close</button>
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
        <button class="btn-sm" onclick={() => onclose()}>Close</button>
      </div>
    </div>
  </div>
{/if}

<style>
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
