// Toni's Simple Image Annotator — reactive state
// All state lives on a single exported class instance so components can mutate
// properties without hitting Svelte's "cannot assign to import" restriction.

import type { Project, Screen, ImageEntry, Box, AnnotationFilter, ReviewFilter } from '$lib/types';
import { MAX_CLASSES, MAX_UNDO, MAX_NAV, AUTOSAVE_DELAY } from '$lib/constants';
import { saveProject } from '$lib/persistence';

type BoxSnapshot = Box[];

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

  // Navigation history
  navBack = $state<number[]>([]);
  navForward = $state<number[]>([]);

  // Undo stacks (keyed by filename). NOT $state — nothing in the UI reads it
  // reactively, so the proxy overhead is wasted and array mutation here would
  // otherwise look misleadingly observable.
  private undoStacks: Record<string, BoxSnapshot[]> = {};

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
    this.undoStacks = {};
    this.navBack = [];
    this.navForward = [];
    // Restore per-project filter state if present.
    this.filterAnnotation = project.filterAnnotation ?? 'all';
    this.filterReview = project.filterReview ?? 'all';
    this.filterClass = project.filterClass ?? 'all';
  }

  pushUndo() {
    if (!this.current) return;
    const img = this.current.images[this.imgIndex];
    this.pushUndoFor(img, img.boxes);
  }

  private pushUndoFor(img: ImageEntry, boxes: Box[]) {
    const key = img.filename;
    if (!this.undoStacks[key]) this.undoStacks[key] = [];
    // $state.snapshot unwraps proxies; structuredClone(...) throws on $state.
    this.undoStacks[key].push($state.snapshot(boxes) as Box[]);
    if (this.undoStacks[key].length > MAX_UNDO) this.undoStacks[key].shift();
  }

  pushUndoSnapshot(img: ImageEntry, snapshot: BoxSnapshot) {
    const key = img.filename;
    if (!this.undoStacks[key]) this.undoStacks[key] = [];
    this.undoStacks[key].push(snapshot);
    if (this.undoStacks[key].length > MAX_UNDO) this.undoStacks[key].shift();
  }

  snapshotBoxes(boxes: Box[]): BoxSnapshot {
    return $state.snapshot(boxes) as Box[];
  }

  undo() {
    if (!this.current) return;
    const img = this.current.images[this.imgIndex];
    const key = img.filename;
    if (!this.undoStacks[key]?.length) return;
    img.boxes = this.undoStacks[key].pop()!;
    this.selectedBox = null;
    this.scheduleSave();
  }

  setImageIndex(idx: number, pushHistory = true) {
    if (!this.current || idx < 0 || idx >= this.current.images.length) return;
    if (pushHistory && this.imgIndex !== idx) {
      this.navBack.push(this.imgIndex);
      if (this.navBack.length > MAX_NAV) this.navBack.shift();
      this.navForward = [];
    }
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
    const pos = filtered.findIndex(({ i }) => i === this.imgIndex);    if (delta < 0) {
      if (this.navBack.length > 0) {
        const prev = this.navBack.pop()!;
        this.navForward.push(this.imgIndex);
        if (this.navForward.length > MAX_NAV) this.navForward.shift();
        this.setImageIndex(prev, false);
        return;
      }
      if (pos === -1) {
        for (let j = filtered.length - 1; j >= 0; j--) {
          if (filtered[j].i < this.imgIndex) {
            this.navBack.push(this.imgIndex);
            this.navForward = [];
            this.setImageIndex(filtered[j].i, false);
            return;
          }
        }
        return;
      }
      if (pos - 1 < 0) return;
      this.navBack.push(this.imgIndex);
      this.navForward = [];
      this.setImageIndex(filtered[pos - 1].i, false);
    } else {
      if (this.navForward.length > 0) {
        const next = this.navForward.pop()!;
        this.navBack.push(this.imgIndex);
        if (this.navBack.length > MAX_NAV) this.navBack.shift();
        this.setImageIndex(next, false);
        return;
      }
      let nextPos;
      if (pos === -1) {
        nextPos = filtered.findIndex(({ i }) => i > this.imgIndex);
        if (nextPos === -1) return;
      } else {
        nextPos = pos + 1;
        if (nextPos >= filtered.length) return;
      }
      this.navBack.push(this.imgIndex);
      this.setImageIndex(filtered[nextPos].i, false);
    }
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
    const img = this.current.images[this.imgIndex];
    img.reviewed = img.reviewed === false ? true : false;
    this.scheduleSave();
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
    // Snapshot every image's boxes BEFORE we mutate, so undo can reverse the
    // class shift across the whole project.
    for (const img of this.current.images) {
      if (img.boxes.some(b => b.classIdx === idx || b.classIdx > idx)) {
        this.pushUndoFor(img, img.boxes);
      }
    }
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
