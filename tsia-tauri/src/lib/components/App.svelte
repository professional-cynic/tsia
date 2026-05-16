<script lang="ts">
  import Titlebar from './Titlebar.svelte';
  import HomeScreen from './HomeScreen.svelte';
  import ProjectsScreen from './ProjectsScreen.svelte';
  import NewProjectScreen from './NewProjectScreen.svelte';
  import AnnotateScreen from './AnnotateScreen.svelte';
  import { app } from '$lib/stores/app.svelte';
  import { loadAllProjects } from '$lib/persistence';
  import { onMount } from 'svelte';

  onMount(async () => {
    app.projects = await loadAllProjects();
    if (app.projects.length > 0) app.screen = 'projects';
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
