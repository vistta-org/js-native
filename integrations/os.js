/**
 * @tauri-apps/plugin-os
 * Web: navigator.platform / navigator.language
 */
export async function getLocale() {
  if (window.platform !== "server" && window.platform !== "browser") {
    try {
      const { locale } = await import("@tauri-apps/plugin-os");
      return locale;
    } catch {
      /* Do Nothing */
    }
  }
  return navigator.language || "en";
}

export async function platform() {
  if (window.platform !== "server" && window.platform !== "browser") {
    try {
      const { platform } = await import("@tauri-apps/plugin-os");
      return platform();
    } catch {
      /* Do Nothing */
    }
  }
  return window.platform || "browser";
}

export async function version() {
  if (window.platform !== "server" && window.platform !== "browser") {
    try {
      const { version } = await import("@tauri-apps/plugin-os");
      return version();
    } catch {
      /* Do Nothing */
    }
  }
  return "unknown";
}

export async function type() {
  if (window.platform !== "server" && window.platform !== "browser") {
    try {
      const { type } = await import("@tauri-apps/plugin-os");
      return type();
    } catch {
      /* Do Nothing */
    }
  }
  const ua = navigator.userAgent;
  if (ua.includes("Win")) return "windows";
  if (ua.includes("Mac")) return "macos";
  if (ua.includes("Linux")) return "linux";
  if (ua.includes("Android")) return "android";
  if (ua.includes("iPhone")) return "ios";
  return "browser";
}

export async function arch() {
  if (window.platform !== "server" && window.platform !== "browser") {
    try {
      const { arch } = await import("@tauri-apps/plugin-os");
      return arch();
    } catch {
      /* Do Nothing */
    }
  }
  return "browser";
}
