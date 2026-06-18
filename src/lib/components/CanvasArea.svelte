<script lang="ts">
  import { onMount } from 'svelte';
  import { convertFileSrc } from '@tauri-apps/api/core';
  import { join } from '@tauri-apps/api/path';
  import { app } from '$lib/stores/app.svelte';
  import { renderCanvas } from '$lib/canvas/render';
  import { clientToImage, clampToImage, clampBox, hitTestBox, hitTestHandle, applyHandleDrag } from '$lib/canvas/geometry';

  let canvasEl: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D;
  let loadedImage: HTMLImageElement | null = $state(null);
  let panStart: { x: number; y: number; ox: number; oy: number } | null = null;
  // Transient drag/resize preview. During an active drag we update this
  // local state at mousemove rate; the store's box is only mutated on
  // mouseup. This keeps the reactive cascade (filteredImages →
  // visibleImages → sidebar re-render) from firing on every frame.
  let dragPreview: { boxId: number; x: number; y: number; w: number; h: number } | null = $state(null);
  // Group drag: when the mousedown lands on a box that's part of a
  // multi-selection, we move the whole set. startImgX/Y is the grab point;
  // groupPreview holds the live (clamped) delta for rendering; bounds is the
  // clamp range computed once at grab time.
  let groupDrag: { startImgX: number; startImgY: number; undoSnapshot: ReturnType<typeof app.snapshotBoxes> } | null = null;
  let groupPreview: { dx: number; dy: number } | null = $state(null);
  let groupBounds: { minDx: number; maxDx: number; minDy: number; maxDy: number } | null = null;

  function doRender() {
    if (!canvasEl || !ctx || !loadedImage || !app.current) return;
    const entry = app.current.images[app.imgIndex];
    if (!entry) return;
    renderCanvas({
      canvas: canvasEl, ctx, image: loadedImage,
      imageEntry: entry,
      zoom: app.zoom, offsetX: app.offsetX, offsetY: app.offsetY,
      selectedBox: app.selectedBox, selectedBoxes: app.selectedBoxes, activeClass: app.activeClass,
      drawing: app.drawing, classes: app.current.classes,
      dragOverride: dragPreview,
      groupOffset: groupPreview,
    });
  }

  $effect(() => {
    const img = app.current?.images[app.imgIndex];
    // Switching image (or having none): drop the old bitmap and wipe the
    // canvas immediately. The box state has already switched, so leaving the
    // old bitmap up would briefly show the new image's boxes over the old
    // image. Clearing now means the load gap shows blank, not a mismatch.
    loadedImage = null;
    clearCanvas();
    if (!img || !app.current) return;

    const dirPath = app.current.imageDirPath;
    const filename = img.filename;
    let cancelled = false;
    (async () => {
      const src = convertFileSrc(await join(dirPath, filename));
      const el = new Image();
      el.onload = () => {
        if (cancelled) return;
        loadedImage = el;
        // Cache dims so export doesn't need to re-decode.
        img.dims = { w: el.naturalWidth, h: el.naturalHeight };
        fitToView(el);
        doRender();
      };
      el.onerror = () => { if (!cancelled) loadedImage = null; };
      el.src = src;
    })();
    return () => { cancelled = true; };
  });

  function clearCanvas() {
    if (!canvasEl || !ctx) return;
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  }

  // Re-render on any visual state change, but gate on requestAnimationFrame
  // so a flurry of mousemove updates within one frame coalesces into a
  // single draw. On large images, ctx.drawImage dominates the frame cost;
  // calling it 100+ times per second was the stutter source.
  let rafScheduled = false;
  function scheduleRender() {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      doRender();
    });
  }
  $effect(() => {
    app.zoom; app.offsetX; app.offsetY;
    app.selectedBox; app.selectedBoxes; app.activeClass;
    app.drawing; app.drag;
    // Touch the boxes array AND each box's classIdx, so a class
    // reassignment on the selected box (which doesn't change the
    // array shape) still re-fires the effect. Other coordinate
    // mutations are handled either by dragPreview (during drag) or
    // by add/remove which changes the array length.
    const boxes = app.current?.images[app.imgIndex]?.boxes;
    if (boxes) for (const b of boxes) { b.classIdx; }
    dragPreview;
    groupPreview;
    scheduleRender();
  });

  let baseZoom = $state(1); // the zoom level at which image fills the view (= 100%)

  function fitToView(img: HTMLImageElement) {
    if (!canvasEl) return;
    const ww = canvasEl.clientWidth, wh = canvasEl.clientHeight;
    const scale = Math.min(ww / img.naturalWidth, wh / img.naturalHeight);
    baseZoom = scale;
    app.zoom = scale;
    app.offsetX = (ww - img.naturalWidth * scale) / 2;
    app.offsetY = (wh - img.naturalHeight * scale) / 2;
  }

  function handleMouseDown(e: MouseEvent) {
    if (e.button === 1) { panStart = { x: e.clientX, y: e.clientY, ox: app.offsetX, oy: app.offsetY }; e.preventDefault(); return; }
    if (e.button !== 0 || !loadedImage || !app.current) return;
    e.preventDefault();
    const img = app.current.images[app.imgIndex];
    const [ix, iy] = clientToImage(e.clientX, e.clientY, canvasEl, app.offsetX, app.offsetY, app.zoom);

    if (app.selectedBox !== null && !e.shiftKey) {
      const selBox = img.boxes.find(b => b.id === app.selectedBox);
      if (selBox) {
        const hi = hitTestHandle(ix, iy, selBox, app.zoom);
        if (hi >= 0) {
          app.drag = { type: 'handle', handleIdx: hi, boxId: selBox.id, startImgX: ix, startImgY: iy, origBox: { ...selBox }, undoSnapshot: app.snapshotBoxes(img.boxes) };
          return;
        }
      }
    }

    for (let i = img.boxes.length - 1; i >= 0; i--) {
      const box = img.boxes[i];
      if (hitTestBox(ix, iy, box)) {
        if (e.shiftKey) {
          // Toggle this box in the multi-selection; don't start a drag.
          app.toggleInSelection(box.id);
          return;
        }
        // Grabbing a box that's part of a multi-selection moves the whole
        // group (no modifier needed, like Figma/PowerPoint). Grabbing any
        // other box collapses to a single selection and single-box drag.
        if (app.selectedBoxes.size > 1 && app.selectedBoxes.has(box.id)) {
          groupDrag = { startImgX: ix, startImgY: iy, undoSnapshot: app.snapshotBoxes(img.boxes) };
          groupBounds = app.groupClampBounds();
          groupPreview = { dx: 0, dy: 0 };
          return;
        }
        app.selectSingle(box.id);
        app.drag = { type: 'move', boxId: box.id, startImgX: ix, startImgY: iy, origBox: { ...box }, undoSnapshot: app.snapshotBoxes(img.boxes) };
        return;
      }
    }

    // Click on empty space clears selection (unless Shift is held, so a
    // mis-click during multi-select doesn't wipe the set) and starts a draw.
    if (!e.shiftKey) app.clearSelection();
    const [cx, cy] = clampToImage(ix, iy, loadedImage.naturalWidth, loadedImage.naturalHeight);
    app.drawing = { startX: cx, startY: cy, x: cx, y: cy, w: 0, h: 0 };
  }

  function handleMouseMove(e: MouseEvent) {
    if (panStart) { app.offsetX = panStart.ox + (e.clientX - panStart.x); app.offsetY = panStart.oy + (e.clientY - panStart.y); return; }
    if (!app.drag && !app.drawing && !groupDrag) return;
    if (!loadedImage || !app.current) return;
    const [ix, iy] = clientToImage(e.clientX, e.clientY, canvasEl, app.offsetX, app.offsetY, app.zoom);
    const imgW = loadedImage.naturalWidth, imgH = loadedImage.naturalHeight;

    if (groupDrag) {
      let dx = ix - groupDrag.startImgX;
      let dy = iy - groupDrag.startImgY;
      if (groupBounds) {
        dx = Math.max(groupBounds.minDx, Math.min(groupBounds.maxDx, dx));
        dy = Math.max(groupBounds.minDy, Math.min(groupBounds.maxDy, dy));
      }
      groupPreview = { dx, dy };
      return;
    }

    if (app.drag) {
      const dx = ix - app.drag.startImgX, dy = iy - app.drag.startImgY;
      let next: { x: number; y: number; w: number; h: number };
      if (app.drag.type === 'move') {
        next = clampBox({ x: app.drag.origBox.x + dx, y: app.drag.origBox.y + dy, w: app.drag.origBox.w, h: app.drag.origBox.h }, imgW, imgH);
      } else {
        next = clampBox(applyHandleDrag(app.drag.origBox, app.drag.handleIdx!, dx, dy), imgW, imgH);
      }
      dragPreview = { boxId: app.drag.boxId, ...next };
      return;
    }

    if (app.drawing) {
      const [cx, cy] = clampToImage(ix, iy, imgW, imgH);
      app.drawing = { ...app.drawing, x: Math.min(cx, app.drawing.startX), y: Math.min(cy, app.drawing.startY), w: Math.abs(cx - app.drawing.startX), h: Math.abs(cy - app.drawing.startY) };
    }
  }

  function handleMouseUp(_e: MouseEvent) {
    if (panStart) { panStart = null; return; }
    if (!loadedImage || !app.current) return;

    if (groupDrag) {
      const img = app.current.images[app.imgIndex];
      if (groupPreview && (groupPreview.dx !== 0 || groupPreview.dy !== 0) && groupDrag.undoSnapshot) {
        // Commit the move via the store, but push our pre-grab snapshot for
        // undo (moveSelectionBy also calls pushUndo; we want the snapshot
        // taken at grab time, so push ours and let moveSelectionBy skip its).
        app.pushUndoSnapshot(img, groupDrag.undoSnapshot);
        const { dx, dy } = groupPreview;
        for (const b of img.boxes) {
          if (app.selectedBoxes.has(b.id)) { b.x += dx; b.y += dy; }
        }
        app.scheduleSave();
      }
      groupDrag = null;
      groupBounds = null;
      groupPreview = null;
      return;
    }

    if (app.drag) {
      const img = app.current.images[app.imgIndex];
      const box = img.boxes.find(b => b.id === app.drag!.boxId);
      const orig = app.drag.origBox;
      if (box && dragPreview && dragPreview.boxId === box.id) {
        const changed = dragPreview.x !== orig.x || dragPreview.y !== orig.y || dragPreview.w !== orig.w || dragPreview.h !== orig.h;
        if (changed) {
          box.x = dragPreview.x; box.y = dragPreview.y; box.w = dragPreview.w; box.h = dragPreview.h;
          if (app.drag.undoSnapshot) app.pushUndoSnapshot(img, app.drag.undoSnapshot);
          app.scheduleSave();
        }
      }
      dragPreview = null;
      app.drag = null;
      return;
    }

    if (app.drawing) {
      const d = app.drawing;
      app.drawing = null;
      if (d.w > 4 && d.h > 4) {
        app.pushUndo();
        const img = app.current.images[app.imgIndex];
        const box = { id: app.current.nextBoxId++, classIdx: app.activeClass, x: d.x, y: d.y, w: d.w, h: d.h };
        img.boxes.push(box);
        app.selectSingle(box.id);
        app.scheduleSave();
      }
    }
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = canvasEl.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const imgX = (mx - app.offsetX) / app.zoom, imgY = (my - app.offsetY) / app.zoom;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    app.zoom = Math.max(0.05, Math.min(20, app.zoom * factor));
    app.offsetX = mx - imgX * app.zoom;
    app.offsetY = my - imgY * app.zoom;
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'z') { e.preventDefault(); app.undo(); }
      else if (e.key === 'c') { e.preventDefault(); app.copySelection(); }
      else if (e.key === 'v') { e.preventDefault(); app.pasteClipboard(); }
      return;
    }

    // Number keys: 1..9 → classes 0..8, 0 → class 9. Skip if no class at that slot.
    if (/^[0-9]$/.test(e.key) && app.current) {
      const slot = e.key === '0' ? 9 : (parseInt(e.key) - 1);
      if (slot < app.current.classes.length) {
        e.preventDefault();
        // Always update the active class — pressing a digit means "I'm
        // working with this class now", regardless of selection. If a box
        // is also selected, reassign it to the new class too.
        app.activeClass = slot;
        if (app.selectedBox !== null) app.reassignBoxClass(slot);
        return;
      }
    }

    // Arrow keys: nudge selected box by 1px (or 10px with Shift).
    // Navigation is A/D, no longer aliased to arrows.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (app.selectedBox === null) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      switch (e.key) {
        case 'ArrowLeft':  app.nudgeSelectedBox(-step, 0); break;
        case 'ArrowRight': app.nudgeSelectedBox( step, 0); break;
        case 'ArrowUp':    app.nudgeSelectedBox(0, -step); break;
        case 'ArrowDown':  app.nudgeSelectedBox(0,  step); break;
      }
      return;
    }

    switch (e.key) {
      case 'a': case 'A': e.preventDefault(); app.navigateImage(-1); break;
      case 'd': case 'D': e.preventDefault(); app.navigateImage(1); break;
      case 'c': case 'C': e.preventDefault(); app.copyBoxesFromPrevious(); break;
      case 'x': case 'X': e.preventDefault(); app.toggleReviewed(); break;
      case '?': e.preventDefault(); app.showHelp = !app.showHelp; break;
      case 'Delete':
        e.preventDefault();
        if (e.shiftKey) app.removeCurrentImage();
        else app.deleteSelectedOrLast();
        break;
      case 'Escape':
        e.preventDefault();
        if (app.showHelp) { app.showHelp = false; }
        else { app.clearSelection(); app.drawing = null; }
        break;
    }
  }

  onMount(() => {
    ctx = canvasEl.getContext('2d')!;
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    const onResize = () => { if (loadedImage) fitToView(loadedImage); };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('resize', onResize);
    };
  });
</script>

<div class="canvas-wrap">
  <div class="toolbar">
    <span class="info">
      {#if app.current}{app.imgIndex + 1} / {app.current.images.length} — {app.current.images[app.imgIndex]?.filename ?? ''}{/if}
    </span>
    <span class="zoom-label">{baseZoom > 0 ? Math.round((app.zoom / baseZoom) * 100) : 100}%</span>
    <button class="btn-sm" onclick={() => { if (loadedImage) fitToView(loadedImage); }}>Reset Zoom</button>
  </div>
  {#if !loadedImage}
    <div class="placeholder">Select an image to begin</div>
  {/if}
  <canvas bind:this={canvasEl} class="ann-canvas"
    onmousedown={handleMouseDown}
    onwheel={handleWheel}></canvas>
</div>

<style>
  .canvas-wrap { flex: 1; display: flex; flex-direction: column; overflow: hidden; background: var(--canvas-bg); position: relative; }
  .toolbar { background: var(--bg2); border-bottom: 1px solid var(--border); padding: 7px 12px; display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .info { font-size: 11px; color: var(--text2); white-space: nowrap; }
  .zoom-label { font-size: 11px; color: var(--text2); margin-left: auto; }
  .ann-canvas { flex: 1; width: 100%; height: 100%; cursor: crosshair; display: block; }
  .placeholder { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: var(--text2); font-size: 13px; pointer-events: none; z-index: 1; }
</style>
