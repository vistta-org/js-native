// Vistta.js Runtime - Main entry point
// This file is used by src-tauri/ for building native apps.
// Developers using @vistta/js-runtime never interact with this directly.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    vistta_js_example::run();
}