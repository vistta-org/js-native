/**
 * @tauri-apps/plugin-notification
 * Web: Notification API (fallback)
 */

/**
 * Request permission to display notifications.
 * On native platforms this uses the Tauri notification plugin;
 * on the web it falls back to the standard `Notification.requestPermission()`.
 *
 * @returns {Promise<"granted" | "denied">} The permission state.
 */
export async function request() {
  if (window.platform === "server") return "denied";
  if (window.platform !== "browser") {
    try {
      const { requestPermission } = await import("@tauri-apps/plugin-notification");
      return await requestPermission();
    } catch {
      /* Do Nothing */
    }
  }
  return (await Notification.requestPermission()) === "granted" ? "granted" : "denied";
}

/**
 * Send a system notification.
 * Automatically requests permission first; silently returns if not granted.
 *
 * @param {Object} [options={}] - Notification content.
 * @param {string} [options.title] - Notification title.
 * @param {string} [options.body] - Notification body text.
 * @returns {Promise<void>}
 */
export async function send(options = {}) {
  if (window.platform === "server") return;

  const permission = await request();
  if (permission !== "granted") return;

  if (window.platform !== "browser") {
    try {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      await sendNotification(options);
      return;
    } catch {
      /* Do Nothing */
    }
  }

  new Notification(options.title, { body: options.body });
}
