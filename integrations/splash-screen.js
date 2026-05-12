// Unified splash screen integration for Capacitor (app), Electron (desktop), and web.

let splashElement = null;

function ensureSplash() {
  if (!splashElement) {
    splashElement = document.createElement("div");
    splashElement.id = "unified-splash";
    splashElement.style.cssText =
      "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#fff;z-index:99999;transition:opacity 0.3s;";
    splashElement.innerHTML =
      '<div style="width:48px;height:48px;border:4px solid #eee;border-top-color:#333;border-radius:50%;animation:spin 1s linear infinite;"></div>';
    const style = document.createElement("style");
    style.textContent = "@keyframes spin { to { transform: rotate(360deg); } }";
    document.head.appendChild(style);
    document.body.appendChild(splashElement);
  }
  return splashElement;
}

/**
 * Hide the splash screen.
 * @param {{ fadeOutDuration?: number }} [options]
 */
export async function hide(options) {
  if (window.platform === "mobile") {
    // @ts-ignore
    const { SplashScreen } = await import("@capacitor/splash-screen");
    return SplashScreen.hide(options);
  }

  const el = ensureSplash();
  el.style.opacity = "0";
  setTimeout(() => {
    el.style.display = "none";
  }, options?.fadeOutDuration || 300);
}

/**
 * Show the splash screen.
 * @param {{ showDuration?: number, fadeInDuration?: number, fadeOutDuration?: number, autoHide?: boolean }} [options]
 */
export async function show(options) {
  if (window.platform === "mobile") {
    // @ts-ignore
    const { SplashScreen } = await import("@capacitor/splash-screen");
    return SplashScreen.show(options);
  }

  const el = ensureSplash();
  el.style.display = "flex";
  el.style.opacity = "1";

  if (options?.autoHide) {
    setTimeout(() => hide({ fadeOutDuration: options.fadeOutDuration }), options.showDuration || 2000);
  }
}
