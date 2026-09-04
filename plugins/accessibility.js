/**
 * Cross-platform accessibility / quick-action API.
 *
 * Exposes user-visible entry points into the app that are surfaced by the OS
 * outside the app's own UI:
 *
 * - **Desktop** — items in the system-tray menu (when `app.background` is on).
 *   Tauri's `TrayIcon` menu is rebuilt at runtime from the list passed to
 *   `setShortcuts()`, and clicks are delivered as `launch-action` events.
 * - **Android** — launcher shortcuts shown when the user long-presses the app
 *   icon. Published dynamically via `ShortcutManager` through the
 *   `VisttaShortcuts` JavascriptInterface bridge. Selecting one launches the
 *   activity with an intent extra that `MainActivity.onNewIntent` / `onCreate`
 *   forwards into the webview as a `launch-action` event.
 * - **iOS / browser** — no native surface; `setShortcuts` is a no-op and
 *   `onLaunchAction` never fires.
 *
 * The connect app owns the single source of truth for the action set: it
 * declares `{ id, label, icon }` entries and a handler, calls `setShortcuts`
 * to publish them, and registers `onLaunchAction` to receive triggers. Both
 * native surfaces funnel back into the same JS event, so action logic lives
 * entirely in JS — native code only carries `{ id, label, icon }` in and
 * `{ id, payload }` out.
 *
 * The namespace is named `Accessibility` because these entry points are the
 * accessibility-adjacent surface for reaching app actions from outside the app
 * UI. The wire-protocol names (`setShortcuts`, `onLaunchAction`, the
 * `VisttaShortcuts` bridge, and the `set-shortcuts` / `launch-action` events)
 * are kept as-is — they are the native contract and are not renamed to avoid
 * churn in the Kotlin / Rust layers.
 *
 * @module accessibility
 */

import { listen } from "@tauri-apps/api/event";

/**
 * @typedef {Object} Shortcut
 * @property {string} id - Stable action identifier delivered back in
 *   `launch-action` events. Must be unique within the set.
 * @property {string} label - User-visible label shown in the tray menu / launcher.
 * @property {string} [icon] - Optional icon identifier. On Android this is the
 *   name of a drawable resource (without the `R.drawable.` prefix and without
 *   a file extension) bundled with the app; on desktop it is currently
 *   ignored (tray items are text-only). If omitted (or unresolvable) on
 *   Android, the shortcut publishes with a transparent icon so the launcher
 *   shows no icon instead of the default app icon.
 * @property {string} [payload] - Optional opaque payload string forwarded
 *   unchanged in the `launch-action` event. Useful for parameterised actions
 *   (e.g. opening a specific note id).
 */

/** @type {((e: { id: string, payload?: any }) => void) | null} */
let handler = null;
let installed = false;

/**
 * Returns the `VisttaShortcuts` JavascriptInterface bridge if available.
 * Only present on Android (injected by `VisttaPlugin`).
 * @returns {Object|false}
 */
function getBridge() {
  if (typeof window === "undefined") return false;
  return /** @type {any} */ (window).VisttaShortcuts || false;
}

function ensureListener() {
  if (installed) return;
  installed = true;
  // @ts-ignore
  if (typeof window !== "undefined" && window.__TAURI__) {
    listen("launch-action", (event) => {
      const { id, payload } = event.payload || {};
      if (id) dispatch(id, payload);
    }).catch(() => {
      // Listening is best-effort; if the event plugin isn't available
      // (e.g. browser build), fall back to the window-event path below.
    });
  }
  if (typeof window !== "undefined") {
    window.addEventListener("launch-action", (/** @type {any} */ e) => {
      const { id, payload } = e.detail || {};
      if (id) dispatch(id, payload);
    });
  }
}

/**
 * Internal: invoke the registered handler for an action id. JSON
 * object/array payloads are parsed back into their JS value; any other
 * payload passes through unchanged.
 * @param {string} id
 * @param {any} [payload]
 */
function dispatch(id, payload) {
  if (typeof payload === "string") {
    const s = payload.trimStart();
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        payload = JSON.parse(s);
      } catch {
        /* not JSON — deliver the raw string */
      }
    }
  }
  if (handler) {
    try {
      handler({ id, payload });
    } catch {
      /* swallow handler errors; the runtime must not crash on a bad action */
    }
  }
}

/**
 * Publishes the current set of quick-actions to the native surface
 * (tray menu on desktop, launcher shortcuts on Android).
 *
 * Safe to call repeatedly; the native menu / shortcut list is rebuilt from
 * `shortcuts` each time. Passing an empty array clears all dynamic entries
 * (the tray's built-in Show/Quit items remain on desktop).
 *
 * No-op on iOS and browser builds.
 *
 * @param {Shortcut[]} shortcuts
 * @returns {Promise<boolean>} Resolves `true` if a native surface accepted the
 *   list, `false` if no surface was available (browser/iOS, or Android before
 *   the bridge is injected).
 */
export async function setShortcuts(shortcuts) {
  if (!Array.isArray(shortcuts)) return false;
  const list = shortcuts.map((s) => ({
    id: String(s.id),
    label: String(s.label ?? s.id),
    icon: s.icon ? String(s.icon) : "",
    payload: s.payload ? String(s.payload) : "",
  }));
  const bridge = getBridge();
  if (bridge) {
    try {
      bridge.setShortcuts(JSON.stringify(list));
      return true;
    } catch {
      return false;
    }
  }
  // @ts-ignore
  if (typeof window !== "undefined" && window.__TAURI__) {
    try {
      const { emit } = await import("@tauri-apps/api/event");
      await emit("set-shortcuts", list);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Publishes the payload the system assistant trigger (Android Digital
 * Assistant app — long-press power / assistant gesture, `ACTION_ASSIST`)
 * delivers when the app is built with `app.assistant: true`. Payload-only:
 * the trigger always opens the app as the `assistant` action.
 *
 * The payload may be any JSON-serializable value — objects/arrays are
 * serialized by the runtime for the native layer and parsed back into their
 * JS value before the `launch-action` event is delivered — or a plain
 * string, which is forwarded unchanged.
 *
 * The payload is forwarded to the native bridge so it survives a cold start
 * (the JS list is not available until the webview boots).
 *
 * Safe to call repeatedly. Passing `null`/`undefined` clears the payload.
 * No-op on iOS and browser builds.
 *
 * @param {any} [payload] - Payload delivered in the `launch-action` event's
 *   `payload` field. Serialization is handled by the runtime.
 * @returns {Promise<boolean>} Resolves `true` if a native surface accepted
 *   the payload, `false` if no surface was available.
 */
export async function setAssistant(payload) {
  const bridge = getBridge();
  if (bridge) {
    try {
      if (typeof bridge.setAssistant === "function")
        bridge.setAssistant(payload == null ? "" : typeof payload === "string" ? payload : JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Registers a handler invoked whenever a quick-action is triggered, whether
 * from the desktop tray menu or an Android launcher shortcut. Replaces any
 * previously registered handler.
 *
 * The handler receives `{ id, payload? }`. `payload` is the opaque string
 * set on the `Shortcut` (if any); native surfaces pass it through unchanged.
 * The assistant trigger's payload is the value published via `setAssistant`
 * (objects are parsed back from JSON before delivery).
 *
 * @param {(action: { id: string, payload?: any }) => void} callback
 * @returns {() => void} Unsubscribe function — removes the handler.
 */
export function onLaunchAction(callback) {
  if (typeof callback !== "function") throw new TypeError("callback must be a function");
  ensureListener();
  handler = callback;
  return () => {
    if (handler === callback) handler = null;
  };
}
