<script lang="ts">
  let { value = $bindable(''), options, label = '' }: {
    value: string;
    options: { value: string; label: string }[];
    label?: string;
  } = $props();

  let isOpen = $state(false);
  let buttonEl: HTMLButtonElement;

  function select(v: string) {
    value = v;
    isOpen = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { isOpen = false; e.stopPropagation(); }
  }

  let selectedLabel = $derived(options.find(o => o.value === value)?.label ?? '');
</script>

<svelte:window onclick={() => isOpen = false} onkeydown={handleKeydown} />

<div class="select-wrap">
  <button
    class="select-btn"
    bind:this={buttonEl}
    onclick={(e) => { e.stopPropagation(); isOpen = !isOpen; }}
  >
    <span class="select-label">{selectedLabel}</span>
    <span class="select-arrow">▾</span>
  </button>
  {#if isOpen}
    <div class="select-dropdown">
      {#each options as opt}
        <button
          class="select-option"
          class:active={opt.value === value}
          onclick={(e) => { e.stopPropagation(); select(opt.value); }}
        >
          {opt.label}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .select-wrap { position: relative; margin-bottom: 4px; }
  .select-btn {
    width: 100%; padding: 5px 8px; border-radius: var(--radius);
    border: 1px solid var(--border); background: var(--bg);
    color: var(--text); font-size: 12px; font-family: inherit;
    display: flex; align-items: center; cursor: pointer; text-align: left;
  }
  .select-btn:hover { border-color: var(--text2); }
  .select-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .select-arrow { font-size: 9px; color: var(--text2); margin-left: 4px; flex-shrink: 0; }
  .select-dropdown {
    position: absolute; top: 100%; left: 0; right: 0;
    background: var(--bg2); border: 1px solid var(--border);
    border-radius: var(--radius); margin-top: 2px;
    z-index: 50; max-height: 200px; overflow-y: auto;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  }
  .select-option {
    width: 100%; padding: 5px 8px; border: none;
    background: transparent; color: var(--text);
    font-size: 12px; font-family: inherit; cursor: pointer;
    text-align: left; display: block;
  }
  .select-option:hover { background: var(--bg3); }
  .select-option.active { background: var(--accent); color: #000; }
</style>
