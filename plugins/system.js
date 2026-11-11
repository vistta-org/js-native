// Re-exports Tauri core API modules (`@tauri-apps/api/app` and
// `@tauri-apps/api/path`) under a single `System` namespace so consumers
// have one import surface for app metadata and system path resolution.
//
// Login startup uses the desktop autostart plugin and its permissions.
//
// The two modules have no overlapping export names, so they are flattened
// into one namespace — e.g. `System.getVersion()`, `System.downloadDir()`,
// `System.join()`.
export * from "@tauri-apps/api/app";
export * from "@tauri-apps/api/path";
export {
  enable as enableAutostart,
  disable as disableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
