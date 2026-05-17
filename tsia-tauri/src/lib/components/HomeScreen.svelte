<script lang="ts">
  import { app } from '$lib/stores/app.svelte';
  import { invoke } from '@tauri-apps/api/core';
  import AboutModal from './AboutModal.svelte';

  let openError = $state('');
  let showAbout = $state(false);

  async function open(url: string) {
    openError = '';
    try {
      await invoke('open_external_url', { url });
    } catch (e) {
      openError = `Could not open ${url}: ${e instanceof Error ? e.message : String(e)}`;
      console.error('open_external_url failed:', e);
    }
  }
</script>

<div class="home">
  <div class="home-logo">TONI'S SIMPLE IMAGE ANNOTATOR</div>
  <div class="home-sub">Bounding box annotation with COCO and YOLO import/export.</div>
  <div class="home-actions">
    <button class="btn-primary" onclick={() => app.screen = 'new'}>+ New Project</button>
    <button onclick={() => app.screen = 'projects'}>Open Projects</button>
  </div>
  {#if openError}
    <div class="home-error">{openError}</div>
  {/if}
  <div class="home-footer">
    © 2026 <button class="link" onclick={() => open('https://codeberg.org/professional-cynic')}>professional-cynic</button>
    · <button class="link" onclick={() => open('https://www.gnu.org/licenses/agpl-3.0.html')}>AGPL-3.0</button>
  </div>
  <div class="home-about">
    <button class="link" onclick={() => showAbout = true}>About</button>
  </div>
</div>

{#if showAbout}
  <AboutModal onclose={() => showAbout = false} />
{/if}

<style>
  .home { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; }
  .home-logo { font-size: 28px; font-weight: 800; letter-spacing: .1em; color: var(--accent); }
  .home-sub { font-size: 12px; color: var(--text2); text-align: center; max-width: 420px; line-height: 1.6; }
  .home-actions { display: flex; gap: 10px; }
  .home-error { font-size: 11px; color: var(--danger); max-width: 520px; text-align: center; word-break: break-word; }
  .home-footer { margin-top: 32px; font-size: 10px; color: var(--text2); }
  .home-about { margin-top: 6px; font-size: 10px; }
  .link { background: none; border: none; color: var(--text2); text-decoration: underline; cursor: pointer; font-size: 10px; padding: 0; font-family: inherit; }
  .link:hover { color: var(--text); }
</style>
