// Toni's Simple Image Annotator (TSIA)
// © 2026 professional-cynic — https://github.com/professional-cynic/tsia
// AGPL-3.0

mod export;
mod fs_helpers;
mod import;
mod merge;
mod opener_bridge;
mod project_file;
mod util;

use std::time::Duration;
use tauri::{Emitter, Manager, WindowEvent};

/// Emitted to the frontend when the OS asks to close the window (Alt+F4,
/// Cmd+Q, taskbar). The frontend flushes its pending autosave and then
/// destroys the window itself.
const CLOSE_REQUESTED_EVENT: &str = "tsia://close-requested";

/// How long the frontend gets to flush before the window is closed anyway,
/// so a broken frontend can never make the window impossible to close.
const CLOSE_GRACE: Duration = Duration::from_secs(5);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Single-instance must be the FIRST plugin registered per docs.
    // Only on desktop platforms; mobile doesn't need it.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second instance was launched. Bring the existing main window
            // forward instead of silently doing nothing.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
        builder = builder.plugin(tauri_plugin_process::init());
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(export::ExportCancel::default());
            app.manage(merge::MergeCancel::default());
            // Pre-create $APPDATA/projects so the frontend's fs scope can be
            // restricted to that subdir only (it can't mkdir its own parent).
            if let Ok(app_data) = app.path().app_data_dir() {
                let projects = app_data.join("projects");
                let _ = std::fs::create_dir_all(&projects);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit(CLOSE_REQUESTED_EVENT, ());
                let window = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(CLOSE_GRACE);
                    let _ = window.destroy();
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            export::export_dataset,
            export::export_cancel,
            export::plan_negatives,
            import::import_coco,
            import::import_yolo,
            merge::merge_projects,
            merge::merge_cancel,
            fs_helpers::scan_image_folder,
            fs_helpers::dir_exists,
            fs_helpers::allow_asset_dir,
            fs_helpers::allow_fs_dir,
            opener_bridge::open_external_url,
            opener_bridge::open_source_folder,
            project_file::write_project_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
