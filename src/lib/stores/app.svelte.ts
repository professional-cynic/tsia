// Toni's Simple Image Annotator — reactive state
// All state lives on a single exported class instance so components can mutate
// properties without hitting Svelte's "cannot assign to import" restriction.

import type { Project, Screen, ImageEntry, Box, AnnotationFilter, ReviewFilter } from '$lib/types';
import { MAX_CLASSES, MAX_UNDO, AUTOSAVE_DELAY } from '$lib/constants';
import { saveProject } from '$lib/persistence';

type BoxSnapshot = Box[];

// A single reversible action in the chronological undo log.
type UndoEntry =
  // One image's boxes changed (draw, delete, move, resize, nudge, paste,
  // reassign, group-move). Restores that image's boxes by filename.
  | { kind: 'boxes'; filename: string; boxes: BoxSnapshot }
  // Several images' boxes changed atomically (class removal shifts indices
  // project-wide). Reversed in one undo step.
  | { kind: 'boxes-multi'; entries: { filename: string; boxes: BoxSnapshot }[] }
  // An image was removed from the project. Re-inserts it at its old index.
  | { kind: 'image-removed'; img: ImageEntry; index: number };

class AppState {
  // App-level
  screen = $state<Screen>('home');
  projects = $state<Project[]>([]);

  // Current project
  current = $state<Project | null>(null);
  imgIndex = $state(0);
  zoom = $state(1);
  offsetX = $state(0);
  offsetY = $state(0);
  activeClass = $state(0);
  selectedBox = $state<number | null>(null);
  // Multi-selection of box ids (for copy/paste). The single selectedBox
  // above remains the target for drag/resize/delete/nudge; selectedBoxes
  // is the set acted on by copy. A plain click sets both (a one-element
  // selection); Ctrl/Cmd+click edits only the set.
  selectedBoxes = $state<Set<number>>(new Set());
  // In-app clipboard: plain geometry+class snapshots, no live refs or ids.
  clipboard = $state<{ classIdx: number; x: number; y: number; w: number; h: number }[]>([]);
  drawing = $state<{ startX: number; startY: number; x: number; y: number; w: number; h: number } | null>(null);
  drag = $state<{
    type: 'move' | 'handle';
    boxId: number;
    handleIdx?: number;
    startImgX: number;
    startImgY: number;
    origBox: Box;
    undoSnapshot: BoxSnapshot;
  } | null>(null);
  showHelp = $state(false);

  // Unified chronological undo log. A single ordered stack of actions so undo
  // always reverses the most recent operation, whatever its kind (box edit on
  // any image, multi-image class shift, or image removal). NOT $state — the UI
  // doesn't read it reactively.
  private undoLog: UndoEntry[] = [];

  // Filters
  filterAnnotation = $state<AnnotationFilter>('all');
  filterReview = $state<ReviewFilter>('all');
  filterClass = $state<string>('all');

  // ── Derived (getters are reactive in Svelte 5 classes) ──

  get baseFilteredImages(): { img: ImageEntry; i: number }[] {
    if (!this.current) return [];
    return this.current.images.map((img, i) => ({ img, i })).filter(({ img }) => {
      if (this.filterAnnotation === 'annotated' && img.boxes.length === 0) return false;
      if (this.filterAnnotation === 'unannotated' && img.boxes.length > 0) return false;
      if (this.filterClass !== 'all') {
        const ci = parseInt(this.filterClass);
        if (!img.boxes.some(b => b.classIdx === ci)) return false;
      }
      return true;
    });
  }

  get filteredImages(): { img: ImageEntry; i: number }[] {
    return this.baseFilteredImages.filter(({ img }) => {
      if (this.filterReview === 'reviewed' && img.reviewed !== true) return false;
      if (this.filterReview === 'unreviewed' && img.reviewed !== undefined) return false;
      if (this.filterReview === 'rereview' && img.reviewed !== false) return false;
      return true;
    });
  }

  get reviewProgress(): number {
    if (!this.current) return 0;
    const total = this.current.images.length;
    if (total === 0) return 0;
    return this.current.images.filter(img => img.reviewed === true).length / total;
  }

  get reviewedCount(): number {
    if (!this.current) return 0;
    return this.current.images.filter(img => img.reviewed === true).length;
  }

  // ── Autosave ────────────────────────────────────────

  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  saveStatus = $state<'idle' | 'saving'>('idle');

  private async writeNow() {
    if (!this.current) return;
    // Snapshot filter state into the project so it survives a switch.
    this.current.filterAnnotation = this.filterAnnotation;
    this.current.filterReview = this.filterReview;
    this.current.filterClass = this.filterClass;
    this.saveStatus = 'saving';
    // $state.snapshot strips the Svelte proxy machinery. Without this,
    // JSON.stringify reads every property through a proxy handler — fine for
    // small projects, but visibly blocking for projects with thousands of
    // images. The snapshot copies once into plain objects, then stringify
    // runs over those at native speed.
    const plain = $state.snapshot(this.current);
    await saveProject(plain as Project);
    this.saveStatus = 'idle';
  }

  scheduleSave() {
    if (!this.current) return;
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      void this.writeNow();
    }, AUTOSAVE_DELAY);
  }

  /// Force an immediate save of the current project, cancelling any pending
  /// debounce. Called when navigating away (Back button, window close) so the
  /// latest edits always reach disk regardless of debounce timing. Writing
  /// unconditionally (rather than only when a timer is pending) is cheap
  /// insurance against edits that were made but whose debounce already fired
  /// against a stale view, or any proxy-identity surprise.
  async flushSave() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    if (this.current) await this.writeNow();
  }

  // ── Actions ─────────────────────────────────────────

  resetAnnotationState(project: Project) {
    this.current = project;
    this.imgIndex = 0;
    this.zoom = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.activeClass = 0;
    this.selectedBox = null;
    this.selectedBoxes = new Set();
    this.clipboard = [];
    this.drawing = null;
    this.drag = null;
    this.undoLog = [];
    // Restore per-project filter state if present.
    this.filterAnnotation = project.filterAnnotation ?? 'all';
    this.filterReview = project.filterReview ?? 'all';
    this.filterClass = project.filterClass ?? 'all';
  }

  private pushEntry(entry: UndoEntry) {
    this.undoLog.push(entry);
    if (this.undoLog.length > MAX_UNDO) this.undoLog.shift();
  }

  pushUndo() {
    if (!this.current) return;
    const img = this.current.images[this.imgIndex];
    this.pushUndoFor(img, img.boxes);
  }

  private pushUndoFor(img: ImageEntry, boxes: Box[]) {
    // $state.snapshot unwraps proxies; structuredClone(...) throws on $state.
    this.pushEntry({ kind: 'boxes', filename: img.filename, boxes: $state.snapshot(boxes) as Box[] });
  }

  pushUndoSnapshot(img: ImageEntry, snapshot: BoxSnapshot) {
    this.pushEntry({ kind: 'boxes', filename: img.filename, boxes: snapshot });
  }

  snapshotBoxes(boxes: Box[]): BoxSnapshot {
    return $state.snapshot(boxes) as Box[];
  }

  /// Remove the current image from the project (the file on disk is left
  /// untouched — this only drops the annotation entry). Undoable: logged as a
  /// single chronological action. Re-navigates to the nearest remaining image.
  removeCurrentImage() {
    if (!this.current) return;
    const images = this.current.images;
    if (images.length === 0) return;
    const idx = this.imgIndex;

    // Decide where to land BEFORE removing, using the filtered set so we move
    // to the next image that still matches the active filter (e.g. the next
    // 'requires re-review'), not just the next raw image. Prefer the next
    // match after idx; else the previous match before idx; else any image.
    const filtered = this.filteredImages.map(({ i }) => i);
    const nextMatch = filtered.find(i => i > idx);
    const prevMatch = [...filtered].reverse().find(i => i < idx);

    const [removed] = images.splice(idx, 1);
    this.pushEntry({ kind: 'image-removed', img: $state.snapshot(removed) as ImageEntry, index: idx });

    this.selectedBox = null;
    this.selectedBoxes = new Set();
    this.drawing = null;
    this.drag = null;

    // Translate the pre-removal target index to its post-removal position.
    let target: number;
    if (images.length === 0) {
      target = 0;
    } else if (nextMatch !== undefined) {
      target = nextMatch - 1;          // it was above idx, now shifted down
    } else if (prevMatch !== undefined) {
      target = prevMatch;              // below idx, index unchanged
    } else {
      target = Math.min(idx, images.length - 1); // no filtered match left
    }
    this.imgIndex = Math.max(0, Math.min(target, images.length - 1));
    this.scheduleSave();
  }

  /// Reverse the most recent action, whatever its kind — true chronological
  /// undo across box edits, multi-image class shifts, and image removals.
  undo() {
    if (!this.current) return;
    const entry = this.undoLog.pop();
    if (!entry) return;
    const images = this.current.images;

    if (entry.kind === 'image-removed') {
      const at = Math.min(entry.index, images.length);
      images.splice(at, 0, entry.img);
      this.imgIndex = at;
    } else if (entry.kind === 'boxes-multi') {
      for (const e of entry.entries) {
        const img = images.find(i => i.filename === e.filename);
        if (img) img.boxes = e.boxes;
      }
    } else {
      // 'boxes': restore one image's boxes, looked up by filename so it works
      // regardless of which image is currently shown. Navigate to it so the
      // user sees what changed.
      const i = images.findIndex(im => im.filename === entry.filename);
      if (i >= 0) {
        images[i].boxes = entry.boxes;
        this.imgIndex = i;
      }
    }
    this.selectedBox = null;
    this.selectedBoxes = new Set();
    this.scheduleSave();
  }

  setImageIndex(idx: number, _pushHistory = true) {
    if (!this.current || idx < 0 || idx >= this.current.images.length) return;
    this.imgIndex = idx;
    this.selectedBox = null;
    this.selectedBoxes = new Set();
    this.drawing = null;
    this.drag = null;
    // Auto-mark as reviewed only on first view (previously undefined).
    // Images explicitly flagged for re-review (reviewed === false) stay
    // flagged when clicked — the user is going through the rereview
    // list deliberately, and clearing the flag should be an explicit
    // action ('x' key or sidebar dblclick), not a side effect of
    // selecting the image to look at it.
    const img = this.current.images[idx];
    if (img.reviewed === undefined) {
      img.reviewed = true;
      this.scheduleSave();
    }
  }

  /// If the current image isn't in the filtered set, jump to the first
  /// one that is. Called from Sidebar in a $effect whenever any filter
  /// changes — the user expects to be moved to a valid image rather than
  /// seeing the previously-viewed one still appear at the top of the
  /// list when it shouldn't.
  snapToFilter() {
    if (!this.current) return;
    const filtered = this.filteredImages;
    if (filtered.length === 0) return;
    if (filtered.some(({ i }) => i === this.imgIndex)) return;
    this.setImageIndex(filtered[0].i, false);
  }

  navigateImage(delta: number) {
    if (!this.current) return;
    const filtered = this.filteredImages;
    if (filtered.length === 0) return;
    const pos = filtered.findIndex(({ i }) => i === this.imgIndex);
    if (pos === -1) {
      // Current image isn't in the filtered set (e.g. filter just changed).
      // Step to the nearest filtered image in the direction of travel.
      if (delta > 0) {
        const next = filtered.find(({ i }) => i > this.imgIndex);
        this.setImageIndex((next ?? filtered[0]).i, false);
      } else {
        const prev = [...filtered].reverse().find(({ i }) => i < this.imgIndex);
        this.setImageIndex((prev ?? filtered[filtered.length - 1]).i, false);
      }
      return;
    }
    const nextPos = pos + delta;
    if (nextPos < 0 || nextPos >= filtered.length) return; // at an end; stay put
    this.setImageIndex(filtered[nextPos].i, false);
  }

  deleteBox(id: number) {
    if (!this.current) return;
    this.pushUndo();
    const img = this.current.images[this.imgIndex];
    img.boxes = img.boxes.filter(b => b.id !== id);
    if (this.selectedBox === id) this.selectedBox = null;
    this.scheduleSave();
  }

  deleteSelectedOrLast() {
    if (!this.current) return;
    const img = this.current.images[this.imgIndex];
    // Multi-selection: delete all selected boxes in one undo step.
    if (this.selectedBoxes.size > 1) {
      this.pushUndo();
      const ids = this.selectedBoxes;
      img.boxes = img.boxes.filter(b => !ids.has(b.id));
      this.selectedBox = null;
      this.selectedBoxes = new Set();
      this.scheduleSave();
      return;
    }
    if (this.selectedBox !== null) {
      this.deleteBox(this.selectedBox);
      this.selectedBoxes = new Set();
    } else {
      if (img.boxes.length === 0) return;
      this.pushUndo();
      img.boxes.pop();
      this.selectedBox = null;
      this.scheduleSave();
    }
  }

  // ── Multi-selection + clipboard ─────────────────────

  /// Plain selection: a single box becomes both the drag target and the
  /// whole multi-selection.
  selectSingle(id: number) {
    this.selectedBox = id;
    this.selectedBoxes = new Set([id]);
  }

  /// Ctrl/Cmd+click: toggle a box in/out of the multi-selection without
  /// disturbing the drag target unless the toggled box becomes the only
  /// one selected.
  toggleInSelection(id: number) {
    const next = new Set(this.selectedBoxes);
    if (next.has(id)) {
      next.delete(id);
      if (this.selectedBox === id) {
        this.selectedBox = next.size ? [...next][next.size - 1] : null;
      }
    } else {
      next.add(id);
      this.selectedBox = id;
    }
    this.selectedBoxes = next;
  }

  clearSelection() {
    this.selectedBox = null;
    this.selectedBoxes = new Set();
  }

  /// Copy the current multi-selection (or the single selected box) into the
  /// in-app clipboard as plain geometry+class. Non-destructive; selection
  /// is left intact.
  copySelection() {
    if (!this.current) return;
    const img = this.current.images[this.imgIndex];
    const ids = this.selectedBoxes.size ? this.selectedBoxes
      : (this.selectedBox !== null ? new Set([this.selectedBox]) : new Set<number>());
    if (ids.size === 0) return;
    this.clipboard = img.boxes
      .filter(b => ids.has(b.id))
      .map(b => ({ classIdx: b.classIdx, x: b.x, y: b.y, w: b.w, h: b.h }));
  }

  /// Paste clipboard boxes onto the current image at their original
  /// coordinates, clamped to the image. Zero-area results (after clamping
  /// to a smaller image) are dropped. New boxes get fresh ids and become
  /// the selection so the user can immediately adjust them.
  pasteClipboard() {
    if (!this.current || this.clipboard.length === 0) return;
    const img = this.current.images[this.imgIndex];
    const W = img.dims?.w;
    const H = img.dims?.h;
    this.pushUndo();
    let nextId = this.current.nextBoxId;
    const newIds: number[] = [];
    for (const c of this.clipboard) {
      let { x, y, w, h } = c;
      if (W !== undefined && H !== undefined) {
        const x1 = Math.max(0, Math.min(W, x));
        const y1 = Math.max(0, Math.min(H, y));
        const x2 = Math.max(0, Math.min(W, x + w));
        const y2 = Math.max(0, Math.min(H, y + h));
        x = x1; y = y1; w = x2 - x1; h = y2 - y1;
        if (w < 2 || h < 2) continue;
      }
      const id = nextId++;
      img.boxes.push({ id, classIdx: Math.min(c.classIdx, this.current.classes.length - 1), x, y, w, h });
      newIds.push(id);
    }
    this.current.nextBoxId = nextId;
    if (newIds.length) {
      this.selectedBoxes = new Set(newIds);
      this.selectedBox = newIds[newIds.length - 1];
    }
    this.scheduleSave();
  }

  /// Compute how far the current selection can move in each direction before
  /// the group's bounding box hits an image edge. Returns the min/max
  /// allowable delta. If the image has no known dims, returns unbounded.
  groupClampBounds(): { minDx: number; maxDx: number; minDy: number; maxDy: number } {
    const inf = { minDx: -Infinity, maxDx: Infinity, minDy: -Infinity, maxDy: Infinity };
    if (!this.current) return inf;
    const img = this.current.images[this.imgIndex];
    const W = img.dims?.w, H = img.dims?.h;
    if (W === undefined || H === undefined) return inf;
    const sel = img.boxes.filter(b => this.selectedBoxes.has(b.id));
    if (sel.length === 0) return inf;
    const minX = Math.min(...sel.map(b => b.x));
    const minY = Math.min(...sel.map(b => b.y));
    const maxX = Math.max(...sel.map(b => b.x + b.w));
    const maxY = Math.max(...sel.map(b => b.y + b.h));
    return {
      minDx: -minX,         // can't move left past x=0
      maxDx: W - maxX,      // can't move right past image width
      minDy: -minY,
      maxDy: H - maxY,
    };
  }

  reassignBoxClass(classIdx: number) {
    if (!this.current || this.selectedBox === null) return;
    const img = this.current.images[this.imgIndex];
    const box = img.boxes.find(b => b.id === this.selectedBox);
    if (!box || box.classIdx === classIdx) return;
    this.pushUndo();
    box.classIdx = classIdx;
    this.scheduleSave();
  }

  // Coalesce consecutive nudges into a single undo entry so 50 1-pixel
  // arrow presses don't drown the undo stack.
  private lastNudgeAt = 0;
  private lastNudgeBoxId: number | null = null;
  private static NUDGE_COALESCE_MS = 700;

  nudgeSelectedBox(dx: number, dy: number) {
    if (!this.current) return;
    const img = this.current.images[this.imgIndex];

    // Multi-selection: nudge the whole group, clamping the delta so the
    // group keeps its shape against image edges (same rule as group drag).
    if (this.selectedBoxes.size > 1) {
      const now = Date.now();
      const sameBurst = this.lastNudgeBoxId === -1
        && (now - this.lastNudgeAt) < AppState.NUDGE_COALESCE_MS;
      if (!sameBurst) this.pushUndo();
      this.lastNudgeAt = now;
      this.lastNudgeBoxId = -1; // sentinel: a group burst
      const b = this.groupClampBounds();
      const cdx = Math.max(b.minDx, Math.min(b.maxDx, dx));
      const cdy = Math.max(b.minDy, Math.min(b.maxDy, dy));
      if (cdx === 0 && cdy === 0) return;
      for (const box of img.boxes) {
        if (this.selectedBoxes.has(box.id)) { box.x += cdx; box.y += cdy; }
      }
      this.scheduleSave();
      return;
    }

    if (this.selectedBox === null) return;
    const box = img.boxes.find(b => b.id === this.selectedBox);
    if (!box) return;

    const now = Date.now();
    const sameBurst = this.lastNudgeBoxId === box.id
      && (now - this.lastNudgeAt) < AppState.NUDGE_COALESCE_MS;
    if (!sameBurst) this.pushUndo();
    this.lastNudgeAt = now;
    this.lastNudgeBoxId = box.id;

    const W = img.dims?.w;
    const H = img.dims?.h;
    let nx = box.x + dx;
    let ny = box.y + dy;
    if (W !== undefined) nx = Math.max(0, Math.min(W - box.w, nx));
    if (H !== undefined) ny = Math.max(0, Math.min(H - box.h, ny));
    box.x = nx;
    box.y = ny;
    this.scheduleSave();
  }

  copyBoxesFromPrevious(): { copied: number; dropped: number } {
    if (!this.current || this.imgIndex === 0) return { copied: 0, dropped: 0 };
    const prev = this.current.images[this.imgIndex - 1];
    if (prev.boxes.length === 0) return { copied: 0, dropped: 0 };
    const img = this.current.images[this.imgIndex];

    // If both images have known dimensions and they differ, clamp boxes to
    // the current image. If a box ends up zero-area after clamping, drop it.
    const dims = img.dims;
    const prevDims = prev.dims;
    const needsClamp = !!(dims && prevDims && (dims.w !== prevDims.w || dims.h !== prevDims.h));

    this.pushUndo();
    let nextId = this.current.nextBoxId;
    let copied = 0;
    let dropped = 0;
    for (const box of prev.boxes) {
      let { x, y, w, h } = box;
      if (needsClamp) {
        const W = dims!.w, H = dims!.h;
        const x1 = Math.max(0, Math.min(W, x));
        const y1 = Math.max(0, Math.min(H, y));
        const x2 = Math.max(0, Math.min(W, x + w));
        const y2 = Math.max(0, Math.min(H, y + h));
        x = x1; y = y1; w = x2 - x1; h = y2 - y1;
        if (w < 2 || h < 2) { dropped++; continue; }
      }
      img.boxes.push({ id: nextId++, classIdx: box.classIdx, x, y, w, h });
      copied++;
    }
    this.current.nextBoxId = nextId;
    this.scheduleSave();
    return { copied, dropped };
  }

  toggleReviewed() {
    if (!this.current) return;
    const idx = this.imgIndex;
    const img = this.current.images[idx];
    img.reviewed = img.reviewed === false ? true : false;
    this.scheduleSave();
    // If this change pushed the image out of the active filter (e.g. cleared
    // its re-review flag while filtering for re-review), advance to the next
    // image that still matches — same behaviour as delete, so working through
    // a filtered list with 'x' flows continuously. If it still matches (or no
    // filter is active), stay put.
    this.advanceIfFilteredOut(idx);
  }

  /// If the image at `fromIdx` no longer passes the active filter, move to the
  /// next image that does (preferring forward, then backward). No-op if it
  /// still matches or the filter is 'all'/empty.
  private advanceIfFilteredOut(fromIdx: number) {
    if (!this.current) return;
    const filtered = this.filteredImages;
    if (filtered.some(({ i }) => i === fromIdx)) return; // still matches; stay
    if (filtered.length === 0) return;                    // nothing to move to
    const next = filtered.find(({ i }) => i > fromIdx);
    const prev = [...filtered].reverse().find(({ i }) => i < fromIdx);
    this.setImageIndex((next ?? prev ?? filtered[0]).i, false);
  }

  /// Toggle review state on an arbitrary image (not necessarily the current
  /// one). Used by the sidebar's row-dblclick handler; same semantics as
  /// toggleReviewed but without changing imgIndex.
  toggleReviewedFor(img: ImageEntry) {
    img.reviewed = img.reviewed === false ? true : false;
    this.scheduleSave();
  }

  toggleFilteredReviewed() {
    const filtered = this.filteredImages;
    if (filtered.length === 0) return;
    const allReviewed = filtered.every(({ img }) => img.reviewed === true);
    filtered.forEach(({ img }) => { img.reviewed = allReviewed ? false : true; });
    this.scheduleSave();
  }

  addClass(name: string) {
    if (!this.current || this.current.classes.length >= MAX_CLASSES) return;
    this.current.classes.push(name.trim());
    this.scheduleSave();
  }

  renameClass(idx: number, name: string) {
    if (!this.current || idx < 0 || idx >= this.current.classes.length) return;
    this.current.classes[idx] = name.trim();
    this.scheduleSave();
  }

  removeClass(idx: number) {
    if (!this.current || this.current.classes.length <= 1) return;
    // Snapshot every affected image's boxes BEFORE we mutate, as a single
    // atomic undo entry, so one undo reverses the whole project-wide shift.
    const entries: { filename: string; boxes: BoxSnapshot }[] = [];
    for (const img of this.current.images) {
      if (img.boxes.some(b => b.classIdx === idx || b.classIdx > idx)) {
        entries.push({ filename: img.filename, boxes: $state.snapshot(img.boxes) as Box[] });
      }
    }
    if (entries.length) this.pushEntry({ kind: 'boxes-multi', entries });
    this.current.classes.splice(idx, 1);
    this.current.images.forEach(img => {
      img.boxes.forEach(b => {
        if (b.classIdx === idx) b.classIdx = 0;
        else if (b.classIdx > idx) b.classIdx--;
      });
    });
    if (this.activeClass >= this.current.classes.length) this.activeClass = this.current.classes.length - 1;
    this.scheduleSave();
  }
}

export const app = new AppState();
