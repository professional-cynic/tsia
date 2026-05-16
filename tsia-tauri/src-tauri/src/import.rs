//! Dataset import — parses COCO JSON or YOLO label folders entirely on the
//! Rust side, so the frontend never needs an fs scope outside AppData.

use crate::util::strip_ext;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Serialize)]
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
pub async fn import_coco(path: PathBuf) -> Result<ImportedDataset, String> {
    let bytes = tokio::fs::read(&path).await.map_err(|e| format!("read: {e}"))?;
    let data: CocoFile = serde_json::from_slice(&bytes).map_err(|e| format!("parse: {e}"))?;

    let classes: Vec<String> = data.categories.iter().map(|c| c.name.clone()).collect();
    let cat_name: HashMap<i64, &str> = data.categories.iter()
        .map(|c| (c.id, c.name.as_str())).collect();
    let class_idx: HashMap<&str, usize> = classes.iter().enumerate()
        .map(|(i, n)| (n.as_str(), i)).collect();
    let file_by_id: HashMap<i64, &str> = data.images.iter()
        .map(|im| (im.id, im.file_name.as_str())).collect();

    let mut annotations: HashMap<String, Vec<ImportedAnnotation>> = HashMap::new();
    for ann in &data.annotations {
        let Some(&fn_str) = file_by_id.get(&ann.image_id) else { continue };
        let idx = cat_name.get(&ann.category_id)
            .and_then(|n| class_idx.get(*n).copied())
            .unwrap_or(0);
        annotations.entry(fn_str.to_string()).or_default().push(ImportedAnnotation {
            class_idx: idx,
            x: ann.bbox[0], y: ann.bbox[1], w: ann.bbox[2], h: ann.bbox[3],
        });
    }

    Ok(ImportedDataset {
        classes,
        annotations,
        name: data.info.and_then(|i| i.description).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        needs_classes: None,
    })
}

// ── YOLO ─────────────────────────────────────────────────

#[tauri::command]
pub async fn import_yolo(
    labels_dir: PathBuf,
    image_filenames: Vec<String>,
    fallback_classes: Option<Vec<String>>,
) -> Result<ImportedDataset, String> {
    // Look for classes.txt next to the labels or in the parent.
    let mut classes: Vec<String> = Vec::new();
    for candidate in [
        labels_dir.join("classes.txt"),
        labels_dir.join("..").join("classes.txt"),
    ] {
        if let Ok(text) = tokio::fs::read_to_string(&candidate).await {
            classes = text.lines().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
            if !classes.is_empty() { break; }
        }
    }

    if classes.is_empty() {
        if let Some(fb) = fallback_classes.filter(|f| !f.is_empty()) {
            classes = fb;
        } else {
            return Ok(ImportedDataset { needs_classes: Some(true), ..Default::default() });
        }
    }

    // Pre-index image filenames by their stem for O(1) lookup.
    let by_stem: HashMap<String, String> = image_filenames.iter()
        .map(|f| (strip_ext(f), f.clone()))
        .collect();

    let mut annotations: HashMap<String, Vec<ImportedAnnotation>> = HashMap::new();
    scan_yolo_dir(&labels_dir, &by_stem, &mut annotations).await?;

    Ok(ImportedDataset { classes, annotations, ..Default::default() })
}

fn scan_yolo_dir<'a>(
    dir: &'a std::path::Path,
    by_stem: &'a HashMap<String, String>,
    out: &'a mut HashMap<String, Vec<ImportedAnnotation>>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        let mut entries = match tokio::fs::read_dir(dir).await {
            Ok(e) => e, Err(_) => return Ok(()),
        };
        while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
                scan_yolo_dir(&path, by_stem, out).await?;
                continue;
            }
            if !name.ends_with(".txt") || name == "classes.txt" { continue; }
            let stem = strip_ext(&name);
            let Some(img_filename) = by_stem.get(&stem) else { continue };
            let Ok(text) = tokio::fs::read_to_string(&path).await else { continue };
            let mut rows = Vec::new();
            for line in text.lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() < 5 { continue; }
                let Ok(class_idx) = parts[0].parse::<usize>() else { continue };
                let Ok(x) = parts[1].parse::<f64>() else { continue };
                let Ok(y) = parts[2].parse::<f64>() else { continue };
                let Ok(w) = parts[3].parse::<f64>() else { continue };
                let Ok(h) = parts[4].parse::<f64>() else { continue };
                rows.push(ImportedAnnotation { class_idx, x, y, w, h });
            }
            if !rows.is_empty() {
                out.insert(img_filename.clone(), rows);
            }
        }
        Ok(())
    })
}
