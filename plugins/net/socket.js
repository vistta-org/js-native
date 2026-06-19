/**
 * Socket.IO client.
 *
 * Three backends, picked in order on each `connect()` call:
 *
 *   1. **Android foreground service** — when `window.VisttaSocket` is
 *      injected by the activity. The connection lives in the service so
 *      it survives backgrounding. Inbound events arrive as
 *      `CustomEvent('background-socket-event', { detail: { id, name, args } })`.
 *
 *   2. **socket.io-client** (peer dep, optional) — used on every other
 *      platform (desktop, web, iOS) when the app installs it. Outbound
 *      emits go to `socket.emit`; inbound events are fanned into the same
 *      `dispatchEvent` channel as the Android path via `socket.onAny` so
 *      `on()/off()` semantics are identical.
 *
 *   3. **In-page mock** — last resort when neither of the above is
 *      available (peer dep not installed, tests). The id works but
 *      nothing actually connects; callers can use `emit` to simulate
 *      inbound events.
 *
 * `connect()` is synchronous and returns an id immediately in all three
 * cases. On backend #2 the underlying TCP/WS handshake happens in the
 * background; handlers registered via `on()` are delivered once the
 * underlying socket fires its events.
 */

/** @type {Map<string, Set<{ name: string, handler: (...args: any[]) => void }>>} */
const listeners = new Map();
let connectIdCounter = 0;
let eventListenerInstalled = false;
/** @type {false | Object} */
let bridge = false;
/** @type {Map<string, { emit: (event: string, ...args: any[]) => void, disconnect: () => void }>} */
const mockSockets = new Map();
/** @type {Map<string, any>} id -> real socket.io-client Socket instance */
const realSockets = new Map();
/** @type {null | ((url: string, opts?: any) => any)} */
let ioFactory = null;
let ioFactoryTried = false;

/**
 * Opens a Socket.IO connection to `url` and returns a connection id.
 *
 * The id can be passed to `on()`, `off()`, `emit()`, and `disconnect()`
 * synchronously regardless of which backend is selected. On backend #2
 * the underlying transport may not be open yet when this returns; events
 * registered via `on()` will be delivered once the real socket connects.
 *
 * @param {string} url - The Socket.IO endpoint (e.g. `https://example.com`).
 * @param {object} [opts] - Options passed through to the native client
 *   or `socket.io-client` (`auth`, `query`, `transports`, `reconnection`,
 *   etc.).
 * @returns {string} A connection id suitable for the other functions.
 */
export function connect(url, opts) {
  const id = `s${(++connectIdCounter).toString(36)}`;
  const b = getBridge();
  if (b && typeof b.connect === "function") {
    b.connect(id, url, JSON.stringify(opts || {}));
    return id;
  }
  const io = getIo();
  if (io) {
    const socket = io(url, opts || {});
    realSockets.set(id, socket);
    installRealSocketBridge(id, socket);
    return id;
  }
  // Fallback mock for non-Android and no peer dep installed.
  mockSockets.set(id, {
    emit: (name, ...args) => dispatchEvent(id, name, args),
    disconnect: () => {},
  });
  return id;
}

/**
 * Closes a connection and releases its resources.
 *
 * @param {string} id - Connection id from `connect()`.
 */
export function disconnect(id) {
  if (id == null) return;
  const b = getBridge();
  if (b && typeof b.disconnect === "function") {
    b.disconnect(id);
    listeners.delete(id);
    return;
  }
  const real = realSockets.get(id);
  if (real) {
    try {
      real.disconnect();
    } catch {
      /* ignore */
    }
    realSockets.delete(id);
    listeners.delete(id);
    return;
  }
  const mock = mockSockets.get(id);
  if (mock) {
    try {
      mock.disconnect();
    } catch {
      /* ignore */
    }
    mockSockets.delete(id);
    listeners.delete(id);
    return;
  }
  listeners.delete(id);
}

/**
 * Emits an event on the connection.
 *
 * @param {string} id - Connection id.
 * @param {string} name - Event name.
 * @param  {...any} args - Arguments to send.
 * @returns {Promise<void>} Resolves once the backend has accepted the
 *   emit; rejects if the connection is not available.
 */
export function emit(id, name, ...args) {
  const b = getBridge();
  if (b && typeof b.emit === "function") {
    try {
      b.emit(id, name, JSON.stringify(args));
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  }
  const real = realSockets.get(id);
  if (real) {
    return new Promise((resolve, reject) => {
      try {
        real.emit(name, ...args, (err) => (err ? reject(err) : resolve()));
      } catch (e) {
        reject(e);
      }
    });
  }
  const mock = mockSockets.get(id);
  if (!mock) return Promise.reject(new Error(`No socket: ${id}`));
  mock.emit(name, ...args);
  return Promise.resolve();
}

/**
 * Subscribes to an event from the connection.
 *
 * @param {string} id - Connection id.
 * @param {string} name - Event name.
 * @param {(...args: any[]) => void} handler - Callback invoked with the
 *   deserialised arguments.
 * @returns {() => void} Unsubscribe function.
 */
export function on(id, name, handler) {
  if (id == null || name == null || typeof handler !== "function") return () => {};
  installEventListener();
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  const entry = { name, handler };
  set.add(entry);
  return () => set.delete(entry);
}

/**
 * Removes a previously-registered event handler.
 *
 * @param {string} id - Connection id.
 * @param {string} name - Event name.
 * @param {(...args: any[]) => void} handler - The same handler passed to `on`.
 */
export function off(id, name, handler) {
  const set = listeners.get(id);
  if (!set) return;
  for (const entry of set) {
    if (entry.name === name && entry.handler === handler) {
      set.delete(entry);
      return;
    }
  }
}

// --- Internals ---

function getBridge() {
  if (bridge) return bridge;
  if (typeof window === "undefined") return false;
  const b = /** @type {any} */ (window).VisttaSocket;
  if (b) {
    bridge = b;
    return bridge;
  }
  return false;
}

/**
 * Resolves the `socket.io-client` factory, or `null` if the peer dep is
 * not installed. Result is cached; failure is cached as `null` so we
 * don't keep retrying on every `connect()` call.
 */
async function resolveIo() {
  if (ioFactoryTried) return ioFactory;
  ioFactoryTried = true;
  try {
    const mod = await import("socket.io-client");
    ioFactory = /** @type {any} */ (mod).io || /** @type {any} */ (mod).default || null;
  } catch {
    ioFactory = null;
  }
  return ioFactory;
}

/**
 * Synchronous accessor: returns the cached factory if already resolved,
 * otherwise kicks off the import (non-blocking) and returns `null` for
 * this call. The next `connect()` after the import resolves will pick
 * up the real factory; until then those calls fall back to the mock.
 */
function getIo() {
  if (ioFactory) return ioFactory;
  if (!ioFactoryTried) {
    resolveIo();
  }
  return null;
}

/**
 * Wires a real `socket.io-client` Socket into the shared `dispatchEvent`
 * channel so the same `on()/off()` registrations receive its events.
 *
 * `socket.onAny` (Socket.IO >= 4) fans every event to a single handler,
 * which we forward by `(name, ...args)` — the same shape the Android
 * bridge uses. We register once on `connect` so re-connects don't stack
 * duplicate listeners.
 */
function installRealSocketBridge(id, socket) {
  let wired = false;
  const wire = () => {
    if (wired) return;
    wired = true;
    if (typeof socket.onAny === "function") {
      socket.onAny((name, ...args) => dispatchEvent(id, name, args));
    } else {
      // Older socket.io-client: wire a catch-all via `*`. Fallback only.
      socket.on("*", (payload) => {
        const [name, ...args] = Array.isArray(payload) ? payload : [payload];
        dispatchEvent(id, String(name), args);
      });
    }
  };
  if (socket.connected) {
    wire();
  } else {
    socket.once("connect", wire);
  }
}

function installEventListener() {
  if (eventListenerInstalled || typeof window === "undefined") return;
  eventListenerInstalled = true;
  window.addEventListener("background-socket-event", (event) => {
    const d = /** @type {CustomEvent} */ (event)?.detail;
    if (!d || !d.id) return;
    dispatchEvent(d.id, d.name, Array.isArray(d.args) ? d.args : []);
  });
}

function dispatchEvent(id, name, args) {
  const set = listeners.get(id);
  if (!set) return;
  for (const entry of set) {
    if (entry.name !== name) continue;
    try {
      entry.handler(...args);
    } catch {
      /* swallow — one bad handler shouldn't break the others */
    }
  }
}
