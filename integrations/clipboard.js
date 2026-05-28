/**
 * @tauri-apps/plugin-clipboard-manager
 * Web: navigator.clipboard
 */
export async function read() {
  if (window.platform === "server") return;
  if (window.platform !== "browser") {
    try {
      const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
      return await readText();
    } catch {
      /* Do nothing, fallback to web API */
    }
  }
  return await navigator.clipboard.readText();
}

export async function write(text) {
  if (window.platform === "server") return;
  if (window.platform !== "browser") {
    try {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      return await writeText(text);
    } catch {
      /* Do nothing, fallback to web API */
    }
  }
  return await navigator.clipboard.writeText(text);
}
