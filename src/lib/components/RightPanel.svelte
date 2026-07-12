<script lang="ts">
  import { CLASS_COLORS } from '$lib/constants';
  import { app } from '$lib/stores/app.svelte';
  import { measureLengthPx } from '$lib/types';

  let boxes = $derived(app.current?.images[app.imgIndex]?.boxes ?? []);
  let measuredCount = $derived(boxes.filter(b => b.measure).length);
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

  {#if app.measureMode}
    <div class="measure-banner">
      <div class="mb-title">Measure mode</div>
      <div class="measure-hint">click a box, then drag to measure. M to exit.</div>
      <label class="pitch-row" class:unset={!app.current?.pixelPitch}>
        <span class="pitch-label">mm / pixel</span>
        <input class="pitch-input" type="text" inputmode="decimal"
          placeholder="not set"
          value={app.current?.pixelPitch ?? ''}
          onchange={(e) => {
            const v = parseFloat(e.currentTarget.value);
            app.setPixelPitch(Number.isFinite(v) && v > 0 ? v : undefined);
          }} />
      </label>
      {#if !app.current?.pixelPitch}
        <div class="pitch-note">Set this to see lengths in mm. Measurements are stored in
        pixels, so entering it later converts everything you've already measured.</div>
      {/if}
    </div>
  {/if}

  <!-- Box list. In measure mode this becomes the measurement list. -->
  {#if app.measureMode}
    <div class="box-header measure-header">
      Measurements ({measuredCount}/{boxes.length})
    </div>
    <div class="box-list">
      {#each boxes as box, i (box.id)}
        {@const color = CLASS_COLORS[box.classIdx] || '#fff'}
        {@const label = app.current?.classes[box.classIdx] || 'unknown'}
        {@const inSel = box.id === app.selectedBox}
        {@const mm = app.measurementMm(box)}
        <div class="box-item measure-item" class:selected={inSel}
          onclick={() => app.selectSingle(box.id)}
          onkeydown={(e) => { if (e.key === 'Enter') app.selectSingle(box.id); }}
          role="button" tabindex="0">
          <div class="m-top">
            <div class="b-swatch" style:background={color}></div>
            <span class="b-label">{i + 1}. {label}</span>
            {#if box.measure}
              <button class="b-del" title="Clear measurement"
                onclick={(e) => { e.stopPropagation(); app.clearMeasurement(box.id); }}>✕</button>
            {/if}
          </div>
          {#if box.measure}
            <span class="b-measure">
              {#if mm !== null}
                {measureLengthPx(box.measure).toFixed(1)} px ({mm.toFixed(2)} mm)
              {:else}
                {measureLengthPx(box.measure).toFixed(1)} px
              {/if}
            </span>
          {:else}
            <span class="b-unmeasured">not measured</span>
          {/if}
        </div>
      {/each}
    </div>
  {:else}
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
  {/if}

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

  /* Measure mode */
  .measure-banner {
    padding: 8px; background: var(--bg3); border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .mb-title {
    font-size: 10px; font-weight: 700; color: var(--accent);
    text-transform: uppercase; letter-spacing: .06em;
  }
  .measure-hint { font-size: 9px; color: var(--text2); margin-top: 2px; line-height: 1.4; }
  .pitch-row { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
  .pitch-label { font-size: 9px; color: var(--text2); flex-shrink: 0; }
  .pitch-input {
    flex: 1; min-width: 0; background: var(--bg2); border: 1px solid var(--border);
    border-radius: 3px; color: var(--text); font-family: inherit; font-size: 10px;
    padding: 3px 5px;
  }
  .pitch-row.unset .pitch-input { border-color: var(--accent); }
  .pitch-note { font-size: 9px; color: var(--text2); margin-top: 4px; line-height: 1.4; }
  .b-measure { font-size: 9px; color: var(--text); flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .b-unmeasured { font-size: 9px; color: var(--text2); flex-shrink: 0; font-style: italic; }
  .measure-item { flex-direction: column; align-items: stretch; gap: 2px; }
  .m-top { display: flex; align-items: center; gap: 6px; }
  .measure-item .b-measure, .measure-item .b-unmeasured { padding-left: 14px; }

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
