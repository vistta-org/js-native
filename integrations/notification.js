/**
 * @tauri-apps/plugin-notification
 * Web: Notification API (fallback)
 */
export async function request() {
  if (window.platform === "server") return;
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

export async function send(title, options = {}) {
  if (window.platform === "server") return;
  if (window.platform !== "browser") {
    try {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      sendNotification({ title, body: options.body });
    } catch {
      /* Do Nothing */
    }
  }
  new Notification(title, { body: options.body });
}
