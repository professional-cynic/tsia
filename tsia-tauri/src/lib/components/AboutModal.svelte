<script lang="ts">
  import { getVersion } from '@tauri-apps/api/app';
  import { invoke } from '@tauri-apps/api/core';
  import { onMount } from 'svelte';

  let { onclose }: { onclose: () => void } = $props();

  let version = $state('');
  let openError = $state('');

  onMount(async () => {
    try { version = await getVersion(); } catch { version = '?'; }
  });

  // Open a URL via the Rust opener bridge. Same pattern as HomeScreen — the
  // allowlist on the Rust side is the security gate; everything here just
  // formats the call.
  async function open(url: string) {
    openError = '';
    try {
      await invoke('open_external_url', { url });
    } catch (e) {
      openError = `Could not open ${url}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
</script>

<svelte:window onkeydown={(e) => {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onclose(); }
}} />

<div class="backdrop" role="presentation"
  onclick={(e) => { if (e.target === e.currentTarget) onclose(); }}>
  <div class="modal" role="dialog" aria-modal="true" aria-label="About" tabindex="-1">
    <div class="modal-title">Toni's Simple Image Annotator</div>
    <div class="modal-version">Version {version || '\u2026'}</div>
    <div class="modal-body">
      Bounding-box annotator for image datasets. Imports and exports COCO
      and YOLO formats. Single-user desktop app, no server, no telemetry.
    </div>
    <div class="modal-links">
      <button class="link" onclick={() => open('https://codeberg.org/professional-cynic/tsia')}>Source code &amp; README</button>
      <button class="link" onclick={() => open('https://codeberg.org/professional-cynic')}>professional-cynic</button>
      <button class="link" onclick={() => open('https://www.gnu.org/licenses/agpl-3.0.html')}>Licensed under AGPL-3.0</button>
    </div>
    {#if openError}
      <div class="modal-error">{openError}</div>
    {/if}
    <div class="modal-actions">
      <button onclick={onclose}>Close</button>
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
    padding: 20px; min-width: 360px; max-width: 460px; text-align: left;
  }
  .modal-title { font-size: 14px; font-weight: 700; margin-bottom: 4px; color: var(--accent); }
  .modal-version { font-size: 11px; color: var(--text2); margin-bottom: 12px; }
  .modal-body { font-size: 12px; color: var(--text2); margin-bottom: 16px; line-height: 1.5; }
  .modal-links { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
  .modal-error { font-size: 11px; color: var(--danger); margin-bottom: 12px; word-break: break-word; }
  .modal-actions { display: flex; justify-content: flex-end; }
  .link { background: none; border: none; color: var(--text2); text-decoration: underline; cursor: pointer; font-size: 11px; padding: 0; font-family: inherit; text-align: left; }
  .link:hover { color: var(--text); }
</style>
