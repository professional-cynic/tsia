// ══════════════════════════════════════════════════════
// STATE — single source of truth
// ══════════════════════════════════════════════════════

/** Persistent project data. */
export const state = {
  projects:    [],
  current:     null,   // active project object (ref into projects[])
  fileHandles: {},     // filename → FileSystemFileHandle
};

/** Per-session annotation state (reset on project open). */
export const ann = {
  imgIndex:    0,
  zoom:        1,
  offsetX:     0,
  offsetY:     0,
  activeClass: 0,
  selectedBox: null,
  drawing:     null,
  drag:        null,
  undoStack:   {},
  nextBoxId:   1,
  navBack:     [],
  navForward:  [],
  showCrosshair: false,
};

/** Reset annotation state for a new project open. */
export function resetAnn(project) {
  ann.imgIndex    = 0;
  ann.zoom        = 1;
  ann.offsetX     = 0;
  ann.offsetY     = 0;
  ann.activeClass = 0;
  ann.selectedBox = null;
  ann.drawing     = null;
  ann.drag        = null;
  ann.undoStack   = {};
  ann.nextBoxId   = project.nextBoxId || 1;
  ann.navBack     = [];
  ann.navForward  = [];
}
