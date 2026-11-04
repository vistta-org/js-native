/**
 * Background fetch API.
 *
 * Routes `fetch()` calls through the Android foreground service so they
 * complete while the activity is paused. On desktop/web/iOS (or when the
 * `VisttaFetch` bridge is absent), `fetch()` falls through to the regular
 * `window.fetch` so callers don't need to branch on environment.
 *
 * Requests are normalised through `Request`, so any body `fetch` accepts
 * (string, `Blob`, `FormData`, buffers) is sent, and the response body
 * is streamed. URLs served by the WebView itself (same origin, `data:`,
 * `blob:`) always use `window.fetch`.
 */

/** @type {Map<string, { resolve: (r: Response) => void, reject: (e: Error) => void, controller?: ReadableStreamDefaultController<Uint8Array> }>} */
const pending = new Map();
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);
let fetchIdCounter = 0;
let resultListenerInstalled = false;
/** @type {false | Object} */
let bridge = false;

export * as Socket from "./socket.js";

/**
 * Sends an HTTP request and returns a Promise that resolves to a Response.
 *
 * On Android, the request is performed by the foreground service on a
 * background thread using OkHttp, so it completes even when the activity
 * is paused. On other platforms (or when the bridge is unavailable), this
 * delegates to `window.fetch`.
 *
 * @param {RequestInfo | URL} url - The URL or Request to fetch.
 * @param {RequestInit} [init] - Standard fetch options.
 * @returns {Promise<Response>} A standard Response.
 */
export function fetch(url, init) {
  const b = getBridge();
  if (!b || typeof b.fetchUrl !== "function") return globalThis.fetch(url, init);
  const target = new URL(url instanceof Request ? url.url : String(url), location.href);
  if (target.origin === location.origin || (target.protocol !== "http:" && target.protocol !== "https:"))
    return globalThis.fetch(url, init);
  return routeFetch(new Request(url, init));
}

function getBridge() {
  if (bridge) return bridge;
  if (typeof window === "undefined") return false;
  const b = /** @type {any} */ (window).VisttaFetch;
  if (b) {
    bridge = b;
    return bridge;
  }
  return false;
}

/** @param {Request} req */
async function routeFetch(req) {
  const b = getBridge();
  const headers = /** @type {Record<string, string>} */ ({});
  req.headers.forEach((value, key) => (headers[key] = value));
  const body = req.method === "GET" || req.method === "HEAD" ? null : bytesToBase64(new Uint8Array(await req.arrayBuffer()));
  if (req.signal.aborted) throw new DOMException("Aborted", "AbortError");
  const id = `bf${(++fetchIdCounter).toString(36)}`;
  installResultListener();
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, controller: undefined };
    pending.set(id, entry);
    req.signal.addEventListener(
      "abort",
      () => {
        try {
          b.abortFetch(id);
        } catch {
          /* ignore */
        }
        if (!pending.delete(id)) return;
        const error = new DOMException("Aborted", "AbortError");
        if (entry.controller) entry.controller.error(error);
        else reject(error);
      },
      { once: true },
    );
    try {
      b.fetchUrl(id, req.url, req.method, JSON.stringify(headers), body);
    } catch (e) {
      pending.delete(id);
      reject(e);
    }
  });
}

function installResultListener() {
  if (resultListenerInstalled || typeof window === "undefined") return;
  resultListenerInstalled = true;
  const detail = (event) => /** @type {CustomEvent} */ (event)?.detail || {};
  // Failure before any response arrived; rejects like `window.fetch` on a network error.
  window.addEventListener("background-fetch-result", (event) => {
    const d = detail(event);
    const entry = pending.get(d.id);
    if (!entry) return;
    pending.delete(d.id);
    entry.reject(new TypeError(d.error || "Background fetch failed"));
  });
  window.addEventListener("background-fetch-head", (event) => {
    const d = detail(event);
    const entry = pending.get(d.id);
    if (!entry) return;
    const headers = new Headers();
    if (typeof d.headers === "string" && d.headers.length) {
      for (const line of d.headers.split("\n")) {
        const idx = line.indexOf("\t");
        if (idx < 0) continue;
        const name = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (name) headers.append(name, value);
      }
    }
    const nullBody = NULL_BODY_STATUS.has(d.status);
    if (nullBody) pending.delete(d.id);
    try {
      const body = nullBody
        ? null
        : new ReadableStream({
            start: (controller) => (entry.controller = controller),
            cancel: () => {
              pending.delete(d.id);
              getBridge()?.abortFetch?.(d.id);
            },
          });
      entry.resolve(new Response(body, { status: d.status, statusText: STATUS_TEXT[d.status] || "", headers }));
    } catch (error) {
      pending.delete(d.id);
      entry.reject(error);
    }
  });
  window.addEventListener("background-fetch-chunk", (event) => {
    const d = detail(event);
    pending.get(d.id)?.controller?.enqueue(base64ToBytes(d.data));
  });
  window.addEventListener("background-fetch-end", (event) => {
    const d = detail(event);
    const entry = pending.get(d.id);
    if (!entry) return;
    pending.delete(d.id);
    if (d.error) entry.controller?.error(new TypeError(d.error));
    else entry.controller?.close();
  });
}

const STATUS_TEXT = {
  100: "Continue",
  101: "Switching Protocols",
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  206: "Partial Content",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  410: "Gone",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/** @param {Uint8Array} bytes */
function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** @param {string} b64 */
function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
