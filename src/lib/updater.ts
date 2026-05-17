// Updater: checks for a newer version, returns the Update handle so a UI
// component can prompt the user. Banner-driven flow rather than silent
// install — the in-progress install would interrupt mid-session work, and
// "install on next launch" semantics aren't reliably supported by the
// Tauri NSIS updater without managing the staged binary ourselves.
//
// The Tauri updater plugin verifies the signature before install, so a
// tampered binary won't apply. Failures are non-fatal — the caller should
// treat null as "no update available, carry on".

import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

/// Returns the pending Update if a newer version is available, else null.
/// Silently swallows network/signature errors — the user's existing
/// version keeps working.
export async function checkForUpdates(): Promise<Update | null> {
  try {
    const update = await check();
    return update?.available ? update : null;
  } catch {
    return null;
  }
}

/// Download and install the update, then relaunch the app. Throws on
/// failure so the caller can surface an error to the user.
export async function installUpdate(update: Update): Promise<void> {
  await update.downloadAndInstall();
  // On NSIS, downloadAndInstall exits the process itself; this relaunch
  // is mostly here for the macOS and Linux paths where it doesn't.
  await relaunch();
}



