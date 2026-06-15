/**
 * Cross-platform background scheduler API.
 *
 * Platform behavior:
 * - **Android**: Callbacks fire via foreground service, even when app is backgrounded or device is locked.
 * - **Desktop/Web**: Falls through to setInterval/setTimeout with no background persistence.
 * - **iOS**: Falls through to setInterval/setTimeout (background persistence via native API not yet implemented).
 *
 * All platforms expose the same API so callers don't need to branch on environment.
 * Timer IDs are normalized to strings internally for consistent bridge communication.
 */

let nextId = 0;
/** @type {Map<string, () => void>} */
const callbacks = new Map();
let listenerInstalled = false;
/** @type {null | false | Object} */
let bridge = null;

/**
 * Schedules `fn` to fire every `intervalMs` milliseconds.
 *
 * **Android**: Timer persists in background via foreground service. Service auto-starts
 * on first call and stops when no timers remain.
 *
 * **Desktop/Web/iOS**: Falls through to `setInterval` with standard browser semantics
 * (no background persistence).
 *
 * @param {() => void} fn - Callback to invoke on each tick.
 * @param {number} intervalMs - Interval in milliseconds (minimum 1ms).
 * @returns {string} Timer ID suitable for `clearBackgroundInterval`.
 * @throws {TypeError} If fn is not a function or intervalMs is not a valid number.
 */
export function setBackgroundInterval(fn, intervalMs) {
  if (typeof fn !== "function") throw new TypeError("fn must be a function");
  if (typeof intervalMs !== "number" || intervalMs < 1) {
    throw new TypeError("intervalMs must be a number >= 1");
  }

  installListener();
  const id = (++nextId).toString(36);
  callbacks.set(id, fn);
  const b = getBridge();
  // If no bridge is available use setInterval on desktop/web/iOS as fallback
  if (b) b.registerTimer(id, intervalMs);
  else setInterval(fn, intervalMs);
  return id;
}

/**
 * Cancels a timer registered with `setBackgroundInterval` or `setBackgroundTimeout`.
 *
 * On Android, also checks if service should be stopped (no remaining timers).
 *
 * @param {string | number} id - Timer ID from setBackgroundInterval/setBackgroundTimeout.
 */
export function clearBackgroundInterval(id) {
  if (id == null) return;
  const idStr = String(id);
  callbacks.delete(idStr);
  const b = getBridge();
  if (b) {
    b.clearTimer(idStr);
    b.stopIfEmpty();
  } else {
    // Attempt to clear as native timer ID (for fallback on desktop/web/iOS)
    try {
      clearInterval(parseInt(idStr, 10));
    } catch {
      // Ignore if id is not a valid native timer
    }
  }
}

/**
 * Schedules `fn` to fire once after `delayMs` milliseconds.
 *
 * **Android**: One-shot timer with background persistence via foreground service.
 *
 * **Desktop/Web/iOS**: Falls through to `setTimeout` for best timing accuracy.
 *
 * Implemented internally as a one-shot timer using the interval machinery:
 * a single registration that fires once and auto-cancels.
 *
 * @param {() => void} fn - Callback to invoke once.
 * @param {number} delayMs - Delay in milliseconds (minimum 1ms).
 * @returns {string} Timer ID suitable for `clearBackgroundTimeout`.
 * @throws {TypeError} If fn is not a function or delayMs is not a valid number.
 */
export function setBackgroundTimeout(fn, delayMs) {
  if (typeof fn !== "function") throw new TypeError("fn must be a function");
  if (typeof delayMs !== "number" || delayMs < 1) {
    throw new TypeError("delayMs must be a number >= 1");
  }

  const b = getBridge();
  // Desktop/Web/iOS: use native setTimeout for best accuracy
  if (!b) return String(setTimeout(fn, delayMs));

  // Android: implement timeout as a self-canceling interval
  installListener();
  const id = (++nextId).toString(36);
  let fired = false;
  const wrapped = () => {
    if (fired) return;
    fired = true;
    try {
      fn();
    } finally {
      clearBackgroundInterval(id);
    }
  };
  callbacks.set(id, wrapped);
  b.registerTimer(id, Math.max(1, delayMs));
  return id;
}

/**
 * Cancels a timer registered with `setBackgroundTimeout`.
 *
 * @param {string | number} id - Timer ID from setBackgroundTimeout.
 */
export function clearBackgroundTimeout(id) {
  clearBackgroundInterval(id);
}

/**
 * Gets the Android VisttaScheduler bridge if available (null = not yet checked, false = unavailable).
 * @returns {null | false | Object} The bridge object or false if unavailable.
 */
function getBridge() {
  if (bridge !== null) return bridge;
  bridge = (typeof window !== "undefined" && /** @type {any} */ (window).VisttaScheduler) || false;
  return bridge;
}

/**
 * Installs the 'scheduler-tick' event listener on window if not already installed.
 * Listener is only needed on Android but safe to install on all platforms.
 */
function installListener() {
  if (listenerInstalled || typeof window === "undefined") return;
  /** @type {(event: CustomEvent) => void} */
  const handleTick = (event) => {
    const id = event?.detail?.id;
    if (id == null) return;
    const cb = callbacks.get(id);
    if (cb) cb();
  };
  window.addEventListener("scheduler-tick", handleTick);
  listenerInstalled = true;
}
