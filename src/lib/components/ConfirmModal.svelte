<script lang="ts">
  import { onMount } from 'svelte';

  let { title = 'Confirm', message = '', onconfirm, oncancel }: {
    title?: string;
    message: string;
    onconfirm: () => void;
    oncancel: () => void;
  } = $props();

  let confirmBtn: HTMLButtonElement;
  onMount(() => confirmBtn?.focus());
</script>

<svelte:window onkeydown={(e) => {
  if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onconfirm(); }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); oncancel(); }
}} />

<div class="backdrop" role="presentation" onclick={oncancel}>
  <div class="modal" role="dialog" aria-modal="true" aria-label={title} tabindex="-1" onclick={(e) => e.stopPropagation()}>
    <div class="modal-title">{title}</div>
    <div class="modal-message">{message}</div>
    <div class="modal-actions">
      <button onclick={oncancel}>Cancel</button>
      <button class="btn-danger" bind:this={confirmBtn} onclick={onconfirm}>Confirm</button>
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
  .modal-title { font-size: 13px; font-weight: 700; margin-bottom: 8px; }
  .modal-message { font-size: 12px; color: var(--text2); margin-bottom: 16px; line-height: 1.5; white-space: pre-line; word-break: break-word; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
