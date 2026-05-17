# TSIA — Toni's Simple Image Annotator

A small desktop app for drawing bounding boxes on images and exporting them
in COCO or YOLO format. Single user, no server, no telemetry, no cloud.
Built with [Tauri 2](https://tauri.app) and [SvelteKit](https://kit.svelte.dev).

> **Status**: early. Works, used in production by the author, but the
> feature surface is deliberately small.

## What it does

- Draw, edit, move, and resize axis-aligned bounding boxes on images.
- Up to 10 classes per project, each with a colour and a 1–9/0 keyboard
  shortcut.
- Import existing annotations from **COCO JSON** or **YOLO** label files
  when creating a project. A reconcile flow handles the case where your
  image set has drifted from what the annotations refer to.
- Export to **COCO JSON** or **YOLO** with cancellable progress.
- Optional **hardlink mode** on export — produces a dataset folder where
  each image is a hardlink rather than a copy, saving disk space on large
  datasets.
- Mark images as **reviewed** to track progress through a dataset. The
  progress bar in the annotate screen reflects this.
- Per-image **filters** (reviewed / unreviewed / unlabelled) so you can
  focus on what still needs work.
- **Autosave** with a 1-second debounce. No save button.
- **Undo** stack (50 steps).

It does *not* do segmentation, polygon annotation, rotated boxes,
multi-user collaboration, dataset versioning, training pipelines, or
inference. By design.

## Install

### Windows

Download the `.exe` from the [latest release](https://codeberg.org/professional-cynic/tsia/releases/latest)
and run it.

SmartScreen will probably warn you about an "unknown publisher" — that's
because the binary isn't code-signed (a code-signing certificate is
~$200/year and not worth it for a project this small). Click **More info
→ Run anyway**. After install, updates happen via an in-app banner; you
won't see the SmartScreen warning again until the next install.

### macOS (Apple Silicon)

Download the `.dmg` from [the latest release](https://codeberg.org/professional-cynic/tsia/releases/latest),
open it, drag the app to Applications.

On first launch, macOS will refuse to open it because it isn't signed by
an Apple Developer ID. To bypass: **right-click the app in Applications,
choose Open, then click Open in the dialog**. After that one time it
launches normally.

Intel Macs are not currently built. Open an issue if you need this.

### Linux

Download the `.AppImage`, make it executable, run:

```bash
chmod +x TSIA_*.AppImage
./TSIA_*.AppImage
```

Tested on Fedora and Ubuntu. WebKitGTK 4.1 is required (preinstalled on
most modern desktop distros).

### Updates

After the first install on any platform, TSIA checks for updates on
startup and shows a banner if one is available. Click **Install** to
download and apply, or **Later** to dismiss for the session.

## Build from source

You'd do this if you want to contribute, run a development version, or
just don't trust the binary releases.

Prerequisites:

- [Rust](https://rustup.rs) stable (edition 2021).
- [Node.js](https://nodejs.org) 20+.
- Platform-specific build tools — see [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/).
  In short: MSVC on Windows, Xcode CLI tools on macOS, WebKitGTK +
  libgtk + librsvg dev packages on Linux.

Then:

```bash
git clone https://codeberg.org/professional-cynic/tsia.git
cd tsia
npm install
npm run tauri dev      # hot-reload development build
npm run tauri build    # release binary in src-tauri/target/release/
```

First cold build takes a few minutes (Rust compiles a lot of crates).
Subsequent builds are 10–30 seconds. The dev mode is comfortable to iterate
in — Svelte changes hot-reload, Rust changes trigger a recompile.

## Project layout

```
src/                  Svelte frontend
  lib/
    components/         Screens, modals, canvas
    canvas/             Drawing geometry and rendering
    io/                 COCO/YOLO import + export wrappers
    stores/             Reactive app state (Svelte 5 runes)
    persistence.ts      Project save/load with schema validation
    updater.ts          In-app update check
src-tauri/            Rust backend
  src/
    lib.rs              Plugin registration, commands, setup
    export.rs           Dataset export (concurrent, cancellable)
    import.rs           COCO + YOLO label parsing
    fs_helpers.rs       Filesystem commands invoked by frontend
    opener_bridge.rs    URL allowlist for opening external links
  capabilities/         Tauri permission grants
.github/workflows/    GitHub Actions for releases
docs/                 Internal notes
```

## Releasing

See `docs/codeberg-mirror.md` for the one-time setup (Codeberg is
canonical; a push-mirror to GitHub triggers the release pipeline). Once
that's wired up, releasing is:

```bash
# Bump version in src-tauri/tauri.conf.json AND src-tauri/Cargo.toml
git commit -am "v0.1.2"
git tag v0.1.2
git push && git push --tags
```

GitHub Actions builds installers for all three platforms, drafts a
Release with them attached. Review the draft on GitHub, click Publish.
In-app updates roll out within minutes.

The updater requires a signing keypair generated once with
`cargo tauri signer generate`. The public key lives in
`src-tauri/tauri.conf.json`; the private key is a GitHub Actions secret
called `TAURI_SIGNING_PRIVATE_KEY`. **If you lose the private key**,
every existing install loses the ability to auto-update — back it up.

## Contributing

Issues and pull requests on [Codeberg](https://codeberg.org/professional-cynic/tsia),
please — the GitHub mirror has issues disabled.

Run `npm run check` (svelte-check) and `cargo check --manifest-path src-tauri/Cargo.toml`
before opening a PR. There's no formal test suite yet; this is a
weekend-project codebase.

## Licence

[AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html). In short: you may
use, study, modify, and redistribute the software, but if you run a
modified version on a network and let users interact with it remotely,
you must offer them the source. For a single-user desktop annotator this
clause never bites in practice; it matters if you ever wrap TSIA behind a
web service.

The image you annotate, the labels you produce, and the COCO/YOLO files
you export are all yours — the AGPL applies only to the program itself.
