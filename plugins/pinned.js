/**
 * Pinned HTTPS: talk to self-hosted servers whose certificate is signed by
 * their own CA, trusting that CA only (Android).
 *
 * Android does not trust such CAs, so the app pins one per server:
 *
 * 1. `fetchCertificate(origin)` downloads `<origin>/ca.crt` without trust
 *    and returns its PEM and SHA-256 fingerprint. Compare the fingerprint
 *    with one obtained out of band (a QR code, or the user reading it off
 *    the server) before storing the PEM.
 * 2. `request(url, { ca, ... })` sends HTTPS requests that only accept
 *    certificates signed by that CA. Host names are not checked: the CA is
 *    unique to the server and LAN addresses change.
 * 3. `openWeb(url, { ca, title })` opens a full-screen WebView that accepts
 *    the same CA. The page gets no app bridges.
 *
 * Desktop and web have no bridge: `isSupported()` is false and the calls throw.
 */

/** @type {Map<string, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
const pending = new Map();
let counter = 0;
let listening = false;

function bridge() {
  if (typeof window === "undefined") return null;
  return /** @type {any} */ (window).VisttaPinned ?? null;
}

/** Whether pinned HTTPS is available (Android app). */
export function isSupported() {
  return !!bridge();
}

function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener("vistta-pinned", (event) => {
    const detail = /** @type {CustomEvent} */ (event).detail;
    const entry = pending.get(detail?.id);
    if (!entry) return;
    pending.delete(detail.id);
    if (detail.error) entry.reject(new Error(detail.error));
    else entry.resolve(detail);
  });
}

/** @param {(id: string, native: any) => void} start */
function call(start) {
  const native = bridge();
  if (!native) return Promise.reject(new Error("Pinned HTTPS is only available in the Android app"));
  listen();
  const id = `vp${(++counter).toString(36)}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      start(id, native);
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** SHA-256 fingerprints compare without separators or case. @param {string} [value] */
export function normalizeFingerprint(value) {
  return String(value ?? "")
    .replace(/[^0-9a-f]/gi, "")
    .toUpperCase();
}

/**
 * Downloads `<origin>/ca.crt` (untrusted) and returns it with its SHA-256 fingerprint.
 * @param {string} origin e.g. `https://192.168.1.20:8182`
 * @returns {Promise<{ pem: string, fingerprint: string }>}
 */
export async function fetchCertificate(origin) {
  const result = await call((id, native) => native.fetchCertificate(id, new URL("/ca.crt", origin).toString()));
  return { pem: result.pem, fingerprint: result.fingerprint };
}

/**
 * @typedef {{ ok: boolean, status: number, headers: Record<string, string>, text: string, json: () => any }} PinnedResponse
 */

/**
 * HTTPS request that trusts only `ca`. Bodies are strings (serialise JSON first).
 * @param {string} url
 * @param {{ ca: string, method?: string, headers?: Record<string, string>, body?: string }} options
 * @returns {Promise<PinnedResponse>}
 */
export async function request(url, { ca, method = "GET", headers = {}, body } = /** @type {any} */ ({})) {
  if (!ca) throw new Error("request() needs the pinned CA certificate");
  const result = await call((id, native) => native.request(id, url, method, JSON.stringify(headers), body ?? null, ca));
  const text = result.body ?? "";
  return {
    ok: !!result.ok,
    status: result.status,
    headers: result.headers ?? {},
    text,
    json: () => (text ? JSON.parse(text) : null),
  };
}

/**
 * Opens `url` in a full-screen WebView that trusts only `ca`.
 * @param {string} url
 * @param {{ ca: string, title?: string }} options
 */
export function openWeb(url, { ca, title = "" } = /** @type {any} */ ({})) {
  const native = bridge();
  if (!native) throw new Error("Pinned HTTPS is only available in the Android app");
  native.openWeb(url, ca, title);
}
