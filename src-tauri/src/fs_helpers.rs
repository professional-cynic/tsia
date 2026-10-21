//! Helpers used by the new-project flow that scan filesystem locations the
//! frontend can't reach without an fs scope.
//!
//! ## Security note
//!
//! These commands accept arbitrary paths from the frontend and act on them
//! with the process's full filesystem access. That's intentional — Rust
//! commands replace the frontend's fs scope for non-AppData paths — but it
//! means **these commands ARE the security boundary**. The frontend should
//! only ever invoke them with paths the user picked via a dialog. Adding new
//! Rust fs commands without that discipline would widen the attack surface.

use crate::util::safe_absolute_dir;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_fs::FsExt;

const IMG_EXT: &[&str] = &["png", "jpg", "jpeg", "bmp", "webp"];

/// Every supported image under `dir`, recursively, as sorted `/`-separated
/// paths relative to `dir`.
#[tauri::command]
pub async fn scan_image_folder(dir: PathBuf) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let mut out: Vec<String> = Vec::new();
        for rel in walk_files(&dir)? {
            let is_image = Path::new(&rel).extension().and_then(|e| e.to_str())
                .is_some_and(|ext| IMG_EXT.iter().any(|e| ext.eq_ignore_ascii_case(e)));
            if is_image { out.push(rel); }
        }
        out.sort();
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Returns true if the path exists and is a directory. Used by the
/// project-open flow to detect a moved image folder and prompt the user.
#[tauri::command]
pub async fn dir_exists(path: PathBuf) -> bool {
    match tokio::fs::metadata(&path).await {
        Ok(m) => m.is_dir(),
        Err(_) => false,
    }
}

/// Expand the asset protocol's runtime scope to cover a single directory,
/// recursively. Used by the frontend whenever a project is opened or created
/// so its image folder can be served to the webview via `convertFileSrc`.
///
/// The static scope in `tauri.conf.json` is empty — every accessible path is
/// added here, at runtime, in response to an explicit user action (the dir
/// having been picked from a dialog). This restricts the asset protocol to
/// exactly the folders the user has chosen this session.
///
/// Returns Err if the path is unsafe, missing or isn't a directory.
/// Project-open flows should call `dir_exists` first and trigger the relocate
/// prompt on false before invoking this; new-project flows have already
/// validated via the dialog. A best-effort caller can still ignore the error —
/// the only observable consequence is that the canvas will fail to load
/// images for the session.
#[tauri::command]
pub async fn allow_asset_dir(app: AppHandle, dir: PathBuf) -> Result<(), String> {
    check_dir(&dir).await?;
    app.asset_protocol_scope()
        .allow_directory(&dir, true)
        .map_err(|e| format!("allow_directory: {e}"))
}

/// Expand the fs plugin's runtime scope to cover a single directory,
/// recursively. Needed because the project JSON lives inside the image
/// folder (`<dir>/tsia-project.json`) so it travels with the dataset on
/// backup/move. The static fs scope only covers $APPDATA; image folders are
/// user-picked and added here at runtime, same discipline as the asset scope.
///
/// Returns Err if the path is unsafe, missing or isn't a directory.
#[tauri::command]
pub async fn allow_fs_dir(app: AppHandle, dir: PathBuf) -> Result<(), String> {
    check_dir(&dir).await?;
    app.fs_scope()
        .allow_directory(&dir, true)
        .map_err(|e| format!("allow_directory: {e}"))
}

async fn check_dir(dir: &Path) -> Result<(), String> {
    safe_absolute_dir(dir)?;
    let meta = tokio::fs::metadata(dir).await.map_err(|e| format!("stat: {e}"))?;
    if !meta.is_dir() {
        return Err("path is not a directory".to_string());
    }
    Ok(())
}

/// All regular files under `base`, recursively, as `/`-separated paths
/// relative to `base`. Unreadable subfolders and entries are skipped; only a
/// failure to read `base` itself is an error. Blocking: call it from
/// `spawn_blocking`.
pub fn walk_files(base: &Path) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut stack: Vec<(PathBuf, String)> = vec![(base.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) if prefix.is_empty() => return Err(e.to_string()),
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let rel = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
            match entry.file_type() {
                Ok(t) if t.is_dir() => stack.push((entry.path(), rel)),
                Ok(t) if t.is_file() || t.is_symlink() => out.push(rel),
                _ => {}
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walk_files_is_recursive_and_relative() {
        let base = std::env::temp_dir().join(format!("tsia-walk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("a/b")).unwrap();
        std::fs::write(base.join("top.jpg"), b"").unwrap();
        std::fs::write(base.join("a/b/deep.PNG"), b"").unwrap();
        let mut files = walk_files(&base).unwrap();
        files.sort();
        assert_eq!(files, vec!["a/b/deep.PNG", "top.jpg"]);
        assert!(walk_files(&base.join("missing")).is_err());
        std::fs::remove_dir_all(&base).unwrap();
    }
}
