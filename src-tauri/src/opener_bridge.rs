//! Rust-side bridge to tauri-plugin-opener.
//!
//! Two commands with deliberately different security models:
//!
//! * `open_external_url` mirrors the capability-level allowlist on the JS
//!   opener command, so the Rust bridge can't be used to widen the set of URLs
//!   the app can open. When the frontend's hard-coded URLs change, update both
//!   here and in the capability file together.
//! * `open_source_folder` can't use an allowlist (image folders are arbitrary
//!   user-picked paths), so it validates structurally instead. See its docs.
//!
//! Both are invoked with paths/URLs from the frontend and act with the
//! process's full privileges: **these commands are the security boundary.**

use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

const ALLOWED_URLS: &[&str] = &[
    "https://codeberg.org/professional-cynic",
    "https://codeberg.org/professional-cynic/",
    "https://codeberg.org/professional-cynic/tsia",
    "https://github.com/professional-cynic/tsia/releases/latest",
    "https://www.gnu.org/licenses/agpl-3.0.html",
];

#[tauri::command]
pub fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    if !ALLOWED_URLS.contains(&url.as_str()) {
        return Err(format!("URL not in allowlist: {url}"));
    }
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Open a project's image folder in the system file manager.
///
/// Unlike `open_external_url` this can't use a fixed allowlist: image folders
/// are arbitrary paths the user picked from a dialog. So **this command is the
/// security boundary** and the checks below are the whole of it:
///
///   * absolute path only (a relative path would resolve against the app's cwd)
///   * no `..` component (no traversal out of the folder the user chose)
///   * must exist AND be a directory: without the directory check a file path
///     could be smuggled in, and `open_path` on a file *launches* it with its
///     default application, which would turn "show me my images" into arbitrary
///     program execution.
///
/// The path normally comes from a project's `imageDirPath`, which the frontend
/// already validates on load, but this must stand on its own.
#[tauri::command]
pub async fn open_source_folder(app: AppHandle, dir: PathBuf) -> Result<(), String> {
    if !dir.is_absolute() {
        return Err("path is not absolute".to_string());
    }
    if dir.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("path contains a parent-directory traversal".to_string());
    }
    let meta = tokio::fs::metadata(&dir)
        .await
        .map_err(|e| format!("cannot open {}: {e}", dir.display()))?;
    if !meta.is_dir() {
        return Err("path is not a directory".to_string());
    }
    open_dir(&app, &dir)
}

fn open_dir(app: &AppHandle, dir: &Path) -> Result<(), String> {
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}
