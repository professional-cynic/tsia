// Toni's Simple Image Annotator (TSIA)
// © 2026 professional-cynic — https://codeberg.org/professional-cynic
// AGPL-3.0

mod export;
mod fs_helpers;
mod import;
mod opener_bridge;
mod util;

use tauri::Manager;

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
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(export::ExportCancel::default());
            // Pre-create $APPDATA/projects so the frontend's fs scope can be
            // restricted to that subdir only (it can't mkdir its own parent).
            if let Ok(app_data) = app.path().app_data_dir() {
                let projects = app_data.join("projects");
                let _ = std::fs::create_dir_all(&projects);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            export::export_dataset,
            export::export_cancel,
            import::import_coco,
            import::import_yolo,
            fs_helpers::scan_image_folder,
            fs_helpers::dir_exists,
            opener_bridge::open_external_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
