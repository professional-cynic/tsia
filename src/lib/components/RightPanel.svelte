<script lang="ts">
  import { CLASS_COLORS } from '$lib/constants';
  import { app } from '$lib/stores/app.svelte';

  let boxes = $derived(app.current?.images[app.imgIndex]?.boxes ?? []);
</script>

<div class="right-panel">
  <!-- Navigation -->
  <div class="nav-row">
    <button class="nav-btn" onclick={() => app.navigateImage(-1)}>
      <span class="nav-icon">←</span>
      <span class="nav-label">Prev</span>
    </button>
    <button class="nav-btn" onclick={() => app.navigateImage(1)}>
      <span class="nav-icon">→</span>
      <span class="nav-label">Next</span>
    </button>
    <button class="nav-btn" onclick={() => app.undo()}>
      <span class="nav-icon">↩</span>
      <span class="nav-label">Undo</span>
    </button>
  </div>

  <!-- Box list -->
  <div class="box-header">Boxes ({boxes.length})</div>
  <div class="box-list">
    {#each boxes as box, i (box.id)}
      {@const color = CLASS_COLORS[box.classIdx] || '#fff'}
      {@const label = app.current?.classes[box.classIdx] || 'unknown'}
      {@const inSel = box.id === app.selectedBox || app.selectedBoxes.has(box.id)}
      <div class="box-item" class:selected={inSel}
        onclick={(e) => { if (e.shiftKey) app.toggleInSelection(box.id); else app.selectSingle(box.id); }}
        onkeydown={(e) => { if (e.key === 'Enter') app.selectSingle(box.id); }}
        role="button" tabindex="0">
        <div class="b-swatch" style:background={color}></div>
        <span class="b-label">{i + 1}. {label}</span>
        <span class="b-dims">{Math.round(box.w)}×{Math.round(box.h)}</span>
        <button class="b-del" onclick={(e) => { e.stopPropagation(); app.deleteBox(box.id); }}>✕</button>
      </div>
    {/each}
  </div>

  <!-- Autosave indicator -->
  <div class="autosave" class:is-saving={app.saveStatus === 'saving'}>
    <span class="autosave-dot"></span>
    <span class="autosave-text">{app.saveStatus === 'saving' ? 'Saving…' : 'Autosaved'}</span>
  </div>
</div>

<style>
  .right-panel { width: 200px; flex-shrink: 0; background: var(--bg2); border-left: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }

  /* Navigation buttons */
  .nav-row { display: flex; gap: 4px; padding: 8px; flex-shrink: 0; border-bottom: 1px solid var(--border); }
  .nav-btn {
    flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px;
    padding: 6px 4px; border-radius: var(--radius); border: 1px solid var(--border);
    background: var(--bg3); color: var(--text); cursor: pointer; font-family: inherit;
  }
  .nav-btn:hover { background: var(--border); }
  .nav-icon { font-size: 14px; line-height: 1; }
  .nav-label { font-size: 9px; color: var(--text2); }

  /* Box list */
  .box-header { font-size: 10px; font-weight: 700; color: var(--text2); text-transform: uppercase; letter-spacing: .06em; padding: 8px 8px 4px; }
  .box-list { flex: 1; overflow-y: auto; padding: 0 6px 6px; }
  .box-item { display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 6px; border-radius: 3px; border: 1px solid transparent; cursor: pointer; margin-bottom: 2px; background: transparent; color: var(--text); text-align: left; font-size: 12px; }
  .box-item:hover { background: var(--bg3); }
  .box-item.selected { background: var(--bg3); border-color: var(--accent); }
  .b-swatch { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
  .b-label { flex: 1; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .b-dims { font-size: 9px; color: var(--text2); flex-shrink: 0; }
  .b-del { color: var(--text2); font-size: 13px; padding: 0 2px; background: none; border: none; cursor: pointer; }
  .b-del:hover { color: var(--danger); }

  /* Autosave indicator */
  .autosave {
    display: flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 12px;
    border-top: 1px solid var(--border); flex-shrink: 0;
  }
  .autosave-dot {
    width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
    background: var(--success);
  }
  .autosave-text { font-size: 10px; color: var(--success); }
  .autosave.is-saving .autosave-dot { background: var(--danger); animation: blink 0.6s ease-in-out infinite; }
  .autosave.is-saving .autosave-text { color: var(--danger); }

  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.2; }
  }
</style>
