// Unified haptics integration for Capacitor (app), Electron (desktop), and web.

/**
 * Trigger a haptic impact feedback.
 * @param {{ style?: "light" | "medium" | "heavy" }} [options]
 */
export async function impact(options) {
  if (window.platform === "mobile") {
    // @ts-ignore
    const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
    const style = ImpactStyle[options?.style?.charAt(0).toUpperCase() + options?.style?.slice(1)] || ImpactStyle.Medium;
    return Haptics.impact({ style });
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
export async function notification(options) {
  if (window.platform === "mobile") {
    // @ts-ignore
    const { Haptics, NotificationType } = await import("@capacitor/haptics");
    const type =
      NotificationType[options?.type?.charAt(0).toUpperCase() + options?.type?.slice(1)] || NotificationType.Success;
    return Haptics.notification({ type });
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
  if (window.platform === "mobile") {
    // @ts-ignore
    const { Haptics } = await import("@capacitor/haptics");
    return Haptics.vibrate();
  }

  if (navigator.vibrate) {
    navigator.vibrate(50);
  }
}
