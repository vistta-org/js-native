/**
 * @tauri-apps/plugin-dialog
 * Web: window.confirm / prompt / alert (fallback)
 */
export async function message(text, options = {}) {
  if (window.platform === "server") return;
  if (window.platform !== "browser") {
    try {
      const { message: dialogMessage } = await import("@tauri-apps/plugin-dialog");
      return await dialogMessage(text, options);
    } catch {
      /* Do Nothing */
    }
  }
  if (options.title) window.alert(`${options.title}: ${text}`);
  else window.alert(text);
}

export async function confirm(text, options = {}) {
  if (window.platform === "server") return;
  if (window.platform !== "browser") {
    try {
      const { confirm } = await import("@tauri-apps/plugin-dialog");
      return await confirm(text, options);
    } catch {
      /* Do Nothing */
    }
  }
  return window.confirm(text);
}

export async function prompt(text, options = {}) {
  if (window.platform === "server") return;
  if (window.platform !== "browser") {
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      return await ask(text, options);
    } catch {
      /* Do Nothing */
    }
  }
  return window.prompt(text);
}
