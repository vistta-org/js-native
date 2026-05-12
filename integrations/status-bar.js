// Unified status bar integration for Capacitor (app), Electron (desktop), and web.

/**
 * Set the status bar style.
 * @param {{ style?: "dark" | "light" | "default" }} [options]
 */
export async function setStyle(options) {
  if (window.platform === "mobile") {
    // @ts-ignore
    const { StatusBar, Style } = await import("@capacitor/status-bar");
    const style = options?.style === "dark" ? Style.Dark : options?.style === "light" ? Style.Light : Style.Default;
    return StatusBar.setStyle({ style });
  }

  const themeColor = options?.style === "dark" ? "#000000" : options?.style === "light" ? "#ffffff" : "#ffffff";
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = themeColor;
}

/**
 * Set the status bar background color (Android only on Capacitor).
 * @param {{ color: string }} options - Hex color string (e.g. "#ffffff").
 */
export async function setBackgroundColor(options) {
  if (window.platform === "mobile") {
    // @ts-ignore
    const { StatusBar } = await import("@capacitor/status-bar");
    return StatusBar.setBackgroundColor(options);
  }

  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = options?.color || "#ffffff";
}

/**
 * Hide the status bar.
 */
export async function hide() {
  if (window.platform === "mobile") {
    // @ts-ignore
    const { StatusBar } = await import("@capacitor/status-bar");
    return StatusBar.hide();
  }

  // No-op on desktop / web
}

/**
 * Show the status bar.
 */
export async function show() {
  if (window.platform === "mobile") {
    // @ts-ignore
    const { StatusBar } = await import("@capacitor/status-bar");
    return StatusBar.show();
  }

  // No-op on desktop / web
}
