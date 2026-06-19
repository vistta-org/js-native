/**
 * Background fetch API.
 *
 * Routes `fetch()` calls through the Android foreground service so they
 * complete while the activity is paused. On desktop/web/iOS (or when the
 * `VisttaFetch` bridge is absent), `fetch()` falls through to the regular
 * `window.fetch` so callers don't need to branch on environment.
 *
 * Unlike `window.fetch`, this API accepts only string URLs and plain
 * objects for headers/body. Request bodies that are not already strings
 * must be serialised before being passed in.
 */

/** @type {Map<string, { resolve: (r: Response) => void, reject: (e: Error) => void }>} */
const pending = new Map();
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
 * @param {string} url - The URL to fetch.
 * @param {RequestInit} [init] - Standard fetch options.
 * @returns {Promise<Response>} A standard Response.
 */
export function fetch(url, init) {
  const b = getBridge();
  if (!b || typeof b.fetchUrl !== "function") return globalThis.fetch(url, init);
  return routeFetch(url, init || {});
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

function routeFetch(url, init) {
  const b = getBridge();
  if (!b || typeof b.fetchUrl !== "function") {
    return globalThis.fetch(url, init);
  }

  const method = String(init.method || "GET").toUpperCase();
  const headersObj = /** @type {Record<string, string>} */ ({});
  if (init.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => {
        headersObj[key] = String(value);
      });
    } else if (Array.isArray(init.headers)) {
      for (const pair of init.headers) {
        const [k, v] = /** @type {[string, string]} */ (pair);
        headersObj[k] = String(v);
      }
    } else if (typeof init.headers === "object") {
      for (const k of Object.keys(init.headers)) {
        headersObj[k] = String(/** @type {Record<string, string>} */ (init.headers)[k]);
      }
    }
  }

  const body = init.body != null ? String(init.body) : null;
  const id = `bf${(++fetchIdCounter).toString(36)}`;

  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });

  if (init.signal) {
    if (init.signal.aborted) {
      pending.delete(id);
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }
    init.signal.addEventListener(
      "abort",
      () => {
        try {
          b.abortFetch(id);
        } catch {
          /* ignore */
        }
        const entry = pending.get(id);
        if (entry) {
          pending.delete(id);
          entry.reject(new DOMException("Aborted", "AbortError"));
        }
      },
      { once: true },
    );
  }

  installResultListener();
  try {
    b.fetchUrl(id, url, method, JSON.stringify(headersObj), body);
  } catch (e) {
    pending.delete(id);
    return Promise.reject(e);
  }
  return promise;
}

function installResultListener() {
  if (resultListenerInstalled || typeof window === "undefined") return;
  resultListenerInstalled = true;
  window.addEventListener("background-fetch-result", (event) => {
    const d = /** @type {CustomEvent} */ (event)?.detail;
    if (!d || !d.id) return;
    const entry = pending.get(d.id);
    if (!entry) return;
    pending.delete(d.id);
    if (!d.ok) {
      entry.reject(new Error(d.error || "Background fetch failed"));
      return;
    }
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
    const bytes = d.bodyBase64 ? base64ToBytes(d.bodyBase64) : new Uint8Array();
    const response = new Response(new Blob([bytes]), {
      status: d.status || 200,
      statusText: STATUS_TEXT[d.status] || "",
      headers,
    });
    entry.resolve(response);
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

/** @param {string} b64 */
function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
