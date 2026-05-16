<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  let { children } = $props();

  onMount(() => {
    const appWindow = getCurrentWindow();

    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    const onKeyDown = async (e: KeyboardEvent) => {
      if (e.key === 'F11') {
        e.preventDefault();
        const isFullscreen = await appWindow.isFullscreen();
        await appWindow.setFullscreen(!isFullscreen);
      }
    };

    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('keydown', onKeyDown);
    };
  });
</script>

{@render children()}
