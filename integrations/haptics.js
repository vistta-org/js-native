// Unified haptics integration for Tauri (all platforms) and web.

/**
 * Trigger a haptic impact feedback.
 * @param {{ style?: "light" | "medium" | "heavy" }} [options]
 */
export async function impactFeedback(options) {
  if (window.platform === "server") return;
  if (window.platform !== "browser") {
    try {
      const { impactFeedback } = await import("@tauri-apps/plugin-haptics");
      const style = options?.style === "light" ? "light" : options?.style === "heavy" ? "heavy" : "medium";
      return await impactFeedback(style);
    } catch {
      /* Do Nothing */
    }
  }
  if (navigator.vibrate) {
    const duration = options?.style === "light" ? 10 : options?.style === "heavy" ? 30 : 20;
    navigator.vibrate(duration);
  }
}

/**
 * Trigger a haptic notification feedback.
 * @param {{ type?: "success" | "warning" | "error" }} [options]
 */
export async function notificationFeedback(options) {
  if (window.platform === "server") return;
  if (window.platform !== "browser") {
    try {
      const { notificationFeedback } = await import("@tauri-apps/plugin-haptics");
      const type = options?.type === "success" ? "success" : options?.type === "error" ? "error" : "warning";
      return await notificationFeedback(type);
    } catch {
      /* Do Nothing */
    }
  }
  if (navigator.vibrate) {
    const pattern = options?.type === "success" ? [50] : options?.type === "warning" ? [30, 50, 30] : [100];
    navigator.vibrate(pattern);
  }
}

/**
 * Trigger a light vibration.
 */
export async function vibrate() {
  if (window.platform === "server") return;
  if (window.platform !== "browser") {
    try {
      const { vibrate } = await import("@tauri-apps/plugin-haptics");
      return await vibrate(20);
    } catch {
      /* Do Nothing */
    }
  }
  if (navigator.vibrate) navigator.vibrate(20);
}
