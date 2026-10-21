import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { app } from '$lib/stores/app.svelte';

/// Matches CLOSE_REQUESTED_EVENT in src-tauri/src/lib.rs.
const CLOSE_REQUESTED_EVENT = 'tsia://close-requested';

/// Flush any pending autosave, then close the window. destroy() force-closes
/// immediately (requires the core:window:allow-destroy capability, separate
/// from allow-close), so the flush must finish first.
export async function flushAndClose(): Promise<void> {
  try {
    await app.flushSave();
  } finally {
    await getCurrentWindow().destroy();
  }
}

/// Closing from the OS (Alt+F4, Cmd+Q, taskbar) is intercepted in Rust, which
/// holds the window open and emits an event so we can flush first. Rust closes
/// the window anyway after a few seconds if we never answer.
export function handleCloseRequests(): Promise<UnlistenFn> {
  return listen(CLOSE_REQUESTED_EVENT, () => { void flushAndClose(); });
}
