<script lang="ts">
  import { app } from '$lib/stores/app.svelte';
</script>

<div class="overlay" role="presentation"
  onclick={(e) => { if (e.target === e.currentTarget) app.showHelp = false; }}>
  <div class="card" role="dialog" aria-modal="true" aria-label="Keyboard Shortcuts" tabindex="-1">
    <div class="title">Keyboard Shortcuts</div>
    <kbd>A</kbd> / <kbd>D</kbd> Prev / Next image<br>
    <kbd>1</kbd>…<kbd>9</kbd>, <kbd>0</kbd> Set class (or reassign selected box)<br>
    <kbd>←</kbd> <kbd>↑</kbd> <kbd>→</kbd> <kbd>↓</kbd> Nudge selected box (1 px)<br>
    <kbd>Shift</kbd>+arrow Nudge by 10 px<br>
    <kbd>C</kbd> Copy boxes from previous image<br>
    <kbd>X</kbd> Toggle needs re-review<br>
    <kbd>Z</kbd> Undo<br>
    <kbd>Del</kbd> Delete selected / last box<br>
    <kbd>Esc</kbd> Deselect / close this help<br>
    <kbd>F11</kbd> Toggle fullscreen<br>
    <kbd>Scroll</kbd> Zoom &nbsp; <kbd>Middle drag</kbd> Pan<br>
    <kbd>?</kbd> Toggle this help

    <div class="legend-title">Image Status</div>
    <div class="legend-row"><span class="dot" style:background="var(--border)"></span> Not reviewed</div>
    <div class="legend-row"><span class="dot" style:background="var(--success)"></span> Reviewed</div>
    <div class="legend-row"><span class="dot" style:background="var(--warn)"></span> Needs re-review</div>
  </div>
</div>

<style>
  .overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 100; display: flex; align-items: center; justify-content: center; }
  .card { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 20px 24px; font-size: 11px; color: var(--text2); line-height: 2.2; max-width: 380px; text-align: left; }
  .title { font-weight: 700; margin-bottom: 8px; font-size: 12px; color: var(--text); }
  .legend-title { border-top: 1px solid var(--border); margin-top: 10px; padding-top: 10px; font-weight: 700; margin-bottom: 6px; font-size: 12px; color: var(--text); }
  .legend-row { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; line-height: 1.4; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
</style>
