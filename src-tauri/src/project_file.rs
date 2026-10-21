//! Writing `tsia-project.json`, the only copy of a project's annotations.
//!
//! The frontend autosaves roughly once a second, so the write must never leave
//! a half-written file behind: it goes to a temp file first and is renamed
//! over the old one (see `write_atomic`). Writes are also serialised, so two
//! overlapping saves can't race on the temp file.

use crate::util::{safe_absolute_dir, write_atomic};
use std::path::PathBuf;
use tokio::sync::Mutex;

pub const PROJECT_FILE: &str = "tsia-project.json";

static WRITE_LOCK: Mutex<()> = Mutex::const_new(());

/// Save a project's JSON into its image folder.
///
/// `dir` comes from the project's `imageDirPath`: it must be absolute, free
/// of `..`, and an existing directory. The file name is fixed here, so the
/// command can't be used to write anything else.
#[tauri::command]
pub async fn write_project_file(dir: PathBuf, contents: String) -> Result<(), String> {
    safe_absolute_dir(&dir)?;
    let meta = tokio::fs::metadata(&dir).await.map_err(|e| format!("cannot save to {}: {e}", dir.display()))?;
    if !meta.is_dir() {
        return Err(format!("cannot save to {}: not a directory", dir.display()));
    }
    let _guard = WRITE_LOCK.lock().await;
    write_atomic(&dir.join(PROJECT_FILE), contents.as_bytes())
        .await
        .map_err(|e| format!("cannot save {}: {e}", dir.join(PROJECT_FILE).display()))
}
