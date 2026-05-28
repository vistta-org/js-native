// Vistta.js Runtime - Main entry point
// This file is used by src-tauri/ for building native apps.
// Developers using @vistta/js-runtime never interact with this directly.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "windows")]
    set_app_user_model_id();
    vistta_js_example::run();
}

#[cfg(target_os = "windows")]
fn set_app_user_model_id() {
    use std::os::windows::ffi::OsStrExt;
    use std::ffi::OsStr;
    let wide: Vec<u16> = OsStr::new("vistta_app_id")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(
            windows::core::PCWSTR(wide.as_ptr())
        );
    }
}