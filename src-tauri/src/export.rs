//! Dataset export — runs entirely in Rust to avoid pushing image bytes through
//! the webview. Reads dimensions from headers (no decode), uses kernel-level
//! file copies or hardlinks, dispatches work across a bounded pool of tasks,
//! and streams progress to the frontend via a typed IPC channel.

use crate::util::strip_ext;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

// ── Request / progress types ─────────────────────────────

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportBox {
    pub class_idx: usize,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// Measured physical width in millimetres, computed frontend-side from the
    /// project's pixel pitch. None when the box is unmeasured or no pitch is
    /// set. Exported as a non-breaking sidecar (see write_coco / write_yolo).
    #[serde(default)]
    pub measurement_mm: Option<f64>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportImage {
    pub filename: String,
    pub boxes: Vec<ExportBox>,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Coco,
    Yolo,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum LinkMode {
    /// Independent file copy (default; safe across filesystems).
    Copy,
    /// Hardlink — instant and zero-space, but only works on the same filesystem
    /// as the source images. Edits to either side affect both.
    Link,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub format: Format,
    pub link_mode: LinkMode,
    pub out_dir: PathBuf,
    pub image_dir: PathBuf,
    pub project_name: String,
    pub project_id: String,
    pub classes: Vec<String>,
    pub images: Vec<ExportImage>,
    pub train_ratio: f32,
    /// Target fraction of negative (box-less) images in the exported set.
    /// -1.0 means "no target: include every negative". 0.0..=1.0 trims the
    /// surplus side to hit exactly that fraction.
    pub neg_ratio: f32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase", tag = "kind", content = "data")]
pub enum Progress {
    /// Sent once at the start with the total number of items and the
    /// resolved output path of the wrapper directory.
    Start { total: usize, out_path: String },
    /// Sent after each image finishes (or is skipped).
    Item { current: usize, filename: String },
    /// Sent when a single image was skipped due to a non-fatal error.
    Warning { filename: String, message: String },
    /// Sent on successful completion.
    Done { out_path: String },
    /// Sent if cancelled before completion.
    Cancelled,
    /// Sent if a fatal error halts the export.
    Failed { message: String },
}

// ── Shared cancel state ──────────────────────────────────

#[derive(Default)]
pub struct ExportCancel(pub Arc<AtomicBool>);

// ── Commands ─────────────────────────────────────────────

#[tauri::command]
pub async fn export_dataset(
    state: State<'_, ExportCancel>,
    req: ExportRequest,
    on_event: Channel<Progress>,
) -> Result<(), String> {
    let cancel = state.0.clone();
    cancel.store(false, Ordering::Relaxed);

    // Build the wrapper directory inside the user's chosen folder. Naming:
    //   "<project>_<format>_<YYYYMMDD-HHMMSS>"
    // Filesystem-safe slug of the project name + format + timestamp.
    let stamp = timestamp_slug();
    let wrapper_name = format!(
        "{}_{}_{}",
        slug(&req.project_name),
        format_slug(req.format),
        stamp,
    );
    let wrapper = req.out_dir.join(&wrapper_name);

    // Create the wrapper up-front so we have a single root to roll back on
    // cancel/failure.
    if let Err(e) = tokio::fs::create_dir_all(&wrapper).await {
        let msg = format!("create wrapper dir: {e}");
        let _ = on_event.send(Progress::Failed { message: msg.clone() });
        return Err(msg);
    }

    let wrapper_str = wrapper.to_string_lossy().to_string();

    let result = run(&req, &wrapper, &cancel, &on_event).await;

    match result {
        Ok(true) => {
            let _ = on_event.send(Progress::Done { out_path: wrapper_str });
            Ok(())
        }
        Ok(false) => {
            // Cancelled: roll back the wrapper directory so the user isn't
            // left with a half-baked dataset that looks complete.
            let _ = tokio::fs::remove_dir_all(&wrapper).await;
            let _ = on_event.send(Progress::Cancelled);
            Ok(())
        }
        Err(e) => {
            // Fatal: same rollback.
            let _ = tokio::fs::remove_dir_all(&wrapper).await;
            let _ = on_event.send(Progress::Failed { message: e.clone() });
            Err(e)
        }
    }
}

#[tauri::command]
pub fn export_cancel(state: State<'_, ExportCancel>) {
    state.0.store(true, Ordering::Relaxed);
}

// ── Implementation ───────────────────────────────────────

/// Returns Ok(true) on full completion, Ok(false) if cancelled, Err on failure.
async fn run(
    req: &ExportRequest,
    wrapper: &Path,
    cancel: &Arc<AtomicBool>,
    on_event: &Channel<Progress>,
) -> Result<bool, String> {
    // Export every image passed in. Box-less images are kept as negative
    // (background) samples — standard practice for object detection. The
    // frontend decides the subset to send (e.g. reviewed-only); this layer
    // no longer drops empties. COCO represents a negative as an image entry
    // with no annotations; YOLO as an image with no label file (see writers).
    let mut all_images: Vec<ExportImage> = req.images.clone();
    // Shuffle before splitting so file order doesn't bias the train/val
    // partition (sequential frames or clustered negatives would otherwise
    // skew it). Seeded from the project id (stable across renames), so the
    // same project always produces the same split on re-export.
    shuffle(&mut all_images, seed_from(&req.project_id));

    // Optional negative-sample targeting. If neg_ratio is in [0,1], trim the
    // surplus side so negatives make up exactly that fraction of the export
    // (may drop positives — intended, for fine-tuning dataset composition).
    // Images are already shuffled, so taking the first K of each group is a
    // random-but-reproducible subset.
    if (0.0..=1.0).contains(&req.neg_ratio) {
        all_images = apply_neg_target(all_images, req.neg_ratio);
    }

    let total = all_images.len();
    on_event.send(Progress::Start {
        total,
        out_path: wrapper.to_string_lossy().to_string(),
    }).map_err(|e| e.to_string())?;

    if total == 0 {
        // Nothing to export, but still write the metadata so the user gets
        // a valid (empty) dataset rather than an empty folder.
        write_top_level_metadata(req, wrapper, 0, 0).await?;
        return Ok(true);
    }

    let split_idx = (total as f32 * req.train_ratio).round() as usize;

    let img_train = wrapper.join("images").join("train");
    let img_val   = wrapper.join("images").join("val");
    tokio::fs::create_dir_all(&img_train).await.map_err(io_err("mkdir images/train"))?;
    tokio::fs::create_dir_all(&img_val).await.map_err(io_err("mkdir images/val"))?;

    let (lbl_train, lbl_val, ann_dir) = match req.format {
        Format::Yolo => {
            let lt = wrapper.join("labels").join("train");
            let lv = wrapper.join("labels").join("val");
            tokio::fs::create_dir_all(&lt).await.map_err(io_err("mkdir labels/train"))?;
            tokio::fs::create_dir_all(&lv).await.map_err(io_err("mkdir labels/val"))?;
            (Some(lt), Some(lv), None)
        }
        Format::Coco => {
            let ad = wrapper.join("annotations");
            tokio::fs::create_dir_all(&ad).await.map_err(io_err("mkdir annotations"))?;
            (None, None, Some(ad))
        }
    };

    // Bound concurrency. Too high and we thrash the disk; too low and we
    // leave SSD bandwidth on the table. Empirically 8 is a good default
    // for both spinning rust and NVMe — kernel readahead handles the rest.
    let permits = Arc::new(Semaphore::new(8));
    let counter = Arc::new(AtomicUsize::new(0));

    let mut set = JoinSet::new();

    for (idx, img) in all_images.into_iter().enumerate() {
        if cancel.load(Ordering::Relaxed) { break; }

        let permits = permits.clone();
        let counter = counter.clone();
        let cancel = cancel.clone();
        let on_event = on_event.clone();
        let image_dir = req.image_dir.clone();
        let dst_img_dir = if idx < split_idx { img_train.clone() } else { img_val.clone() };
        let link_mode_is_link = matches!(req.link_mode, LinkMode::Link);

        set.spawn(async move {
            let _permit = permits.acquire().await.unwrap();
            if cancel.load(Ordering::Relaxed) { return None; }

            let src = image_dir.join(&img.filename);
            let dst = dst_img_dir.join(&img.filename);

            let warn = |msg: String| {
                let _ = on_event.send(Progress::Warning {
                    filename: img.filename.clone(),
                    message: msg,
                });
            };

            if let Some(parent) = dst.parent() {
                if let Err(e) = tokio::fs::create_dir_all(parent).await {
                    warn(format!("mkdir {parent:?} failed: {e}"));
                    return None;
                }
            }

            let (w, h) = match imagesize::size(&src) {
                Ok(d) => (d.width as u32, d.height as u32),
                Err(e) => {
                    warn(format!("dim read {src:?} failed: {e}"));
                    return None;
                }
            };

            if link_mode_is_link {
                let _ = tokio::fs::remove_file(&dst).await;
                if let Err(e) = tokio::fs::hard_link(&src, &dst).await {
                    warn(format!("hardlink {src:?} -> {dst:?} failed: {e}"));
                    return None;
                }
            } else if let Err(e) = tokio::fs::copy(&src, &dst).await {
                warn(format!("copy {src:?} -> {dst:?} failed: {e}"));
                return None;
            }

            let current = counter.fetch_add(1, Ordering::Relaxed) + 1;
            let _ = on_event.send(Progress::Item {
                current,
                filename: img.filename.clone(),
            });

            Some(ImageRecord { idx, img, dims: (w, h) })
        });
    }

    let mut records: Vec<ImageRecord> = Vec::with_capacity(total);
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(Some(rec)) => records.push(rec),
            Ok(None) => {}
            Err(e) => return Err(format!("task panic: {e}")),
        }
    }

    if cancel.load(Ordering::Relaxed) { return Ok(false); }

    records.sort_by_key(|r| r.idx);

    let train_count = records.iter().filter(|r| r.idx < split_idx).count();
    let val_count = records.len() - train_count;

    match req.format {
        Format::Coco => {
            write_coco(req, split_idx, &records, ann_dir.as_ref().unwrap()).await?;
        }
        Format::Yolo => {
            write_yolo(
                req,
                wrapper,
                split_idx,
                &records,
                lbl_train.as_ref().unwrap(),
                lbl_val.as_ref().unwrap(),
            ).await?;
        }
    }

    write_top_level_metadata(req, wrapper, train_count, val_count).await?;

    Ok(true)
}

struct ImageRecord {
    idx: usize,
    img: ExportImage,
    dims: (u32, u32),
}

// ── COCO writer ──────────────────────────────────────────

async fn write_coco(
    req: &ExportRequest,
    split_idx: usize,
    records: &[ImageRecord],
    ann_dir: &std::path::Path,
) -> Result<(), String> {
    let categories: Vec<serde_json::Value> = req.classes.iter().enumerate()
        .map(|(i, name)| serde_json::json!({
            "id": i + 1, "name": name, "supercategory": "none"
        })).collect();

    let mut train_images = Vec::new();
    let mut train_annotations = Vec::new();
    let mut val_images = Vec::new();
    let mut val_annotations = Vec::new();
    let mut ann_id: u64 = 1;

    for rec in records {
        let is_train = rec.idx < split_idx;
        let (images, annotations) = if is_train {
            (&mut train_images, &mut train_annotations)
        } else {
            (&mut val_images, &mut val_annotations)
        };
        let image_id = images.len() + 1;
        images.push(serde_json::json!({
            "id": image_id,
            "license": 0,
            "file_name": rec.img.filename,
            "width": rec.dims.0,
            "height": rec.dims.1,
            "date_captured": serde_json::Value::Null,
        }));
        for b in &rec.img.boxes {
            let mut ann = serde_json::json!({
                "id": ann_id,
                "image_id": image_id,
                "category_id": b.class_idx + 1,
                "bbox": [round1(b.x), round1(b.y), round1(b.w), round1(b.h)],
                "area": round1(b.w * b.h),
                "segmentation": [],
                "iscrowd": 0,
            });
            // Custom, additive key. COCO has no field for a physical width, and
            // overloading `area` (which is pixel area of the instance) would be
            // wrong and would break standard tooling. Unknown keys are ignored
            // by COCO readers, so adding one keeps the file valid.
            if let Some(mm) = b.measurement_mm {
                ann["measurement_mm"] = serde_json::json!(round3(mm));
            }
            annotations.push(ann);
            ann_id += 1;
        }
    }

    let info = serde_json::json!({
        "description": req.project_name,
        "url": "",
        "version": "1.0",
        "year": current_year(),
        "contributor": "Toni's Simple Image Annotator",
        "date_created": iso8601_now(),
    });

    for (name, images, annotations) in [
        ("instances_train.json", train_images, train_annotations),
        ("instances_val.json",   val_images,   val_annotations),
    ] {
        let coco = serde_json::json!({
            "info": info,
            "licenses": [],
            "categories": categories,
            "images": images,
            "annotations": annotations,
        });
        let path = ann_dir.join(name);
        let body = serde_json::to_vec_pretty(&coco).map_err(|e| e.to_string())?;
        tokio::fs::write(&path, body).await.map_err(io_err("write COCO JSON"))?;
    }
    Ok(())
}

// ── YOLO writer ──────────────────────────────────────────

async fn write_yolo(
    req: &ExportRequest,
    wrapper: &std::path::Path,
    split_idx: usize,
    records: &[ImageRecord],
    lbl_train: &std::path::Path,
    lbl_val: &std::path::Path,
) -> Result<(), String> {
    // data.yaml — Ultralytics-compatible. names is a dict (0: foo) which
    // YOLOv5/v8/v11 all accept.
    let names_block: String = req.classes.iter().enumerate()
        .map(|(i, c)| format!("  {i}: {c}")).collect::<Vec<_>>().join("\n");
    let yaml = format!(
        "# Toni's Simple Image Annotator — Ultralytics YOLO export\n\
         # Train with: yolo detect train data=data.yaml ...\n\
         path: .\n\
         train: images/train\n\
         val: images/val\n\
         # test: images/test  # optional, not produced by this export\n\
         \n\
         nc: {}\n\
         names:\n{}\n",
        req.classes.len(), names_block,
    );
    tokio::fs::write(wrapper.join("data.yaml"), yaml).await
        .map_err(io_err("write data.yaml"))?;
    tokio::fs::write(wrapper.join("classes.txt"), req.classes.join("\n")).await
        .map_err(io_err("write classes.txt"))?;

    let mut set = JoinSet::new();
    for rec in records {
        // Negative sample: no boxes → write no label file at all
        // (Ultralytics treats an image with no matching .txt as background).
        if rec.img.boxes.is_empty() { continue; }

        let is_train = rec.idx < split_idx;
        let dst_dir = if is_train { lbl_train.to_path_buf() } else { lbl_val.to_path_buf() };

        let mut lines = String::with_capacity(rec.img.boxes.len() * 64);
        let (w, h) = (rec.dims.0 as f64, rec.dims.1 as f64);
        for b in &rec.img.boxes {
            let cx = (b.x + b.w / 2.0) / w;
            let cy = (b.y + b.h / 2.0) / h;
            let nw = b.w / w;
            let nh = b.h / h;
            lines.push_str(&format!(
                "{} {:.6} {:.6} {:.6} {:.6}\n",
                b.class_idx, cx, cy, nw, nh
            ));
        }
        let base_no_ext = strip_ext(&rec.img.filename);
        let label_path = dst_dir.join(format!("{base_no_ext}.txt"));
        set.spawn(async move {
            if let Some(parent) = label_path.parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            tokio::fs::write(label_path, lines).await
        });
    }
    while let Some(joined) = set.join_next().await {
        joined.map_err(|e| format!("label task panic: {e}"))?
              .map_err(io_err("write label"))?;
    }

    // ── Measurements sidecar ──
    // YOLO label files have a fixed 5-field format; adding a sixth field or an
    // extra line would make them unparseable by standard loaders. So physical
    // measurements go in a separate file that YOLO never reads.
    //
    // Keyed by label stem (matching the .txt name). `measurements_mm` is
    // positionally aligned with the lines of that .txt: entry N is the
    // measurement for the box on line N, null when that box is unmeasured.
    let mut measured: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    for rec in records {
        if rec.img.boxes.is_empty() { continue; }
        if !rec.img.boxes.iter().any(|b| b.measurement_mm.is_some()) { continue; }
        let split = if rec.idx < split_idx { "train" } else { "val" };
        let values: Vec<serde_json::Value> = rec.img.boxes.iter()
            .map(|b| match b.measurement_mm {
                Some(mm) => serde_json::json!(round3(mm)),
                None => serde_json::Value::Null,
            })
            .collect();
        measured.insert(strip_ext(&rec.img.filename).to_string(), serde_json::json!({
            "split": split,
            "image": rec.img.filename,
            "measurements_mm": values,
        }));
    }
    if !measured.is_empty() {
        let doc = serde_json::json!({
            "description": "Physical width measurements, in millimetres, one entry per box. \
Positionally aligned with the lines of the matching labels/<split>/<stem>.txt file. \
Null means that box was not measured. Not read by YOLO; this file is additive.",
            "unit": "mm",
            "images": measured,
        });
        let body = serde_json::to_vec_pretty(&doc).map_err(|e| e.to_string())?;
        tokio::fs::write(wrapper.join("measurements.json"), body).await
            .map_err(io_err("write measurements.json"))?;
    }
    Ok(())
}

// ── README + top-level metadata ──────────────────────────

async fn write_top_level_metadata(
    req: &ExportRequest,
    wrapper: &std::path::Path,
    train_count: usize,
    val_count: usize,
) -> Result<(), String> {
    let format_name = match req.format {
        Format::Coco => "COCO",
        Format::Yolo => "YOLO (Ultralytics)",
    };
    let link_name = match req.link_mode {
        LinkMode::Copy => "copy",
        LinkMode::Link => "hardlink",
    };
    let layout = match req.format {
        Format::Coco => "\
images/train/         # training images\n\
images/val/           # validation images\n\
annotations/instances_train.json\n\
annotations/instances_val.json\n",
        Format::Yolo => "\
images/train/         # training images\n\
images/val/           # validation images\n\
labels/train/         # one .txt per annotated image: <class_idx> <cx> <cy> <w> <h> (normalised); negatives have none\n\
labels/val/\n\
data.yaml             # Ultralytics dataset descriptor\n\
classes.txt           # class names, one per line\n\
measurements.json     # physical widths in mm, aligned with each .txt (only if measured); ignored by YOLO\n",
    };
    let readme = format!("\
# {project}

Exported from Toni's Simple Image Annotator on {date}.

- Format:           {fmt}
- Image transfer:   {link}
- Classes ({nc}):       {classes}
- Train / Val:      {tr} / {vl} ({ratio:.0}% / {invratio:.0}%)

## Layout

{layout}
",
        project = req.project_name,
        date = iso8601_now(),
        fmt = format_name,
        link = link_name,
        nc = req.classes.len(),
        classes = req.classes.join(", "),
        tr = train_count,
        vl = val_count,
        ratio = req.train_ratio * 100.0,
        invratio = (1.0 - req.train_ratio) * 100.0,
        layout = layout,
    );
    tokio::fs::write(wrapper.join("README.md"), readme).await
        .map_err(io_err("write README.md"))
}

// ── Helpers ──────────────────────────────────────────────

fn round1(n: f64) -> f64 { (n * 10.0).round() / 10.0 }

/// Millimetre measurements need finer resolution than pixel coordinates:
/// defect widths are often well under a millimetre, so 0.1mm steps would
/// destroy the value. 3dp gives micron resolution.
fn round3(n: f64) -> f64 { (n * 1000.0).round() / 1000.0 }

/// Deterministic shuffle for the train/val split. We shuffle so that the
/// split isn't biased by file order (sequential frames, date-sorted names,
/// clustered negatives would otherwise skew val vs train). The seed is fixed
/// so re-exporting the same project yields the same split — reproducible
/// datasets without pulling in the `rand` crate.
///
/// xorshift64* — tiny, fast, good enough for shuffling a file list (this is
/// not cryptographic and doesn't need to be).
struct Rng(u64);
impl Rng {
    fn new(seed: u64) -> Self {
        // Avoid the all-zero state, which xorshift can't escape.
        Rng(seed ^ 0x9E3779B97F4A7C15)
    }
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    /// Uniform-ish integer in [0, n). Modulo bias is negligible for the small
    /// n (image counts) this is used with.
    fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % (n as u64)) as usize
    }
}

/// In-place Fisher-Yates shuffle with the given seed.
fn shuffle<T>(items: &mut [T], seed: u64) {
    let mut rng = Rng::new(seed);
    let n = items.len();
    for i in (1..n).rev() {
        let j = rng.below(i + 1);
        items.swap(i, j);
    }
}

/// Trim a (already-shuffled) image list so negatives make up exactly `t` of
/// the result, dropping the surplus side. Taking the first K of each group
/// yields a random-but-reproducible subset because the input is shuffled.
/// Recombines preserving the original shuffled order so the train/val split
/// downstream still sees a shuffled sequence.
fn apply_neg_target(images: Vec<ExportImage>, t: f32) -> Vec<ExportImage> {
    let p = images.iter().filter(|i| !i.boxes.is_empty()).count();
    let n = images.len() - p;

    // How many of each to keep (mirrors the frontend preview exactly).
    let (keep_pos, keep_neg) = if t <= 0.0 {
        (p, 0)
    } else if t >= 1.0 {
        if n > 0 { (0, n) } else { (p, 0) }
    } else if n == 0 {
        (p, 0)
    } else if p == 0 {
        (0, n)
    } else {
        let avail = n as f32 / (p + n) as f32;
        if avail >= t {
            (p, ((p as f32) * t / (1.0 - t)).round() as usize)
        } else {
            (((n as f32) * (1.0 - t) / t).round() as usize, n)
        }
    };
    let keep_pos = keep_pos.min(p);
    let keep_neg = keep_neg.min(n);

    let mut seen_pos = 0usize;
    let mut seen_neg = 0usize;
    images.into_iter().filter(|img| {
        if img.boxes.is_empty() {
            seen_neg += 1;
            seen_neg <= keep_neg
        } else {
            seen_pos += 1;
            seen_pos <= keep_pos
        }
    }).collect()
}

/// Stable seed derived from the project id, so different projects get
/// different shuffles but the same project is reproducible across exports
/// (and across renames, since the id never changes).
fn seed_from(name: &str) -> u64 {
    // FNV-1a 64-bit.
    let mut h: u64 = 0xCBF29CE484222325;
    for b in name.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001B3);
    }
    h
}

fn io_err(label: &'static str) -> impl Fn(std::io::Error) -> String {
    move |e| format!("{label}: {e}")
}

/// Filesystem-safe slug of an arbitrary string. Keeps ASCII alphanumerics,
/// dashes, and underscores. Spaces become underscores; everything else is
/// stripped. Leading/trailing dashes are trimmed.
fn slug(s: &str) -> String {
    let mut out: String = s.chars().map(|c| {
        if c.is_ascii_alphanumeric() { c }
        else if c == '-' || c == '_' { c }
        else if c.is_whitespace() { '_' }
        else { '-' }
    }).collect();
    while out.starts_with('-') || out.starts_with('_') { out.remove(0); }
    while out.ends_with('-') || out.ends_with('_') { out.pop(); }
    if out.is_empty() { out.push_str("project"); }
    out
}

fn format_slug(f: Format) -> &'static str {
    match f { Format::Coco => "coco", Format::Yolo => "yolo" }
}

/// "YYYYMMDD-HHMMSS" from UTC now. Accurate enough for export-folder naming;
/// no `chrono` dependency.
fn timestamp_slug() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (y, mo, d, h, mi, s) = ymdhms(secs);
    format!("{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}")
}

/// ISO-8601 string for `info.date_created` and the README header.
fn iso8601_now() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (y, mo, d, h, mi, s) = ymdhms(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

fn current_year() -> i32 {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    ymdhms(secs).0
}

/// Civil-from-days algorithm (Howard Hinnant). Decomposes a Unix timestamp
/// into UTC components. Correct for the entire Gregorian calendar.
fn ymdhms(secs: i64) -> (i32, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let time = secs.rem_euclid(86_400) as u32;
    let h = time / 3600;
    let mi = (time % 3600) / 60;
    let s = time % 60;

    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097) as u32; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i32 + (era * 400) as i32;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };

    (y, m, d, h, mi, s)
}
