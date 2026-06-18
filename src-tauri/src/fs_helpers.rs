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

use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tauri_plugin_fs::FsExt;

const IMG_EXT: &[&str] = &["png", "jpg", "jpeg", "bmp", "webp"];

#[tauri::command]
pub async fn scan_image_folder(dir: PathBuf) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    scan(&dir, "", &mut out).await?;
    out.sort();
    Ok(out)
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
/// Returns Err if the path is missing or isn't a directory. Project-open
/// flows should call `dir_exists` first and trigger the relocate prompt on
/// false before invoking this; new-project flows have already validated via
/// the dialog. A best-effort caller can still ignore the error — the only
/// observable consequence is that the canvas will fail to load images for
/// the session.
#[tauri::command]
pub async fn allow_asset_dir(app: AppHandle, dir: PathBuf) -> Result<(), String> {
    let meta = tokio::fs::metadata(&dir).await.map_err(|e| format!("stat: {e}"))?;
    if !meta.is_dir() {
        return Err("path is not a directory".to_string());
    }
    app.asset_protocol_scope()
        .allow_directory(&dir, true)
        .map_err(|e| format!("allow_directory: {e}"))
}

/// Expand the fs plugin's runtime scope to cover a single directory,
/// recursively. Needed because the project JSON now lives inside the image
/// folder (`<dir>/tsia-project.json`) so it travels with the dataset on
/// backup/move. The static fs scope only covers $APPDATA; image folders are
/// user-picked and added here at runtime, same discipline as the asset scope.
///
/// Returns Err if the path is missing or isn't a directory.
#[tauri::command]
pub async fn allow_fs_dir(app: AppHandle, dir: PathBuf) -> Result<(), String> {
    let meta = tokio::fs::metadata(&dir).await.map_err(|e| format!("stat: {e}"))?;
    if !meta.is_dir() {
        return Err("path is not a directory".to_string());
    }
    let scope = app.fs_scope();
    scope.allow_directory(&dir, true).map_err(|e| format!("allow_directory: {e}"))?;
    Ok(())
}

fn scan<'a>(
    base: &'a std::path::Path,
    prefix: &'a str,
    out: &'a mut Vec<String>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        let mut entries = tokio::fs::read_dir(base).await.map_err(|e| e.to_string())?;
        while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            let ft = match entry.file_type().await { Ok(t) => t, Err(_) => continue };
            if ft.is_dir() {
                let next_prefix = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
                scan(&path, &next_prefix, out).await?;
            } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if IMG_EXT.iter().any(|e| ext.eq_ignore_ascii_case(e)) {
                    let rel = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
                    out.push(rel);
                }
            }
        }
        Ok(())
    })
}
