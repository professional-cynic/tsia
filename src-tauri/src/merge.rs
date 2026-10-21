//! Project merge — combines two or more projects into a brand-new folder.
//! Every image is COPIED (never hardlinked: the merged project must be fully
//! independent of its sources) under a source-prefixed name so collisions are
//! impossible by construction. The merged `tsia-project.json` is written into
//! the new folder, consistent with the json-lives-with-images model.
//!
//! Class reconciliation, classIdx remapping and building the merged project
//! are done on the frontend, which owns the project format. This command
//! receives the finished project plus a flat list of copy operations; Rust's
//! job is the heavy I/O (copying potentially thousands of files) off the
//! webview, with progress + cancellation. It only touches the project to
//! drop images that weren't copied and to set the folder path.

use crate::project_file::PROJECT_FILE;
use crate::util::{
    create_unique_dir, safe_absolute_dir, safe_relative, slug, write_atomic, CancelFlag, Progress,
};
use serde::Deserialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::ipc::Channel;
use tauri::State;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeCopy {
    /// Absolute path to the source image file.
    pub src_path: PathBuf,
    /// Destination path relative to the new project folder. Must match the
    /// `filename` of the corresponding image in `project`.
    pub dest_filename: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequest {
    /// Parent folder in which to create the new project folder.
    pub out_dir: PathBuf,
    /// The merged project, exactly as it should be saved, minus
    /// `imageDirPath` (only known once the folder exists).
    pub project: serde_json::Value,
    /// All copy operations across the source projects.
    pub copies: Vec<MergeCopy>,
}

#[derive(Default)]
pub struct MergeCancel(pub CancelFlag);

#[tauri::command]
pub fn merge_cancel(state: State<'_, MergeCancel>) {
    state.0.cancel();
}

#[tauri::command]
pub async fn merge_projects(
    state: State<'_, MergeCancel>,
    mut req: MergeRequest,
    on_event: Channel<Progress>,
) -> Result<String, String> {
    let cancel = state.0.clone();
    cancel.reset();

    let name = req.project.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let id = req.project.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let folder_name = format!("{}_{}", slug(name), short_id(id));

    // Always a fresh folder, so the rollback below can't delete anything
    // that existed before.
    let dest_dir = match create_unique_dir(&req.out_dir, &folder_name).await {
        Ok(d) => d,
        Err(e) => {
            let msg = format!("create merge dir: {e}");
            let _ = on_event.send(Progress::Failed { message: msg.clone() });
            return Err(msg);
        }
    };

    let dest_str = dest_dir.to_string_lossy().to_string();
    let result = run(&mut req, &dest_dir, &cancel, &on_event).await;

    match result {
        Ok(true) => {
            let _ = on_event.send(Progress::Done { out_path: dest_str.clone() });
            Ok(dest_str)
        }
        Ok(false) => {
            let _ = tokio::fs::remove_dir_all(&dest_dir).await;
            let _ = on_event.send(Progress::Cancelled);
            // Cancelled isn't an error, but there's no project. Empty string
            // signals "nothing created"; the frontend checks for it.
            Ok(String::new())
        }
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&dest_dir).await;
            let _ = on_event.send(Progress::Failed { message: e.clone() });
            Err(e)
        }
    }
}

async fn run(
    req: &mut MergeRequest,
    dest_dir: &Path,
    cancel: &CancelFlag,
    on_event: &Channel<Progress>,
) -> Result<bool, String> {
    let total = req.copies.len();
    on_event.send(Progress::Start {
        total,
        out_path: dest_dir.to_string_lossy().to_string(),
    }).map_err(|e| e.to_string())?;

    // Destination names of the images that landed on disk. The project file
    // keeps only those, so it never lists an image the folder doesn't have.
    let mut copied: HashSet<&str> = HashSet::new();

    for (idx, copy) in req.copies.iter().enumerate() {
        if cancel.is_cancelled() { return Ok(false); }

        // Copy (never hardlink): the merged project is independent of sources.
        // Non-fatal on error: skip this image, warn, keep going. A missing
        // source (deleted since the project was made) shouldn't abort the merge.
        match copy_one(copy, dest_dir).await {
            Ok(()) => { copied.insert(copy.dest_filename.as_str()); }
            Err(message) => {
                let _ = on_event.send(Progress::Warning {
                    filename: copy.dest_filename.clone(),
                    message,
                });
            }
        }
        on_event.send(Progress::Item {
            current: idx + 1,
            filename: copy.dest_filename.clone(),
        }).map_err(|e| e.to_string())?;
    }

    if cancel.is_cancelled() { return Ok(false); }

    let project = req.project.as_object_mut().ok_or("project is not an object")?;
    if let Some(images) = project.get_mut("images").and_then(|v| v.as_array_mut()) {
        images.retain(|img| {
            img.get("filename").and_then(|f| f.as_str()).is_some_and(|f| copied.contains(f))
        });
    }
    project.insert("imageDirPath".into(), dest_dir.to_string_lossy().into());

    let body = serde_json::to_vec_pretty(&req.project).map_err(|e| e.to_string())?;
    write_atomic(&dest_dir.join(PROJECT_FILE), &body)
        .await
        .map_err(|e| format!("write project file: {e}"))?;

    Ok(true)
}

async fn copy_one(copy: &MergeCopy, dest_dir: &Path) -> Result<(), String> {
    safe_absolute_dir(&copy.src_path).map_err(|e| format!("source {e}"))?;
    let dst = dest_dir.join(safe_relative(&copy.dest_filename)?);
    // Images from a subfolder of a source project keep that subfolder.
    if let Some(parent) = dst.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| format!("mkdir failed: {e}"))?;
    }
    tokio::fs::copy(&copy.src_path, &dst).await.map_err(|e| format!("copy failed: {e}"))?;
    Ok(())
}

/// Last segment of a project id, trimmed, for a short unique folder suffix.
fn short_id(id: &str) -> String {
    let tail = id.rsplit('_').next().unwrap_or(id);
    let s: String = tail.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if s.is_empty() { "merged".to_string() } else { s }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_id_uses_last_segment() {
        assert_eq!(short_id("proj_1700000000000_ab12cd"), "ab12cd");
        assert_eq!(short_id("___"), "merged");
    }

    #[tokio::test]
    async fn copy_one_creates_subfolders_and_rejects_escapes() {
        let base = std::env::temp_dir().join(format!("tsia-merge-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("src/sub")).unwrap();
        std::fs::create_dir_all(base.join("dst")).unwrap();
        std::fs::write(base.join("src/sub/a.jpg"), b"x").unwrap();

        let ok = MergeCopy { src_path: base.join("src/sub/a.jpg"), dest_filename: "p_sub/a.jpg".into() };
        copy_one(&ok, &base.join("dst")).await.unwrap();
        assert!(base.join("dst/p_sub/a.jpg").exists());

        let escape = MergeCopy { src_path: base.join("src/sub/a.jpg"), dest_filename: "../a.jpg".into() };
        assert!(copy_one(&escape, &base.join("dst")).await.is_err());
        assert!(!base.join("a.jpg").exists());

        std::fs::remove_dir_all(&base).unwrap();
    }
}
