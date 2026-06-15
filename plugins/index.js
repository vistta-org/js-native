// JS re-exports for Tauri plugins bundled with the runtime.
// `export * as` form (not generated from plugins.config.js) so bundlers
// can tree-shake unused namespaces. Keep this list in sync with plugins.config.js.
//
// Note: `Os` is intentionally NOT re-exported. The `@tauri-apps/plugin-os`
// module declares top-level `function platform()` which, in a classic-script
// bundle, collides with `window.platform` (set by the Vistta app to indicate
// the runtime platform). Import OS utilities directly from
// `@tauri-apps/plugin-os` if needed.
export * as Clipboard from "@tauri-apps/plugin-clipboard-manager";
export * as Dialog from "@tauri-apps/plugin-dialog";
export * as Filesystem from "@tauri-apps/plugin-fs";
export * as Haptics from "@tauri-apps/plugin-haptics";
export * as Notification from "@tauri-apps/plugin-notification";
export * as Shell from "@tauri-apps/plugin-shell";
export * as Scheduler from "./scheduler.js";
