/**
 * @tauri-apps/plugin-shell
 * Web: window.open / navigator.serviceWorker (fallback)
 */
export async function openUrl(url) {
  if (window.platform === "server") return;
  if (window.platform !== "browser") {
    const { open: shellOpen } = await import("@tauri-apps/plugin-shell");
    await shellOpen(url);
  } else window.open(url, "_blank");
}

export async function executeCommand(command, args = []) {
  if (window.platform === "server") return;
  if (window.platform !== "browser") {
    const { Command } = await import("@tauri-apps/plugin-shell");
    const cmd = Command.create(command, args);
    const output = await cmd.execute();
    return output;
  } else throw new Error(`Command execution not available: ${command}`);
}
