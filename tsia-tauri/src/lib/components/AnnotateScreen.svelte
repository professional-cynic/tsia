<script lang="ts">
  import Sidebar from './Sidebar.svelte';
  import CanvasArea from './CanvasArea.svelte';
  import RightPanel from './RightPanel.svelte';
  import ShortcutsOverlay from './ShortcutsOverlay.svelte';
  import { app } from '$lib/stores/app.svelte';
</script>

{#if app.current}
<div class="annotate">
  <Sidebar />
  <div class="annotate-main">
    <CanvasArea />
    <div class="progress-container" title="Reviewed images / total in project">
      <div class="progress-label">
        {app.reviewedCount} / {app.current.images.length} reviewed
      </div>
      <div class="progress-bar" role="progressbar"
        aria-valuemin="0"
        aria-valuemax={app.current.images.length}
        aria-valuenow={app.reviewedCount}>
        <div class="progress-fill" style:width="{(app.reviewProgress * 100).toFixed(1)}%"></div>
      </div>
    </div>
  </div>
  <RightPanel />
  <button class="help-toggle" onclick={() => app.showHelp = !app.showHelp}>i</button>
  {#if app.showHelp}
    <ShortcutsOverlay />
  {/if}
</div>
{/if}

<style>
  .annotate { display: flex; flex: 1; overflow: hidden; position: relative; }
  .annotate-main { flex: 1; display: flex; flex-direction: column; overflow: hidden; position: relative; }
  .progress-container { flex-shrink: 0; background: var(--bg2); border-top: 1px solid var(--border); }
  .progress-label { font-size: 9px; color: var(--text2); padding: 3px 8px 2px; text-align: right; }
  .progress-bar { height: 3px; background: var(--bg3); }
  .progress-fill { height: 100%; background: var(--accent); transition: width 0.2s ease; }
  .help-toggle {
    position: absolute; bottom: 12px; left: 230px;
    width: 28px; height: 28px; border-radius: 6px;
    border: 1px solid var(--border); background: var(--bg2);
    color: var(--text2); font-size: 14px; font-style: italic; font-family: Georgia, serif;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    z-index: 11; opacity: 0.5; padding: 0;
  }
  .help-toggle:hover { opacity: 1; color: var(--text); border-color: var(--text2); }
</style>
