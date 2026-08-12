/**
 * Cross-platform clipboard API with optional Shizuku background reads on Android.
 *
 * Extends the Tauri clipboard-manager surface (`readText`, `writeText`,
 * `readImage`, `writeImage`, `writeHtml`, `clear`) with a background-watch
 * API. Everything is re-exported as named exports so
 * `import { Clipboard } from "@vistta/js-runtime/plugins"` gives a flat
 * namespace: `Clipboard.readText()`, `Clipboard.watchBackground()`, etc.
 *
 * Android restricts normal clipboard reads to the focused app. When the user
 * has authorized Shizuku or Sui, Vistta automatically polls through its
 * shell/root identity. Otherwise Android falls back to foreground-only polling.
 *
 * Platform matrix:
 * - Android + authorized Shizuku — native shell/root polling.
 * - Android without Shizuku — polling reads only while foregrounded.
 * - Desktop — polling via `setInterval` (works in background).
 * - iOS — polling via `setInterval` (subject to iOS background limits).
 */

import {
  getClipboardBridge,
  isShizukuAuthorized,
  requestShizukuPermission,
  startMonitor,
  stopMonitor,
} from "./privileged-clipboard.js";
import { clearBackgroundInterval, setBackgroundInterval } from "./scheduler.js";

// Re-export the Tauri clipboard-manager commands as named exports so they
// flatten into the `Clipboard` namespace via `export * as Clipboard` in
import { clear, readImage, readText, writeHtml, writeImage, writeText } from "@tauri-apps/plugin-clipboard-manager";

// Re-export so `export * as Clipboard` in `index.js` flattens the Tauri
// commands into the `Clipboard` namespace alongside the background methods.
export { clear, readImage, readText, writeHtml, writeImage, writeText };

let watcher = null;
let lastHash = null;
let listener = null;
let backendListener = null;

/**
 * Returns the `VisttaClipboard` JavascriptInterface bridge if available.
 * Only present on Android (injected by `VisttaPlugin`).
 * @returns {Object|false}
 */
function getBridge() {
  if (typeof window === "undefined") return false;
  return /** @type {any} */ (window).VisttaClipboard || false;
}

export { isShizukuAuthorized, requestShizukuPermission };

/**
 * Reports whether Shizuku or Sui is running and exposes a usable binder.
 */
export function isShizukuAvailable() {
  return getClipboardBridge()?.isShizukuAvailable?.() === true;
}

export function syncClipboard() {
  const b = getBridge();
  if (!b) return false;
  try {
    return b.syncClipboard() === true;
  } catch {
    return false;
  }
}

/**
 * Watches the system clipboard and invokes `onClip` whenever the content
 * changes. On Android with authorized Shizuku or Sui, the callback fires from
 * a native shell/root monitor.
 * Otherwise it polls `readText()` on a background interval and dedups by
 * content.
 *
 * @param {(text: string) => void} onClip - Called with the new clipboard text.
 * @param {number} [pollIntervalMs=2000] - Poll interval for the fallback path.
 * @returns {() => void} A dispose function that stops the watcher.
 */
export function watchBackground(onClip, pollIntervalMs = 2000) {
  if (typeof onClip !== "function") throw new TypeError("onClip must be a function");
  stopBackground();

  listener = (event) => {
    const text = event?.detail?.text;
    if (typeof text === "string" && text.length > 0) onClip(text);
  };
  window.addEventListener("background-clipboard", listener);
  backendListener = () => {
    if (watcher && watcher !== "shizuku") clearBackgroundInterval(watcher);
    watcher = "shizuku";
  };
  window.addEventListener("privileged-clipboard-ready", backendListener);

  const b = getClipboardBridge();
  if (b && isShizukuAuthorized()) {
    try {
      if (startMonitor(pollIntervalMs) === true) {
        watcher = "shizuku";
        return stopBackground;
      }
    } catch {
      // Fall through to foreground-only polling.
    }
  }

  // Fallback: poll readText(). Works in the background on desktop; on
  // Android without Shizuku it only delivers while the app is
  // foregrounded (the OS blocks background reads).
  lastHash = null;
  const id = setBackgroundInterval(async () => {
    let text;
    try {
      text = await readText();
    } catch {
      return;
    }
    if (!text) return;
    const hash = await sha256(text);
    if (hash === lastHash) return;
    lastHash = hash;
    onClip(text);
  }, pollIntervalMs);
  watcher = id;
  return stopBackground;
}

/**
 * Stops the background watcher started by `watchBackground`. Safe to call
 * when no watcher is active.
 */
export function stopBackground() {
  if (listener && typeof window !== "undefined") {
    window.removeEventListener("background-clipboard", listener);
    listener = null;
  }
  if (backendListener && typeof window !== "undefined") {
    window.removeEventListener("privileged-clipboard-ready", backendListener);
    backendListener = null;
  }
  const b = getClipboardBridge();
  if (b) {
    try {
      stopMonitor();
    } catch {
      /* ignore */
    }
  } else if (watcher) {
    clearBackgroundInterval(watcher);
  }
  if (watcher && watcher !== "shizuku") clearBackgroundInterval(watcher);
  watcher = null;
  lastHash = null;
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
