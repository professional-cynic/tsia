// Data model types

/// A width measurement attached to a box: a free (non-axis-aligned) segment
/// between two points, in IMAGE PIXEL coordinates. The physical length in mm
/// is derived as hypot(bx-ax, by-ay) * project.pixelPitch and is deliberately
/// never stored, so correcting the pitch retroactively fixes every measurement.
export interface Measurement {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export interface Box {
  id: number;
  classIdx: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /// Optional width measurement for this box (at most one). The line may lie
  /// anywhere: a defect's true width often differs from the box's width.
  measure?: Measurement;
}

export interface ImageEntry {
  filename: string;
  boxes: Box[];
  reviewed?: boolean; // undefined = never seen, true = reviewed, false = needs re-review
  dims?: { w: number; h: number }; // cached on first decode to avoid re-loading on export
}

export interface Project {
  id: string;
  name: string;
  classes: string[];
  images: ImageEntry[];
  imageDirPath: string; // native filesystem path to the image folder
  nextBoxId: number;
  createdAt: string;
  /// Millimetres per pixel. Used to convert measurement segment lengths (in
  /// pixels) to physical mm. Undefined = not set; measurements can still be
  /// drawn but show pixel lengths only.
  pixelPitch?: number;
  // Filter state is per-project so it survives a switch back.
  filterAnnotation?: AnnotationFilter;
  filterReview?: ReviewFilter;
  filterClass?: string;
}

export type Screen = 'home' | 'projects' | 'new' | 'annotate' | 'merge';

/// Length of a measurement in image pixels.
export function measureLengthPx(m: Measurement): number {
  return Math.hypot(m.bx - m.ax, m.by - m.ay);
}

/// Physical length in millimetres, or null when the project has no pixel pitch
/// set. Derived on the fly: never persist this.
export function measureLengthMm(m: Measurement, pixelPitch: number | undefined): number | null {
  if (typeof pixelPitch !== 'number' || !Number.isFinite(pixelPitch) || pixelPitch <= 0) return null;
  return measureLengthPx(m) * pixelPitch;
}

export type AnnotationFilter = 'all' | 'annotated' | 'unannotated';
export type ReviewFilter = 'all' | 'reviewed' | 'unreviewed' | 'rereview';
