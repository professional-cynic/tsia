<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  let { children } = $props();

  onMount(() => {
    document.addEventListener('contextmenu', (e) => e.preventDefault());

    const appWindow = getCurrentWindow();
    document.addEventListener('keydown', async (e) => {
      if (e.key === 'F11') {
        e.preventDefault();
        const isFullscreen = await appWindow.isFullscreen();
        await appWindow.setFullscreen(!isFullscreen);
      }
    });
  });
</script>

{@render children()}
