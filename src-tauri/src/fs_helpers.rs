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
