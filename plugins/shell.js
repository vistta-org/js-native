/**
 * Cross-platform shell plugin with Android APK installer support.
 *
 * Re-exports the Tauri `@tauri-apps/plugin-shell` surface (`Command`, `open`,
 * etc.) and overrides `open` on Android so that opening a local `.apk` file
 * launches the system package installer via the `VisttaInstaller`
 * JavascriptInterface bridge (injected by `VisttaPlugin`), using the app's
 * `FileProvider` to share the file with the installer.
 *
 * Platform matrix:
 * - Android — `.apk` files are routed through `VisttaInstaller.installApk`;
 *   all other paths/URLs fall through to the Tauri shell `open` command.
 * - Desktop / iOS — Tauri's `@tauri-apps/plugin-shell` `open` unchanged.
 * - Browser — not applicable (the plugin is not used in browser builds).
 */

import { Command, EventEmitter, open as tauriOpen } from "@tauri-apps/plugin-shell";

function getAndroidBridge() {
  if (typeof window === "undefined") return false;
  return /** @type {any} */ (window).VisttaInstaller || false;
}

/**
 * Opens a path or URL with the system's default application.
 *
 * On Android, if `path` points to a local `.apk` file, the system package
 * installer is launched via the `VisttaInstaller` bridge. On all other
 * platforms (and for non-APK paths/URLs on Android), this delegates to
 * Tauri's `@tauri-apps/plugin-shell` `open`.
 *
 * @param {string} path - The path or URL to open.
 * @param {string} [openWith] - The app to open the file or URL with.
 */
export async function open(path, openWith) {
  if (path && typeof path === "string" && path.toLowerCase().endsWith(".apk")) {
    const bridge = getAndroidBridge();
    if (bridge) return bridge.installApk(path);
  }
  return tauriOpen(path, openWith);
}

export { Command, EventEmitter };
