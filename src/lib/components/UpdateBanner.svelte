<script lang="ts">
  import { installUpdate } from '$lib/updater';
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
      // installUpdate relaunches; anything after this is only reached on
      // platforms where relaunch doesn't actually exit (shouldn't happen).
    } catch (e) {
      installing = false;
      error = e instanceof Error ? e.message : String(e);
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
  .actions { display: flex; gap: 6px; }
  .actions button { font-size: 11px; padding: 3px 10px; }
</style>
