<script lang="ts">
  let { matched, missing, added, projectName, onresolve, oncancel }: {
    matched: number;
    missing: string[];
    added: string[];
    projectName: string;
    onresolve: (action: { dropMissing: boolean; addNew: boolean }) => void;
    oncancel: () => void;
  } = $props();

  let dropMissing = $state(false);
  let addNew = $state(missing.length === 0 && added.length > 0);
  // Default: if only new files exist, pre-check add. If only missing exist,
  // keep both unchecked (destructive defaults are bad). Mixed: leave both
  // off and let the user think.

  let showMissingDetails = $state(false);
  let showAddedDetails = $state(false);
</script>

<div class="backdrop" role="presentation" onclick={oncancel}>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="reconcile-title" tabindex="-1"
    onclick={(e) => e.stopPropagation()}>
    <div id="reconcile-title" class="title">Reconcile "{projectName}"</div>
    <div class="hint">
      The new folder contents don't exactly match what this project remembers.
      Choose what to do; annotations on dropped files are lost.
    </div>

    <div class="counts">
      <div class="count-row matched">
        <span class="count">{matched}</span>
        <span class="label">match the project ✓</span>
      </div>

      <div class="count-row missing" class:none={missing.length === 0}>
        <span class="count">{missing.length}</span>
        <span class="label">in the project, not in the new folder</span>
        {#if missing.length > 0}
          <button class="details-btn" onclick={() => showMissingDetails = !showMissingDetails}>
            {showMissingDetails ? 'hide' : 'show'}
          </button>
        {/if}
      </div>
      {#if showMissingDetails && missing.length > 0}
        <div class="details">
          {#each missing.slice(0, 30) as f}
            <div class="detail-row">{f}</div>
          {/each}
          {#if missing.length > 30}
            <div class="detail-row">…and {missing.length - 30} more.</div>
          {/if}
        </div>
      {/if}

      <div class="count-row added" class:none={added.length === 0}>
        <span class="count">{added.length}</span>
        <span class="label">in the new folder, not in the project</span>
        {#if added.length > 0}
          <button class="details-btn" onclick={() => showAddedDetails = !showAddedDetails}>
            {showAddedDetails ? 'hide' : 'show'}
          </button>
        {/if}
      </div>
      {#if showAddedDetails && added.length > 0}
        <div class="details">
          {#each added.slice(0, 30) as f}
            <div class="detail-row">{f}</div>
          {/each}
          {#if added.length > 30}
            <div class="detail-row">…and {added.length - 30} more.</div>
          {/if}
        </div>
      {/if}
    </div>

    <div class="options">
      {#if missing.length > 0}
        <label class="opt">
          <input type="checkbox" bind:checked={dropMissing} />
          <span>Drop {missing.length} missing image{missing.length === 1 ? '' : 's'} and their annotations</span>
        </label>
      {/if}
      {#if added.length > 0}
        <label class="opt">
          <input type="checkbox" bind:checked={addNew} />
          <span>Add {added.length} new image{added.length === 1 ? '' : 's'} to the project</span>
        </label>
      {/if}
    </div>

    <div class="actions">
      <button onclick={oncancel}>Cancel</button>
      <button class="btn-primary" onclick={() => onresolve({ dropMissing, addNew })}>
        {dropMissing || addNew ? 'Apply & Open' : 'Open As-Is'}
      </button>
    </div>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 200; display: flex; align-items: center; justify-content: center; }
  .modal { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 18px 20px; width: 480px; max-width: 90vw; max-height: 80vh; overflow-y: auto; }
  .title { font-size: 13px; font-weight: 700; margin-bottom: 8px; }
  .hint { font-size: 11px; color: var(--text2); line-height: 1.5; margin-bottom: 16px; }
  .counts { background: var(--bg3); border-radius: 4px; padding: 8px 10px; margin-bottom: 14px; }
  .count-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 12px; }
  .count-row.none { opacity: 0.4; }
  .count { font-weight: 700; font-variant-numeric: tabular-nums; min-width: 32px; text-align: right; }
  .count-row.matched .count { color: var(--success); }
  .count-row.missing .count { color: var(--danger); }
  .count-row.added .count { color: var(--warn); }
  .label { flex: 1; color: var(--text2); }
  .details-btn { background: none; border: none; color: var(--text2); cursor: pointer; font-size: 10px; text-decoration: underline; padding: 0 4px; font-family: inherit; }
  .details-btn:hover { color: var(--text); }
  .details { font-family: var(--font-mono, monospace); font-size: 10px; color: var(--text2); background: var(--bg); border-radius: 3px; padding: 6px 8px; margin: 4px 0 6px 40px; max-height: 160px; overflow-y: auto; }
  .detail-row { padding: 1px 0; word-break: break-all; }
  .options { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
  .opt { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; cursor: pointer; }
  .opt input { margin-top: 2px; flex-shrink: 0; accent-color: var(--accent); }
  .actions { display: flex; gap: 8px; justify-content: flex-end; }
</style>
