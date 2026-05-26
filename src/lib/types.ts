// Data model types

export interface Box {
  id: number;
  classIdx: number;
  x: number;
  y: number;
  w: number;
  h: number;
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
  // Filter state is per-project so it survives a switch back.
  filterAnnotation?: AnnotationFilter;
  filterReview?: ReviewFilter;
  filterClass?: string;
}

export type Screen = 'home' | 'projects' | 'new' | 'annotate';

export type AnnotationFilter = 'all' | 'annotated' | 'unannotated';
export type ReviewFilter = 'all' | 'reviewed' | 'unreviewed' | 'rereview';
