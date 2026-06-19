<script lang="ts">
  import Titlebar from './Titlebar.svelte';
  import HomeScreen from './HomeScreen.svelte';
  import ProjectsScreen from './ProjectsScreen.svelte';
  import NewProjectScreen from './NewProjectScreen.svelte';
  import AnnotateScreen from './AnnotateScreen.svelte';
  import MergeScreen from './MergeScreen.svelte';
  import UpdateBanner from './UpdateBanner.svelte';
  import { app } from '$lib/stores/app.svelte';
  import { loadAllProjects } from '$lib/persistence';
  import { checkForUpdates } from '$lib/updater';
  import { onMount } from 'svelte';
  import type { Update } from '@tauri-apps/plugin-updater';

  let pendingUpdate = $state<Update | null>(null);

  onMount(async () => {
    app.projects = await loadAllProjects();
    if (app.projects.length > 0) app.screen = 'projects';
    // Fire-and-forget update check. If there's one, the banner appears
    // whenever the result arrives; users can install or dismiss.
    pendingUpdate = await checkForUpdates();
  });
</script>

<div class="app">
  <Titlebar />
  {#if pendingUpdate}
    <UpdateBanner update={pendingUpdate} ondismiss={() => pendingUpdate = null} />
  {/if}
  <div class="app-body">
    {#if app.screen === 'home'}
      <HomeScreen />
    {:else if app.screen === 'projects'}
      <ProjectsScreen />
    {:else if app.screen === 'new'}
      <NewProjectScreen />
    {:else if app.screen === 'annotate'}
      <AnnotateScreen />
    {:else if app.screen === 'merge'}
      <MergeScreen />
    {/if}
  </div>
</div>

<style>
  .app { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
  .app-body { flex: 1; display: flex; overflow: hidden; }
</style>
