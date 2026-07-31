/**
 * Cross-platform clipboard API with background-read support on Android.
 *
 * Extends the Tauri clipboard-manager surface (`readText`, `writeText`,
 * `readImage`, `writeImage`, `writeHtml`, `clear`) with a background-watch
 * API. Everything is re-exported as named exports so
 * `import { Clipboard } from "@vistta/js-runtime/plugins"` gives a flat
 * namespace: `Clipboard.readText()`, `Clipboard.watchBackground()`, etc.
 *
 * Background watching on Android 10+:
 *   Android restricts `ClipboardManager.primaryClip` reads to the foreground
 *   app, the default IME, or an enabled AccessibilityService. The runtime
 *   ships `VisttaAccessibilityService`; once the user enables it under
 *   Settings → Accessibility, clip changes fire a `background-clipboard`
 *   CustomEvent on `window` with `{ text, type }`. `watchBackground` listens
 *   for that event and forwards the text to the supplied callback.
 *
 *   On desktop / iOS / Android-without-the-service, `watchBackground` falls
 *   back to polling `readText()` on a `setBackgroundInterval` so the API is
 *   usable everywhere; callers that need true background reads on Android
 *   should check `isAccessibilityEnabled()` and prompt the user to enable
 *   the service via `openAccessibilitySettings()` when it returns false.
 *
 * Platform matrix:
 * - Android + service enabled — native `OnPrimaryClipChangedListener` (event-driven, true background).
 * - Android + service disabled — falls back to polling (reads return null while backgrounded).
 * - Desktop — polling via `setInterval` (works in background).
 * - iOS — polling via `setInterval` (subject to iOS background limits).
 */

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

/**
 * Returns the `VisttaClipboard` JavascriptInterface bridge if available.
 * Only present on Android (injected by `VisttaPlugin`).
 * @returns {Object|false}
 */
function getBridge() {
  if (typeof window === "undefined") return false;
  return /** @type {any} */ (window).VisttaClipboard || false;
}

/**
 * Reports whether the Vistta accessibility service is enabled in Android
 * Settings. When `false`, `watchBackground` cannot read the clipboard
 * while the app is backgrounded; call `openAccessibilitySettings()` to
 * send the user to the relevant system screen.
 *
 * @returns {boolean} `true` on Android when the service is enabled; `false` on desktop/iOS or when disabled.
 */
export function isAccessibilityEnabled() {
  const b = getBridge();
  if (!b) return false;
  try {
    return b.isAccessibilityEnabled() === true;
  } catch {
    return false;
  }
}

/**
 * Launches the Android Accessibility settings screen so the user can
 * enable the Vistta service. No-op on desktop/iOS.
 */
export function openAccessibilitySettings() {
  const b = getBridge();
  if (!b) return;
  try {
    b.openAccessibilitySettings();
  } catch {
    /* ignore */
  }
}

/**
 * Watches the system clipboard and invokes `onClip` whenever the content
 * changes. On Android with the accessibility service enabled, the callback
 * fires from a native `OnPrimaryClipChangedListener` (true background).
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

  const b = getBridge();
  if (b && isAccessibilityEnabled()) {
    listener = (event) => {
      const text = event?.detail?.text;
      if (typeof text === "string" && text.length > 0) onClip(text);
    };
    window.addEventListener("background-clipboard", listener);
    // Start a native poll loop as a reliability fallback. The
    // OnPrimaryClipChangedListener may be deferred by the OS when the
    // app is backgrounded; the native poll reads the clipboard via the
    // accessibility service's privilege and delivers changes through the
    // same `background-clipboard` event.
    try {
      b.startPoll(pollIntervalMs);
    } catch {
      /* ignore */
    }
    watcher = "native";
    return stopBackground;
  }

  // Fallback: poll readText(). Works in the background on desktop; on
  // Android without the service it only delivers while the app is
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
  if (watcher === "native") {
    const b = getBridge();
    if (b) {
      try {
        b.stopPoll();
      } catch {
        /* ignore */
      }
    }
  } else if (watcher) {
    clearBackgroundInterval(watcher);
  }
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
