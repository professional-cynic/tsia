# Review changes — tsia-tauri

This pass kept the existing structure intact. The code was already lean and
well-organised; the changes target real bugs and one genuine security issue.
No file was rewritten; every edit is local.

## Security

**Asset protocol scope, narrowed.** `tauri.conf.json` had
`assetProtocol.scope: ["**/*"]`, meaning any HTML/JS running in the webview
could load any file the OS user can read (SSH keys, browser data, etc.) via
`convertFileSrc`. Static scope is now empty (`allow: []`); per-project image
folders are added to the asset scope at runtime by a new Rust command
`allow_asset_dir`, called from the frontend immediately after the user picks
a folder via a dialog (the moment that grants legitimacy). Session-scoped
only — restart wipes the allowlist.

Files: `src-tauri/tauri.conf.json`, `src-tauri/src/fs_helpers.rs` (new
command), `src-tauri/src/lib.rs` (handler registration),
`src/lib/io/import.ts` (frontend wrapper), and the four call sites in
`ProjectsScreen.svelte` (open, clean-relocate, post-reconcile) and
`NewProjectScreen.svelte` (create).

## Bugs

- **Drag tracking past the canvas edge.** `mousemove` was on the canvas
  element while `mouseup` was on `window`; fast cursor sweeps off the canvas
  left a box in its old position until release. Moved `mousemove` to
  `window` and added a short-circuit so it only does work when there's an
  active drag/pan/draw. `CanvasArea.svelte`.

- **Close-during-debounce loses pending saves.** The titlebar close button
  calls `appWindow.destroy()` immediately. Now it awaits `app.flushSave()`
  first, which runs the pending autosave if any. `Titlebar.svelte`.

## Hygiene

- **Layout listeners leaked.** `routes/+layout.svelte` registered F11 and
  contextmenu handlers without a cleanup return. Harmless in this SPA but
  set a bad pattern; fixed with explicit removal in the teardown.

- **Dead code.** Removed unused `label` prop and `buttonEl` binding from
  `Select.svelte`.

- **Open-coded review toggle.** `Sidebar.svelte`'s row-dblclick handler
  duplicated the toggle logic in the store. Added `toggleReviewedFor(img)`
  to the store and called that.

- **Loose typing.** `importedAnnotations` in `NewProjectScreen.svelte` was
  typed `Record<string, any[]>`; replaced with `Record<string,
  ImportedAnnotation[]>` using the existing interface.

## Not changed (intentionally)

- Date math in `export.rs` (Hinnant civil-from-days — correct, leave alone).
- Boxed recursion in `scan` / `scan_yolo_dir` — verbose but correct.
- The 8-permit semaphore for export concurrency.
- The fs scope restriction to `$APPDATA/projects` (already correct).
- The opener URL allowlist (already correct, mirrored Rust/capability sides).
- All comments documenting *why* (mostly kept verbatim).

## Flagged but not changed

- **Magic 'defect' class clearing** in `NewProjectScreen.svelte` (lines 48,
  63 before edit). If a user names a class `defect` and then imports COCO,
  their class is silently dropped. Edge case; would want a confirmation
  before changing the logic.

- The AGPL-3.0 licence's network clause only matters if the app is bundled
  behind a web service. Not relevant for a desktop annotator.

## Verification

- Standalone TypeScript check (`tsc --noEmit`) against the `.ts` files
  passes with rune-aware ambient types. No Tauri/Cargo toolchain was
  available in this environment, so the Rust side and `.svelte` templates
  were not actually compiled. Worth a real `cargo check` and `svelte-check`
  before shipping.
