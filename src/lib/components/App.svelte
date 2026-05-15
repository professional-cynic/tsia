<script lang="ts">
  import Titlebar from './Titlebar.svelte';
  import HomeScreen from './HomeScreen.svelte';
  import ProjectsScreen from './ProjectsScreen.svelte';
  import NewProjectScreen from './NewProjectScreen.svelte';
  import AnnotateScreen from './AnnotateScreen.svelte';
  import { app } from '$lib/stores/app.svelte';
  import { loadAllProjects } from '$lib/persistence';
  import { onMount } from 'svelte';
  import { getCurrentWindow } from '@tauri-apps/api/window';

  onMount(async () => {
    app.projects = await loadAllProjects();
    if (app.projects.length > 0) app.screen = 'projects';

    // Flush any debounced save before the window actually closes. Without
    // this, closing within the autosave debounce window loses up to one
    // second of work.
    const w = getCurrentWindow();
    const unlisten = await w.onCloseRequested(async (event) => {
      event.preventDefault();
      try { await app.flushSave(); } catch { /* still close on save failure */ }
      await w.destroy();
    });
    return () => unlisten();
  });
</script>

<div class="app">
  <Titlebar />
  <div class="app-body">
    {#if app.screen === 'home'}
      <HomeScreen />
    {:else if app.screen === 'projects'}
      <ProjectsScreen />
    {:else if app.screen === 'new'}
      <NewProjectScreen />
    {:else if app.screen === 'annotate'}
      <AnnotateScreen />
    {/if}
  </div>
</div>

<style>
  .app { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
  .app-body { flex: 1; display: flex; overflow: hidden; }
</style>
