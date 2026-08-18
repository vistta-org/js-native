/**
 * Cross-platform background scheduler API.
 *
 * Platform behavior:
 * - **Android**: Callbacks fire via a foreground service, so they keep
 *   firing when the app is backgrounded or the device is locked.
 *   While a callback is running, `window.fetch` is transparently
 *   routed to the service so network requests complete too.
 * - **Desktop/Web**: Falls through to `setInterval` / `setTimeout` with
 *   no background persistence.
 * - **iOS**: Falls through to `setInterval` / `setTimeout` (background
 *   persistence via native API not yet implemented).
 *
 * Timer IDs are normalised to strings internally.
 */

let nextId = 0;
/** @type {Map<string, () => void>} */
const callbacks = new Map();
/** Active bridge-poll probes, keyed by scheduler id. Each entry holds
 *  the native setInterval handle used to poll for the bridge, so
 *  `clearBackgroundInterval` can cancel the poll if the caller changes
 *  their mind before the bridge appears. */
const pendingPolls = new Map();
let listener = null;
/** @type {false | Object} */
let bridge = false;

/**
 * Schedules `fn` to fire every `intervalMs` milliseconds.
 *
 * @param {() => void} fn - Callback to invoke on each tick.
 * @param {number} intervalMs - Interval in milliseconds (minimum 1ms).
 * @returns {string} Timer ID suitable for `clearBackgroundInterval`.
 */
export function setBackgroundInterval(fn, intervalMs) {
  if (typeof fn !== "function") throw new TypeError("fn must be a function");
  if (typeof intervalMs !== "number" || intervalMs < 1) {
    throw new TypeError("intervalMs must be a number >= 1");
  }

  setupListener();
  const id = (++nextId).toString(36);
  callbacks.set(id, fn);

  const b = getBridge();
  if (b) {
    b.registerTimer(id, intervalMs);
  } else if (isMobile()) {
    // Bridge not yet injected by the activity. Poll until it appears,
    // then hand the timer off to the service. Plain `setInterval` would
    // be paused by Android when the app is backgrounded.
    const probe = setInterval(() => {
      const bb = getBridge();
      if (!bb) return;
      clearInterval(probe);
      pendingPolls.delete(id);
      bb.registerTimer(id, intervalMs);
    }, 1000);
    pendingPolls.set(id, probe);
  } else {
    setInterval(fn, intervalMs);
  }
  return id;
}

/**
 * Cancels a timer registered with `setBackgroundInterval` or
 * `setBackgroundTimeout`.
 */
export function clearBackgroundInterval(id) {
  if (id == null) return;
  const idStr = String(id);
  callbacks.delete(idStr);
  const b = getBridge();
  if (b) {
    b.clearTimer(idStr);
    b.stopIfEmpty();
    return;
  }
  const probe = pendingPolls.get(idStr);
  if (probe !== undefined) {
    clearInterval(probe);
    pendingPolls.delete(idStr);
    return;
  }
  // Fallback: try to clear as a native timer id (desktop/web/iOS path).
  try {
    clearInterval(parseInt(idStr, 10));
  } catch {
    /* ignore */
  }
}

/**
 * Schedules `fn` to fire once after `delayMs` milliseconds.
 *
 * @param {() => void} fn - Callback to invoke once.
 * @param {number} delayMs - Delay in milliseconds (minimum 1ms).
 * @returns {string} Timer ID suitable for `clearBackgroundTimeout`.
 */
export function setBackgroundTimeout(fn, delayMs) {
  if (typeof fn !== "function") throw new TypeError("fn must be a function");
  if (typeof delayMs !== "number" || delayMs < 1) {
    throw new TypeError("delayMs must be a number >= 1");
  }

  const b = getBridge();
  if (b) return registerTimeout(fn, delayMs, b);
  if (isMobile()) {
    const id = (++nextId).toString(36);
    let fired = false;
    callbacks.set(id, () => {
      if (fired) return;
      fired = true;
      try {
        fn();
      } finally {
        clearBackgroundInterval(id);
      }
    });
    const probe = setInterval(() => {
      const bb = getBridge();
      if (!bb) return;
      clearInterval(probe);
      pendingPolls.delete(id);
      bb.registerTimer(id, Math.max(1, delayMs));
    }, 1000);
    pendingPolls.set(id, probe);
    return id;
  }
  return String(setTimeout(fn, delayMs));
}

/**
 * Cancels a timer registered with `setBackgroundTimeout`.
 */
export function clearBackgroundTimeout(id) {
  clearBackgroundInterval(id);
}

// --- Internals ---

function isMobile() {
  // @ts-ignore
  return typeof window !== "undefined" && window.platform === "mobile";
}

/**
 * Returns the VisttaScheduler bridge if available, else `false`. Positive
 * results are cached; `false` is re-checked on every call so we pick up
 * the bridge as soon as the activity injects it.
 */
function getBridge() {
  if (bridge) return bridge;
  if (typeof window === "undefined") return false;
  const b = /** @type {any} */ (window).VisttaScheduler;
  if (b) {
    bridge = b;
    return bridge;
  }
  return false;
}

function registerTimeout(fn, delayMs, b) {
  setupListener();
  const id = (++nextId).toString(36);
  let fired = false;
  callbacks.set(id, () => {
    if (fired) return;
    fired = true;
    try {
      fn();
    } finally {
      clearBackgroundInterval(id);
    }
  });
  b.registerTimer(id, Math.max(1, delayMs));
  return id;
}

/**
 * Installs the 'scheduler-tick' event listener once. The listener
 * increments the depth counter, runs the callback, then decrements the
 * counter on the next macrotask (so microtask continuations of code
 * called from the tick still see the fetch override active).
 */
function setupListener() {
  if (listener || typeof window === "undefined") return;
  listener = async (event) => {
    const id = event?.detail?.id;
    if (id == null) return;
    const cb = callbacks.get(id);
    if (cb) cb();
  };
  window.addEventListener("scheduler-tick", listener);
}
