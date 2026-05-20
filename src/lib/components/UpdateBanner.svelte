<script lang="ts">
  import { installUpdate } from '$lib/updater';
  import { invoke } from '@tauri-apps/api/core';
  import type { Update } from '@tauri-apps/plugin-updater';

  let { update, ondismiss }: {
    update: Update;
    ondismiss: () => void;
  } = $props();

  let installing = $state(false);
  let error = $state('');

  async function install() {
    installing = true;
    error = '';
    try {
      await installUpdate(update);
    } catch (e) {
      installing = false;
      error = e instanceof Error ? e.message : String(e);
    }
  }

  // Opens the GitHub releases page. The /latest/ slug always resolves to
  // the most recent release, which is the one we're prompting about. Avoids
  // having to allowlist every per-version release URL on the Rust side.
  async function viewNotes() {
    try {
      await invoke('open_external_url', { url: 'https://github.com/professional-cynic/tsia/releases/latest' });
    } catch {
      /* Banner stays open; user can still install. */
    }
  }
</script>

<div class="update-banner" role="status">
  <span class="msg">
    {#if error}
      Update failed: {error}
    {:else if installing}
      Installing update {update.version}…
    {:else}
      Update available: version {update.version}
    {/if}
  </span>
  {#if !installing}
    <div class="actions">
      <button class="link" onclick={viewNotes}>What's changed</button>
      <button class="btn-primary" onclick={install}>Install</button>
      <button onclick={ondismiss}>Later</button>
    </div>
  {/if}
</div>

<style>
  .update-banner {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 12px; background: var(--accent); color: #000;
    font-size: 11px; gap: 12px;
  }
  .msg { flex: 1; }
  .actions { display: flex; gap: 6px; align-items: center; }
  .actions button { font-size: 11px; padding: 3px 10px; }
  .actions .link {
    background: none; border: none; padding: 0 4px;
    color: #000; text-decoration: underline; cursor: pointer;
    font-size: 11px; font-family: inherit;
  }
  .actions .link:hover { opacity: 0.7; }
</style>
