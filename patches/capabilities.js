import fs from "@vistta/fs";
import { PLUGINS, pluginsFor } from "../plugins.config.js";
import { writeIfChanged } from "../utils/index.js";

// Core permissions always emitted (window control + Tauri runtime defaults).
// `core:path:allow-download-dir` is included so the runtime's `Path.downloadDir()`
// re-export works out of the box — the fs scope already grants `$DOWNLOAD/**`.
const CORE_PERMISSIONS = [
  "core:default",
  "core:window:default",
  "core:window:allow-set-title",
  "core:window:allow-minimize",
  "core:window:allow-maximize",
  "core:window:allow-close",
  "core:window:allow-set-fullscreen",
  "core:window:allow-set-always-on-top",
  "core:path:allow-download-dir",
];

/**
 * Regenerates capabilities/default.json from the enabled plugin set.
 *
 * Static (template-seeded) permission files cause a Tauri build error when a
 * plugin is excluded for the current target (e.g. haptics on desktop). Generating
 * the file from plugins.config.js keeps the permissions in lockstep with the
 * Cargo dependencies added by patchCargoToml.
 *
 * `extraCapabilities` (consumer-supplied) is merged on top, de-duplicated by
 * JSON identity.
 */
export async function patchCapabilities(targetDir, config) {
  const capPath = fs.resolve(targetDir, "capabilities", "default.json");
  if (!fs.existsSync(capPath)) return;

  const target = config?.platform;
  const enabledPlugins = target ? pluginsFor(target) : PLUGINS;

  const seen = new Set();
  const permissions = [];
  const push = (p) => {
    const k = JSON.stringify(p);
    if (!seen.has(k)) {
      seen.add(k);
      permissions.push(p);
    }
  };
  CORE_PERMISSIONS.forEach(push);
  for (const p of enabledPlugins) {
    // Plugins with `noCommands: true` (e.g. the runtime's own
    // tauri-plugin-vistta) expose no Tauri commands and no permissions —
    // they only inject JavascriptInterface bridges into the webview. Skip
    // them so the capabilities file stays clean.
    if (p.noCommands) continue;
    push(`${p.id}:default`);
    if (Array.isArray(p.permissions)) p.permissions.forEach(push);
  }
  if (Array.isArray(config?.extraCapabilities)) config.extraCapabilities.forEach(push);

  const cap = {
    $schema: "https://schema.tauri.app/config/2",
    identifier: "default",
    description: "Default permissions for Vistta.js Runtime",
    windows: ["main"],
    permissions,
  };
  await writeIfChanged(capPath, JSON.stringify(cap, null, 2));
}
