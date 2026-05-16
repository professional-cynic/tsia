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
      if (this.filterReview === 'reviewed' && !img.reviewed) return false;
      if (this.filterReview === 'unreviewed' && img.reviewed) return false;
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

  /// If a debounced save is pending, cancel the timer and run the save
  /// immediately. Awaited by the window-close handler so the user never loses
  /// work to a close-during-debounce race.
  async flushSave() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
      await this.writeNow();
    }
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
    this.drawing = null;
    this.drag = null;
    // Auto-mark as reviewed on first view. The 'x' key still toggles between
    // reviewed and "needs re-review", so a user who wants to flag an image
    // for revisiting can still do so explicitly.
    const img = this.current.images[idx];
    if (img.reviewed !== true) {
      img.reviewed = true;
      this.scheduleSave();
    }
  }

  navigateImage(delta: number) {
    if (!this.current) return;
    const filtered = this.filteredImages;
    if (filtered.length === 0) return;
    const pos = filtered.findIndex(({ i }) => i === this.imgIndex);

    if (delta < 0) {
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
    if (this.selectedBox !== null) {
      this.deleteBox(this.selectedBox);
    } else {
      const img = this.current.images[this.imgIndex];
      if (img.boxes.length === 0) return;
      this.pushUndo();
      img.boxes.pop();
      this.selectedBox = null;
      this.scheduleSave();
    }
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
    if (!this.current || this.selectedBox === null) return;
    const img = this.current.images[this.imgIndex];
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
