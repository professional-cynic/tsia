/// Progress events streamed by the long-running Rust jobs (export, merge).
/// Mirrors `Progress` in src-tauri/src/util.rs.
export type ProgressEvent =
  | { kind: 'start'; data: { total: number; outPath: string } }
  | { kind: 'item'; data: { current: number; filename: string } }
  | { kind: 'warning'; data: { filename: string; message: string } }
  | { kind: 'done'; data: { outPath: string } }
  | { kind: 'cancelled' }
  | { kind: 'failed'; data: { message: string } };
