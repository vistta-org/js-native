// Unified app lifecycle integration for Capacitor (app), Electron (desktop), and web.

/**
 * Listen for app state changes (foreground/background).
 * @param {(state: { isActive: boolean }) => void} callback
 * @returns {Promise<() => void>} Cleanup function to remove the listener.
 */
export async function onStateChange(callback) {
  if (window.platform === "mobile") {
    // @ts-ignore
    const { App } = await import("@capacitor/app");
    const handle = await App.addListener("appStateChange", callback);
    return () => handle.remove();
  }

  if (window.platform === "desktop") {
    const handler = () => callback({ isActive: document.visibilityState === "visible" });
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }

  const handler = () => callback({ isActive: document.visibilityState === "visible" });
  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}

/**
 * Listen for back button presses (Android).
 * @param {(event: { canGoBack: boolean }) => void} callback
 * @returns {Promise<() => void>} Cleanup function to remove the listener.
 */
export async function onBackButton(callback) {
  if (window.platform === "mobile") {
    // @ts-ignore
    const { App } = await import("@capacitor/app");
    const handle = await App.addListener("backButton", callback);
    return () => handle.remove();
  }

  // No-op on desktop and web
  return () => {};
}

/**
 * Get app info (version, build number, etc).
 * @returns {Promise<{ name: string, id: string, build: string, version: string }>}
 */
export async function getInfo() {
  if (window.platform === "mobile") {
    // @ts-ignore
    const { App } = await import("@capacitor/app");
    return App.getInfo();
  }

  if (window.platform === "desktop") {
    // Electron: could read from package.json via IPC; fallback to web for now
    return {
      name: document.title || "Desktop App",
      id: location.hostname || "desktop",
      build: "0",
      version: "0.0.0",
    };
  }

  return {
    name: document.title || "Web App",
    id: location.hostname || "web",
    build: "0",
    version: "0.0.0",
  };
}

/**
 * Exit the app (Android only on Capacitor; no-op elsewhere).
 */
export async function exit() {
  if (window.platform === "mobile") {
    // @ts-ignore
    const { App } = await import("@capacitor/app");
    return App.exitApp();
  }
  // No-op on desktop and web
}
