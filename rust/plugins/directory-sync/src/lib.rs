#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::Manager;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Wry,
};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop;

pub fn init() -> TauriPlugin<Wry> {
    let builder = Builder::new("directory-sync");
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        desktop::probe_root,
        desktop::start_scan,
        desktop::next_scan_page,
        desktop::cancel_operation,
        desktop::begin_lease,
        desktop::end_lease,
        desktop::hash_file,
        desktop::read_file_chunk,
        desktop::begin_write,
        desktop::write_chunk,
        desktop::commit_write,
        desktop::abort_write,
        desktop::recover_root,
    ]);

    builder
        .setup(|_app, api| {
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            _app.manage(desktop::DirectorySyncState::default());
            #[cfg(target_os = "android")]
            api.register_android_plugin("org.vistta.directorysync", "DirectorySyncPlugin")?;
            #[cfg(not(target_os = "android"))]
            let _ = api;
            Ok(())
        })
        .build()
}
