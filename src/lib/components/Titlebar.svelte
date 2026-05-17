<script lang="ts">
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { app } from '$lib/stores/app.svelte';

  const appWindow = getCurrentWindow();

  // destroy() force-closes immediately; we flush any pending autosave first
  // so the close-during-debounce window can't lose edits. close-requested
  // doesn't reliably fire from JS in Tauri 2, hence the manual flush rather
  // than routing through close() + an event handler.
  // Requires the core:window:allow-destroy capability — separate from
  // allow-close, easy to miss.
  async function close() {
    await app.flushSave();
    await appWindow.destroy();
  }
  async function minimize() { await appWindow.minimize(); }
</script>

<div class="titlebar" data-tauri-drag-region>
  <button class="titlebar-title" data-tauri-drag-region="false" onclick={async () => { await app.flushSave(); app.screen = 'home'; }} title="Home">
    Toni's Simple Image Annotator
  </button>
  <span class="titlebar-spacer" data-tauri-drag-region></span>
  <div class="titlebar-controls" data-tauri-drag-region="false">
    <button class="titlebar-btn" onclick={minimize} title="Minimise">─</button>
    <button class="titlebar-btn titlebar-close" onclick={close} title="Close">✕</button>
  </div>
</div>

<style>
  .titlebar {
    display: flex;
    align-items: center;
    height: 32px;
    padding: 0 12px;
    background: var(--bg2);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .titlebar-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--text2);
    letter-spacing: 0.04em;
    background: none;
    border: none;
    padding: 0 6px;
    height: 24px;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
  }
  .titlebar-title:hover { color: var(--text); background: var(--bg3); }
  .titlebar-spacer { flex: 1; height: 100%; }
  .titlebar-controls {
    display: flex;
    gap: 2px;
  }
  .titlebar-btn {
    width: 28px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    color: var(--text2);
    font-size: 11px;
    border-radius: 4px;
    cursor: pointer;
    padding: 0;
  }
  .titlebar-btn:hover { background: var(--bg3); color: var(--text); }
  .titlebar-close:hover { background: var(--danger); color: #fff; }
</style>
