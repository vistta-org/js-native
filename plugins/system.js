// Re-exports Tauri core API modules (`@tauri-apps/api/app` and
// `@tauri-apps/api/path`) under a single `System` namespace so consumers
// have one import surface for app metadata and system path resolution.
//
// These are part of the Tauri core API, not plugin crates — they don't
// add Rust dependencies or capabilities beyond the core permissions
// already emitted by the runtime (e.g. `core:path:allow-download-dir`).
//
// The two modules have no overlapping export names, so they are flattened
// into one namespace — e.g. `System.getVersion()`, `System.downloadDir()`,
// `System.join()`.
export * from "@tauri-apps/api/app";
export * from "@tauri-apps/api/path";
