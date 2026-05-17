//! Thin wrapper around tauri-plugin-opener's Rust-side `open_url`.
//!
//! Mirrors the capability-level allowlist on the JS opener command so the
//! Rust bridge can't be used to widen the set of URLs the app can open.
//! When the frontend's hard-coded URLs change, update both here and in the
//! capability file together.

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

const ALLOWED_URLS: &[&str] = &[
    "https://codeberg.org/professional-cynic",
    "https://codeberg.org/professional-cynic/",
    "https://codeberg.org/professional-cynic/tsia",
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
