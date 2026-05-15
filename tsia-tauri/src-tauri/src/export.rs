//! Dataset export — runs entirely in Rust to avoid pushing image bytes through
//! the webview. Reads dimensions from headers (no decode), uses kernel-level
//! file copies or hardlinks, dispatches work across a bounded pool of tasks,
//! and streams progress to the frontend via a typed IPC channel.

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
    pub classes: Vec<String>,
    pub images: Vec<ExportImage>,
    pub train_ratio: f32,
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
    let _ = on_event.send(Progress::Start { total: 0, out_path: wrapper_str.clone() });

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
    let annotated: Vec<ExportImage> = req.images.iter()
        .filter(|i| !i.boxes.is_empty())
        .cloned()
        .collect();
    let total = annotated.len();
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

    for (idx, img) in annotated.into_iter().enumerate() {
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
            annotations.push(serde_json::json!({
                "id": ann_id,
                "image_id": image_id,
                "category_id": b.class_idx + 1,
                "bbox": [round1(b.x), round1(b.y), round1(b.w), round1(b.h)],
                "area": round1(b.w * b.h),
                "segmentation": [],
                "iscrowd": 0,
            }));
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
labels/train/         # one .txt per image: <class_idx> <cx> <cy> <w> <h>  (normalised)\n\
labels/val/\n\
data.yaml             # Ultralytics dataset descriptor\n\
classes.txt           # class names, one per line\n",
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

fn strip_ext(filename: &str) -> String {
    match filename.rsplit_once('.') {
        Some((stem, _)) => stem.to_string(),
        None => filename.to_string(),
    }
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
