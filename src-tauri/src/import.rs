//! Dataset import — parses COCO JSON or YOLO label folders entirely on the
//! Rust side, so the frontend never needs an fs scope outside AppData.
//!
//! Both importers return boxes in the app's own convention (top-left x/y,
//! width/height, in image pixels), keyed by the image's path relative to the
//! project folder exactly as `scan_image_folder` reports it.

use crate::fs_helpers::walk_files;
use crate::util::{basename, safe_relative, strip_ext};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedAnnotation {
    pub class_idx: usize,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportedDataset {
    pub classes: Vec<String>,
    pub annotations: HashMap<String, Vec<ImportedAnnotation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs_classes: Option<bool>,
    /// Annotated entries (COCO images / YOLO label files) that matched no
    /// image in the project folder.
    pub unmatched: usize,
    /// Boxes dropped because they couldn't be interpreted (unknown class,
    /// malformed line, unreadable image size).
    pub skipped_boxes: usize,
}

// ── Matching annotation files to project images ──────────

/// Finds the project image an annotation refers to. Tries the full relative
/// path first, then falls back to the bare file name, but only when exactly
/// one project image has that name (so `train/a.jpg` and `val/a.jpg` are never
/// confused).
struct ImageIndex<'a> {
    by_path: HashMap<String, &'a str>,
    by_name: HashMap<String, Option<&'a str>>,
}

impl<'a> ImageIndex<'a> {
    /// `key` maps an image path to the form annotations refer to it by
    /// (COCO: the path itself; YOLO: the path without extension).
    fn new(images: &'a [String], key: impl Fn(&str) -> String) -> Self {
        let mut by_path = HashMap::new();
        let mut by_name: HashMap<String, Option<&'a str>> = HashMap::new();
        for img in images {
            let k = key(img);
            by_name.entry(basename(&k).to_string())
                .and_modify(|v| *v = None)
                .or_insert(Some(img.as_str()));
            by_path.insert(k, img.as_str());
        }
        Self { by_path, by_name }
    }

    fn find(&self, reference: &str) -> Option<&'a str> {
        let reference = reference.replace('\\', "/");
        let reference = reference.trim_start_matches("./");
        self.by_path.get(reference).copied()
            .or_else(|| self.by_name.get(basename(reference)).copied().flatten())
    }
}

// ── COCO ─────────────────────────────────────────────────

#[derive(Deserialize)]
struct CocoFile {
    #[serde(default)] info: Option<CocoInfo>,
    #[serde(default)] categories: Vec<CocoCategory>,
    #[serde(default)] images: Vec<CocoImage>,
    #[serde(default)] annotations: Vec<CocoAnnotation>,
}
#[derive(Deserialize)]
struct CocoInfo { #[serde(default)] description: Option<String> }
#[derive(Deserialize)]
struct CocoCategory { id: i64, name: String }
#[derive(Deserialize)]
struct CocoImage { id: i64, file_name: String }
#[derive(Deserialize)]
struct CocoAnnotation { image_id: i64, category_id: i64, bbox: [f64; 4] }

#[tauri::command]
pub async fn import_coco(path: PathBuf, image_filenames: Vec<String>) -> Result<ImportedDataset, String> {
    let bytes = tokio::fs::read(&path).await.map_err(|e| format!("read: {e}"))?;
    let data: CocoFile = serde_json::from_slice(&bytes).map_err(|e| format!("parse: {e}"))?;
    Ok(coco_to_dataset(data, &image_filenames))
}

fn coco_to_dataset(data: CocoFile, image_filenames: &[String]) -> ImportedDataset {
    // One class per distinct name, in first-seen order. Category ids map onto
    // those, so two categories with the same name become one class.
    let mut classes: Vec<String> = Vec::new();
    let mut class_of_category: HashMap<i64, usize> = HashMap::new();
    for c in &data.categories {
        let idx = classes.iter().position(|n| n == &c.name).unwrap_or_else(|| {
            classes.push(c.name.clone());
            classes.len() - 1
        });
        class_of_category.insert(c.id, idx);
    }

    let index = ImageIndex::new(image_filenames, |f| f.to_string());
    let file_by_id: HashMap<i64, &str> = data.images.iter()
        .map(|im| (im.id, im.file_name.as_str())).collect();

    let mut out = ImportedDataset { classes, ..Default::default() };
    let mut unmatched_ids: std::collections::HashSet<i64> = Default::default();
    for ann in &data.annotations {
        let Some(&class_idx) = class_of_category.get(&ann.category_id) else {
            out.skipped_boxes += 1;
            continue;
        };
        let Some(target) = file_by_id.get(&ann.image_id).and_then(|f| index.find(f)) else {
            unmatched_ids.insert(ann.image_id);
            continue;
        };
        let [x, y, w, h] = ann.bbox;
        out.annotations.entry(target.to_string()).or_default()
            .push(ImportedAnnotation { class_idx, x, y, w, h });
    }
    out.unmatched = unmatched_ids.len();
    out.name = data.info.and_then(|i| i.description).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    out
}

// ── YOLO ─────────────────────────────────────────────────

#[tauri::command]
pub async fn import_yolo(
    labels_dir: PathBuf,
    image_dir: PathBuf,
    image_filenames: Vec<String>,
    fallback_classes: Option<Vec<String>>,
) -> Result<ImportedDataset, String> {
    tokio::task::spawn_blocking(move || {
        import_yolo_blocking(&labels_dir, &image_dir, &image_filenames, fallback_classes)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn import_yolo_blocking(
    labels_dir: &Path,
    image_dir: &Path,
    image_filenames: &[String],
    fallback_classes: Option<Vec<String>>,
) -> Result<ImportedDataset, String> {
    // Look for classes.txt next to the labels or in the parent.
    let mut classes: Vec<String> = Vec::new();
    for candidate in [labels_dir.join("classes.txt"), labels_dir.join("..").join("classes.txt")] {
        if let Ok(text) = std::fs::read_to_string(&candidate) {
            classes = text.lines().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
            if !classes.is_empty() { break; }
        }
    }
    if classes.is_empty() {
        match fallback_classes.filter(|f| !f.is_empty()) {
            Some(fb) => classes = fb,
            None => return Ok(ImportedDataset { needs_classes: Some(true), ..Default::default() }),
        }
    }

    let index = ImageIndex::new(image_filenames, strip_ext);
    let mut out = ImportedDataset { classes, ..Default::default() };

    for rel in walk_files(labels_dir)? {
        if !rel.ends_with(".txt") || basename(&rel) == "classes.txt" { continue; }
        let Some(image) = index.find(&strip_ext(&rel)) else {
            out.unmatched += 1;
            continue;
        };
        let Ok(text) = std::fs::read_to_string(labels_dir.join(&rel)) else { continue };

        // YOLO coordinates are fractions of the image size, so the real
        // size is needed. Header-only read, no decode.
        let size = safe_relative(image).ok().and_then(|p| imagesize::size(image_dir.join(p)).ok());
        let Some(size) = size else {
            out.skipped_boxes += text.lines().filter(|l| !l.trim().is_empty()).count();
            continue;
        };

        let mut rows = Vec::new();
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            match parse_yolo_line(line, out.classes.len(), size.width as f64, size.height as f64) {
                Some(a) => rows.push(a),
                None => out.skipped_boxes += 1,
            }
        }
        if !rows.is_empty() {
            out.annotations.insert(image.to_string(), rows);
        }
    }
    Ok(out)
}

/// Parse one detection line, `class cx cy w h [confidence]`, with the centre
/// and size normalised to 0..1, into a pixel box clamped to the image.
/// Returns None for malformed lines and out-of-range classes.
fn parse_yolo_line(line: &str, n_classes: usize, img_w: f64, img_h: f64) -> Option<ImportedAnnotation> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() != 5 && parts.len() != 6 { return None; }
    let class_idx = parts[0].parse::<usize>().ok().filter(|&c| c < n_classes)?;
    let v: Vec<f64> = parts[1..5].iter().map(|p| p.parse::<f64>()).collect::<Result<_, _>>().ok()?;
    if v.iter().any(|n| !n.is_finite()) { return None; }
    let (cx, cy, w, h) = (v[0] * img_w, v[1] * img_h, v[2] * img_w, v[3] * img_h);
    let x1 = (cx - w / 2.0).clamp(0.0, img_w);
    let y1 = (cy - h / 2.0).clamp(0.0, img_h);
    let x2 = (cx + w / 2.0).clamp(0.0, img_w);
    let y2 = (cy + h / 2.0).clamp(0.0, img_h);
    if x2 - x1 <= 0.0 || y2 - y1 <= 0.0 { return None; }
    Some(ImportedAnnotation { class_idx, x: x1, y: y1, w: x2 - x1, h: y2 - y1 })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(v: &[&str]) -> Vec<String> { v.iter().map(|s| s.to_string()).collect() }

    #[test]
    fn yolo_line_is_denormalised_to_top_left_pixels() {
        let a = parse_yolo_line("1 0.5 0.5 0.2 0.4", 2, 1000.0, 500.0).unwrap();
        assert_eq!(a, ImportedAnnotation { class_idx: 1, x: 400.0, y: 150.0, w: 200.0, h: 200.0 });
        // Confidence column is tolerated.
        assert!(parse_yolo_line("0 0.5 0.5 0.1 0.1 0.93", 1, 100.0, 100.0).is_some());
        // Boxes spilling over the edge are clamped.
        let c = parse_yolo_line("0 0.05 0.5 0.2 0.2", 1, 100.0, 100.0).unwrap();
        assert_eq!((c.x, c.w), (0.0, 15.0));
    }

    #[test]
    fn yolo_line_rejects_bad_input() {
        assert!(parse_yolo_line("2 0.5 0.5 0.1 0.1", 2, 100.0, 100.0).is_none()); // class out of range
        assert!(parse_yolo_line("0 0.5 0.5 0.1", 1, 100.0, 100.0).is_none());
        assert!(parse_yolo_line("0 a 0.5 0.1 0.1", 1, 100.0, 100.0).is_none());
        assert!(parse_yolo_line("0 0.1 0.2 0.3 0.4 0.5 0.6 0.7", 1, 100.0, 100.0).is_none()); // polygon
    }

    #[test]
    fn index_prefers_full_path_then_unique_name() {
        let imgs = files(&["train/a.jpg", "val/a.jpg", "train/b.jpg"]);
        let idx = ImageIndex::new(&imgs, strip_ext);
        assert_eq!(idx.find("val/a"), Some("val/a.jpg"));
        assert_eq!(idx.find("b"), Some("train/b.jpg"));
        assert_eq!(idx.find("labels/b"), Some("train/b.jpg"));
        assert_eq!(idx.find("a"), None); // ambiguous
        assert_eq!(idx.find("c"), None);
        let idx = ImageIndex::new(&imgs, |f| f.to_string());
        assert_eq!(idx.find(r"images\train\b.jpg"), Some("train/b.jpg"));
    }

    #[test]
    fn coco_maps_classes_and_files() {
        let data: CocoFile = serde_json::from_value(serde_json::json!({
            "info": { "description": "  set  " },
            "categories": [{"id": 7, "name": "crack"}, {"id": 9, "name": "lump"}, {"id": 11, "name": "crack"}],
            "images": [{"id": 1, "file_name": "a.jpg"}, {"id": 2, "file_name": "gone.jpg"}],
            "annotations": [
                {"image_id": 1, "category_id": 9, "bbox": [1, 2, 3, 4]},
                {"image_id": 1, "category_id": 11, "bbox": [5, 6, 7, 8]},
                {"image_id": 1, "category_id": 99, "bbox": [0, 0, 1, 1]},
                {"image_id": 2, "category_id": 7, "bbox": [0, 0, 1, 1]}
            ]
        })).unwrap();
        let ds = coco_to_dataset(data, &files(&["sub/a.jpg"]));
        assert_eq!(ds.classes, vec!["crack", "lump"]);
        let anns = &ds.annotations["sub/a.jpg"];
        assert_eq!(anns.len(), 2);
        assert_eq!((anns[0].class_idx, anns[1].class_idx), (1, 0));
        assert_eq!(ds.unmatched, 1);
        assert_eq!(ds.skipped_boxes, 1);
        assert_eq!(ds.name.as_deref(), Some("set"));
    }
}
