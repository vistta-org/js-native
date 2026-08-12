/**
 * Cross-platform theme and status bar control.
 *
 * Syncs the app's color scheme to the native window chrome (title bar,
 * status bar, icon appearance) and sets the root view / window background
 * color so the area behind the WebView matches the app's background.
 *
 * Platform matrix:
 * - Android — `VisttaTheme` JavascriptInterface bridge (injected by
 *   `VisttaPlugin`) sets the root view background and status bar icon
 *   appearance.
 * - Windows / Linux — Tauri's `window.setTheme()` controls the title bar
 *   and window controls; `window.setBackgroundColor()` sets the window
 *   background color.
 * - macOS — same as Windows/Linux via Tauri (app-wide).
 * - iOS — unsupported (no bridge).
 */

// --- Platform detection ---

function isAndroid() {
  return typeof window !== "undefined" && !!(/** @type {any} */ (window).VisttaTheme);
}

function isDesktop() {
  return typeof window !== "undefined" && !!(/** @type {any} */ (window).__TAURI_INTERNALS__);
}

// --- Color parsing ---

/**
 * Parses a CSS color string into RGBA components (0-255 each).
 * Supports `#rgb`, `#rrggbb`, `#aarrggbb`, `rgb(r,g,b)`, `rgba(r,g,b,a)`.
 * @param {string} color
 * @returns {{r: number, g: number, b: number, a: number} | null}
 */
function parseColor(color) {
  if (typeof color !== "string") return null;
  const hex = color.match(/^#([\da-fA-F]{3,8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3)
      h = h
        .split("")
        .map((c) => c + c)
        .join("");
    if (h.length === 4)
      h = h
        .split("")
        .map((c) => c + c)
        .join("");
    if (h.length === 6) h = "FF" + h;
    if (h.length === 8) {
      const a = parseInt(h.slice(0, 2), 16);
      const r = parseInt(h.slice(2, 4), 16);
      const g = parseInt(h.slice(4, 6), 16);
      const b = parseInt(h.slice(6, 8), 16);
      return { r, g, b, a };
    }
    return null;
  }
  const rgb = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (rgb) {
    return {
      r: parseInt(rgb[1], 10),
      g: parseInt(rgb[2], 10),
      b: parseInt(rgb[3], 10),
      a: rgb[4] !== undefined ? Math.round(parseFloat(rgb[4]) * 255) : 255,
    };
  }
  // Modern CSS color function: color(srgb r g b [/ a])
  const cs = color.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\)$/);
  if (cs) {
    let a = 255;
    if (cs[4] !== undefined) {
      a = cs[4].endsWith("%") ? Math.round((parseFloat(cs[4]) / 100) * 255) : Math.round(parseFloat(cs[4]) * 255);
    }
    return {
      r: Math.round(parseFloat(cs[1]) * 255),
      g: Math.round(parseFloat(cs[2]) * 255),
      b: Math.round(parseFloat(cs[3]) * 255),
      a,
    };
  }
  return null;
}

/** ARGB int from RGBA components. */
function toArgb({ r, g, b, a }) {
  return ((a & 0xff) << 24) | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

/**
 * Computes whether a color is dark enough to need light icons.
 * @param {{r: number, g: number, b: number, a: number}} rgba
 * @returns {boolean}
 */
function isDark({ r, g, b }) {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

// --- Android bridge ---

function getAndroidBridge() {
  return /** @type {any} */ (window).VisttaTheme || false;
}

// --- Desktop (Tauri window API) ---

let _getCurrentWindow = null;

async function getDesktopWindow() {
  if (!isDesktop()) return null;
  if (!_getCurrentWindow) {
    const mod = await import("@tauri-apps/api/window");
    _getCurrentWindow = mod.getCurrentWindow;
  }
  return _getCurrentWindow();
}

// --- Public API ---

/**
 * Sets the status bar / window background color and icon appearance.
 *
 * Accepts any CSS color string (`#hex`, `rgb()`, `rgba()`). On Android the
 * native bridge sets the root view background and toggles status bar icon
 * appearance automatically based on luminance. On desktop, Tauri's window
 * API sets the window background color. Pass `lightIcons` explicitly to
 * override the automatic icon appearance (Android only).
 *
 * @param {string} color - CSS color string.
 * @param {boolean} [lightIcons] - Override icon appearance. `true` = light icons
 *   (use with dark backgrounds), `false` = dark icons (use with light backgrounds).
 *   If omitted, determined automatically from the color's luminance.
 */
export async function setStatusBarColor(color, lightIcons) {
  const rgba = parseColor(color);
  if (!rgba) return;
  if (isAndroid()) {
    const bridge = getAndroidBridge();
    const argb = toArgb(rgba);
    const dark = lightIcons !== undefined ? lightIcons : isDark(rgba);
    bridge.setColor(argb, dark);
  } else if (isDesktop()) {
    const win = await getDesktopWindow();
    if (win) await win.setBackgroundColor(rgba);
  }
}

/**
 * Sets the native window theme (title bar, controls, scrollbars).
 *
 * On Android this is a no-op (the app manages its own theme). On desktop,
 * Tauri's `window.setTheme()` controls the OS window chrome. Pass `null`
 * or `"auto"` to follow the system theme.
 *
 * @param {"light"|"dark"|"auto"|null} theme
 */
export async function setTheme(theme) {
  if (!isDesktop()) return;
  const win = await getDesktopWindow();
  if (!win) return;
  const value = theme === "auto" || theme === null ? null : theme;
  await win.setTheme(value);
}
