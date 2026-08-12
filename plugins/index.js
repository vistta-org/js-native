// JS re-exports for Tauri plugins bundled with the runtime.
// `export * as` form (not generated from plugins.config.js) so bundlers
// can tree-shake unused namespaces. Keep this list in sync with plugins.config.js.
//
// `System` re-exports the Tauri core API modules (`@tauri-apps/api/app` and
// `@tauri-apps/api/path`) under one namespace — e.g. `System.getVersion()`
// and `System.downloadDir()`. See `./system.js` for details.
//
// `Clipboard` re-exports the Tauri clipboard-manager commands and adds a
// background-watch surface (`watchBackground`, `stopBackground`,
// `syncClipboard`) that automatically uses the privileged clipboard plugin
// when Shizuku or Sui is already authorized. See `./clipboard.js`.
//
// Note: `Os` is intentionally NOT re-exported. The `@tauri-apps/plugin-os`
// module declares top-level `function platform()` which, in a classic-script
// bundle, collides with `window.platform` (set by the Vistta app to indicate
// the runtime platform). Import OS utilities directly from
// `@tauri-apps/plugin-os` if needed.
export * as Dialog from "@tauri-apps/plugin-dialog";
export * as Filesystem from "@tauri-apps/plugin-fs";
export * as Haptics from "@tauri-apps/plugin-haptics";
export * as Notification from "@tauri-apps/plugin-notification";
export * as Shell from "@tauri-apps/plugin-shell";
export * as Clipboard from "./clipboard.js";
export * as Net from "./net/index.js";
export * as PrivilegedClipboard from "./privileged-clipboard.js";
export * as Scheduler from "./scheduler.js";
export * as System from "./system.js";
export * as Theme from "./theme.js";
