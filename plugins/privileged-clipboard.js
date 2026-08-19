/**
 * Android privileged clipboard bridge.
 *
 * The dedicated native plugin detects Shizuku/Sui and owns the privileged
 * monitor. Root support is intentionally exposed as backend-neutral API
 * surface; a root backend is unavailable until a compatible `cmd clipboard`
 * implementation can be verified on the target Android release.
 */

export function getClipboardBridge() {
  if (typeof window === "undefined") return false;
  return /** @type {any} */ (window).VisttaPrivilegedClipboard || false;
}

export function isShizukuAvailable() {
  try {
    return getClipboardBridge()?.isShizukuAvailable() === true;
  } catch {
    return false;
  }
}

export function isShizukuAuthorized() {
  try {
    return getClipboardBridge()?.isShizukuAuthorized() === true;
  } catch {
    return false;
  }
}

export function requestShizukuPermission() {
  try {
    return getClipboardBridge()?.requestShizukuPermission() === true;
  } catch {
    return false;
  }
}

export function startMonitor(intervalMs = 2000) {
  try {
    return getClipboardBridge()?.startMonitor(intervalMs) === true;
  } catch {
    return false;
  }
}

export function stopMonitor() {
  try {
    getClipboardBridge()?.stopMonitor();
  } catch {
    // The plugin may have been removed while a watcher was active.
  }
}

export function writeText(text) {
  try {
    return getClipboardBridge()?.writeText(text) === true;
  } catch {
    return false;
  }
}
