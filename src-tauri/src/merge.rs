//! Project merge — combines two projects into a brand-new folder. Every image
//! is COPIED (never hardlinked: the merged project must be fully independent of
//! its sources) under a filesystem-safe, source-prefixed name so collisions are
//! impossible by construction. The merged `tsia-project.json` is written into
//! the new folder, consistent with the json-lives-with-images model.
//!
//! Class reconciliation and classIdx remapping are done on the frontend; this
//! command receives a finished manifest: the final class list, the output
//! project metadata, and a flat list of copy operations each carrying its
//! already-remapped boxes. Rust's job is the heavy I/O (copying potentially
//! thousands of files) off the webview, with progress + cancellation.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeBox {
    pub class_idx: i64,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub id: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeImage {
    /// Absolute path to the source image file.
    pub src_path: PathBuf,
    /// Destination filename (already sanitised + source-prefixed by frontend).
    pub dest_filename: String,
    /// Boxes with classIdx already remapped to the merged class ordering.
    pub boxes: Vec<MergeBox>,
    pub reviewed: Option<bool>,
    pub dims: Option<Dims>,
}

#[derive(Deserialize, Serialize, Clone, Copy)]
pub struct Dims { pub w: f64, pub h: f64 }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequest {
    /// Parent folder in which to create the new project folder.
    pub out_dir: PathBuf,
    /// Desired name for the new folder + project.
    pub project_name: String,
    /// Stable id for the new project (generated frontend-side).
    pub project_id: String,
    /// Final merged class list.
    pub classes: Vec<String>,
    /// ISO timestamp for createdAt.
    pub created_at: String,
    /// All copy operations across both source projects.
    pub images: Vec<MergeImage>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "data")]
pub enum MergeProgress {
    Start { total: usize, out_path: String },
    Item { current: usize, filename: String },
    Warning { filename: String, message: String },
    Done { out_path: String },
    Cancelled,
    Failed { message: String },
}

#[derive(Default)]
pub struct MergeCancel(pub Arc<AtomicBool>);

#[tauri::command]
pub async fn merge_cancel(state: State<'_, MergeCancel>) -> Result<(), String> {
    state.0.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn merge_projects(
    state: State<'_, MergeCancel>,
    req: MergeRequest,
    on_event: Channel<MergeProgress>,
) -> Result<String, String> {
    let cancel = state.0.clone();
    cancel.store(false, Ordering::Relaxed);

    let folder_name = format!("{}_{}", slug(&req.project_name), short_id(&req.project_id));
    let dest_dir = req.out_dir.join(&folder_name);

    if let Err(e) = tokio::fs::create_dir_all(&dest_dir).await {
        let msg = format!("create merge dir: {e}");
        let _ = on_event.send(MergeProgress::Failed { message: msg.clone() });
        return Err(msg);
    }

    let dest_str = dest_dir.to_string_lossy().to_string();
    let result = run(&req, &dest_dir, &cancel, &on_event).await;

    match result {
        Ok(true) => {
            let _ = on_event.send(MergeProgress::Done { out_path: dest_str.clone() });
            Ok(dest_str)
        }
        Ok(false) => {
            let _ = tokio::fs::remove_dir_all(&dest_dir).await;
            let _ = on_event.send(MergeProgress::Cancelled);
            // Cancelled isn't an error, but there's no project. Empty string
            // signals "nothing created"; the frontend checks for it.
            Ok(String::new())
        }
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&dest_dir).await;
            let _ = on_event.send(MergeProgress::Failed { message: e.clone() });
            Err(e)
        }
    }
}

async fn run(
    req: &MergeRequest,
    dest_dir: &std::path::Path,
    cancel: &Arc<AtomicBool>,
    on_event: &Channel<MergeProgress>,
) -> Result<bool, String> {
    let total = req.images.len();
    on_event.send(MergeProgress::Start {
        total,
        out_path: dest_dir.to_string_lossy().to_string(),
    }).map_err(|e| e.to_string())?;

    // Build the project JSON image entries as we copy, so the written file
    // reflects exactly what landed on disk.
    let mut json_images: Vec<serde_json::Value> = Vec::with_capacity(total);

    for (idx, img) in req.images.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) { return Ok(false); }

        let dst = dest_dir.join(&img.dest_filename);
        // Copy (never hardlink): the merged project is independent of sources.
        if let Err(e) = tokio::fs::copy(&img.src_path, &dst).await {
            // Non-fatal: skip this image, warn, keep going. A missing source
            // (deleted since the project was made) shouldn't abort the merge.
            let _ = on_event.send(MergeProgress::Warning {
                filename: img.dest_filename.clone(),
                message: format!("copy failed: {e}"),
            });
            let _ = on_event.send(MergeProgress::Item {
                current: idx + 1,
                filename: img.dest_filename.clone(),
            });
            continue;
        }

        let boxes: Vec<serde_json::Value> = img.boxes.iter().map(|b| serde_json::json!({
            "id": b.id,
            "classIdx": b.class_idx,
            "x": b.x, "y": b.y, "w": b.w, "h": b.h,
        })).collect();

        let mut entry = serde_json::json!({
            "filename": img.dest_filename,
            "boxes": boxes,
        });
        if let Some(r) = img.reviewed { entry["reviewed"] = serde_json::json!(r); }
        if let Some(d) = img.dims { entry["dims"] = serde_json::json!({ "w": d.w, "h": d.h }); }
        json_images.push(entry);

        on_event.send(MergeProgress::Item {
            current: idx + 1,
            filename: img.dest_filename.clone(),
        }).map_err(|e| e.to_string())?;
    }

    if cancel.load(Ordering::Relaxed) { return Ok(false); }

    // nextBoxId: one past the highest id we wrote, so future boxes don't collide.
    let max_id = req.images.iter()
        .flat_map(|i| i.boxes.iter().map(|b| b.id))
        .max()
        .unwrap_or(-1);

    let project = serde_json::json!({
        "id": req.project_id,
        "name": req.project_name,
        "classes": req.classes,
        "images": json_images,
        "imageDirPath": dest_dir.to_string_lossy(),
        "nextBoxId": max_id + 1,
        "createdAt": req.created_at,
    });

    let json_path = dest_dir.join("tsia-project.json");
    tokio::fs::write(&json_path, serde_json::to_string_pretty(&project).unwrap())
        .await
        .map_err(|e| format!("write project file: {e}"))?;

    Ok(true)
}

/// Filesystem-safe slug (same rules as export's slug).
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

/// Last segment of a project id, trimmed, for a short unique folder suffix.
fn short_id(id: &str) -> String {
    let tail = id.rsplit('_').next().unwrap_or(id);
    let s: String = tail.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if s.is_empty() { "merged".to_string() } else { s }
}
