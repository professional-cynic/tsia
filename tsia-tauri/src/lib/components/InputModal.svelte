<script lang="ts">
  import { onMount } from 'svelte';

  let { title = 'Input', placeholder = '', defaultValue = '', onconfirm, oncancel }: {
    title?: string;
    placeholder?: string;
    defaultValue?: string;
    onconfirm: (value: string) => void;
    oncancel: () => void;
  } = $props();

  let value = $state('');
  let inputEl: HTMLInputElement;

  onMount(() => {
    value = defaultValue;
    inputEl?.focus();
    inputEl?.select();
  });

  function handleInputKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && value.trim()) { e.preventDefault(); e.stopPropagation(); onconfirm(value.trim()); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); oncancel(); }
  }
</script>

<div class="backdrop" role="presentation" onclick={oncancel}>
  <div class="modal" role="dialog" aria-modal="true" aria-label={title} tabindex="-1" onclick={(e) => e.stopPropagation()}>
    <div class="modal-title">{title}</div>
    <input
      bind:this={inputEl}
      type="text"
      bind:value={value}
      {placeholder}
      onkeydown={handleInputKeydown}
    />
    <div class="modal-actions">
      <button onclick={oncancel}>Cancel</button>
      <button class="btn-primary" onclick={() => value.trim() && onconfirm(value.trim())} disabled={!value.trim()}>OK</button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.5); z-index: 200;
    display: flex; align-items: center; justify-content: center;
  }
  .modal {
    background: var(--bg2); border: 1px solid var(--border); border-radius: 8px;
    padding: 20px; min-width: 320px; max-width: 400px; text-align: left;
  }
  .modal-title { font-size: 13px; font-weight: 700; margin-bottom: 12px; }
  .modal input { margin-bottom: 16px; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
