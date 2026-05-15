# Toni's Simple Image Annotator

A browser-based bounding box annotation tool. No server, no install, no build step. Open `annotator.html` and start labelling.

## Quick Start

1. Open `annotator.html` in Chrome or Edge (requires File System Access API).
2. Create a new project — give it a name, load an image folder, define your classes.
3. Draw bounding boxes on images. Export to COCO JSON or YOLO when done.

Everything is stored in `localStorage` and `IndexedDB`, so your work persists across browser sessions. To move to another machine, use **Save** / **Import Project JSON**.

## Project Structure

```
tsia/
├── annotator.html       Single-file build (double-click to run)
├── build.js             Rebuilds annotator.html from modules
├── index.html           Modular version (needs local server)
├── style.css
├── README.md
└── js/
    ├── main.js          Entry point
    ├── constants.js     Colours, storage keys, config
    ├── state.js         App state + annotation state
    ├── storage.js       localStorage + IndexedDB
    ├── screens.js       Screen switching
    ├── projects.js      Project CRUD, list, open, reload folder
    ├── import.js        New project form, COCO/YOLO/JSON import
    ├── export.js        COCO/YOLO/JSON export
    ├── annotate-ui.js   Sidebar, class list, image list, box list, filters
    ├── canvas.js        Rendering, coordinate maths, hit testing, zoom
    ├── navigation.js    Image loading, prev/next, back/forward history
    ├── interaction.js   Mouse events, keyboard shortcuts, pan
    ├── boxes.js         Box CRUD, undo, copy, class reassignment
    └── utils.js         downloadJSON, hexToRgba, loadImageDims
```

## Development

Edit the modules in `js/`, then run `node build.js` to regenerate `annotator.html`. The modular version (`index.html`) requires a local server (e.g. `python3 -m http.server`).

## Features

- Bounding box annotation with up to 9 classes, colour-coded, addable during annotation.
- COCO JSON and YOLO import/export (YOLO includes `data.yaml` and `labels/` structure).
- Project JSON save/load for full portability.
- Independent filters for annotation status, review status, and class.
- Auto-review on view. Press X to flag for re-review. Progress bar shows coverage.
- Undo per image (50-step). Copy boxes from previous image for sequential frames.
- Class reassignment on selected boxes via number keys.
- Browser-like back/forward navigation history.
- Zoom (scroll), pan (middle-click drag), toggleable crosshair (H).
- Box dimensions on canvas and in box list.

## Keyboard Shortcuts

| Key | Action |
|---|---|
| A / D | Prev / Next image (arrows also work) |
| 1–9 | Set active class, or reassign selected box |
| C | Copy boxes from previous image |
| X | Flag image for re-review |
| H | Toggle crosshair |
| Z | Undo (Ctrl+Z also works) |
| Del | Delete selected box, or last box if none selected |
| Esc | Deselect |
| Scroll | Zoom |
| Middle drag | Pan |

## Image Status

- Grey dot — not reviewed
- Green dot — reviewed
- Orange dot — needs re-review

## Browser Requirements

Requires the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API): Chrome, Edge, Brave, Arc. Not supported in Firefox or Safari.

## Licence

© 2026 [professional-cynic](https://codeberg.org/professional-cynic)

Licensed under the [GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html) (AGPL-3.0).
