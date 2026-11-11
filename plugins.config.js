// The runtime's own plugin crate. Lives at `rust/plugins/core/` inside this
// package and is wired into the generated Cargo.toml as a path dependency
// pointing at `@vistta/js-native/rust/plugins/core`. On Android it registers the
// Kotlin VisttaPlugin (foreground service + background fetch + socket
// bridge); on desktop/iOS it is a no-op. `permissions: []` and `noCommands:
// true` keep it out of the generated capabilities file — the plugin exposes
// no Tauri commands, only JavascriptInterface bridges injected into the
// webview.
export const VISTTA_PLUGIN = {
  id: "vistta",
  crate: "tauri-plugin-vistta",
  version: "2",
  path: "./rust/plugins/core",
  platforms: ["android"],
  permissions: [],
  noCommands: true,
};

export const PRIVILEGED_CLIPBOARD_PLUGIN = {
  id: "privileged-clipboard",
  crate: "tauri-plugin-vistta-privileged-clipboard",
  version: "1",
  path: "./rust/plugins/privileged-clipboard",
  platforms: ["android"],
  permissions: [],
  noCommands: true,
};

export const DIRECTORY_SYNC_PLUGIN = {
  id: "directory-sync",
  crate: "tauri-plugin-directory-sync",
  version: "1",
  path: "./rust/plugins/directory-sync",
  permissions: ["directory-sync:default"],
};

export const PLUGINS = [
  VISTTA_PLUGIN,
  PRIVILEGED_CLIPBOARD_PLUGIN,
  DIRECTORY_SYNC_PLUGIN,
  {
    id: "autostart",
    crate: "tauri-plugin-autostart",
    version: "2",
    platforms: ["desktop"],
    initFn: "tauri_plugin_autostart::Builder::new().build()",
    permissions: [],
  },
  {
    id: "audio-recorder",
    crate: "tauri-plugin-audio-recorder",
    version: "0.1",
    permissions: [
      "audio-recorder:allow-start-recording",
      "audio-recorder:allow-stop-recording",
      "audio-recorder:allow-pause-recording",
      "audio-recorder:allow-resume-recording",
      "audio-recorder:allow-get-status",
      "audio-recorder:allow-check-permission",
      "audio-recorder:allow-request-permission",
      "audio-recorder:allow-get-devices",
    ],
  },
  {
    id: "clipboard-manager",
    crate: "tauri-plugin-clipboard-manager",
    version: "2",
    permissions: [
      "clipboard-manager:allow-read-text",
      "clipboard-manager:allow-write-text",
      "clipboard-manager:allow-read-image",
      "clipboard-manager:allow-write-image",
      "clipboard-manager:allow-write-html",
      "clipboard-manager:allow-clear",
    ],
  },
  {
    id: "dialog",
    crate: "tauri-plugin-dialog",
    version: "2",
    permissions: [
      "dialog:allow-open",
      "dialog:allow-save",
      "dialog:allow-message",
      "dialog:allow-ask",
      "dialog:allow-confirm",
    ],
  },
  {
    id: "fs",
    crate: "tauri-plugin-fs",
    version: "2",
    cargoFeatures: '"watch"',
    permissions: [
      "fs:allow-read-file",
      "fs:allow-write-file",
      "fs:allow-read-dir",
      "fs:allow-open",
      "fs:allow-lstat",
      "fs:allow-stat",
      "fs:allow-mkdir",
      "fs:allow-remove",
      "fs:allow-exists",
      "fs:allow-rename",
      "fs:allow-copy-file",
      "fs:allow-watch",
      {
        identifier: "fs:scope",
        allow: [
          { path: "$APPDATA/**" },
          { path: "$APPCONFIG/**" },
          { path: "$APPCACHE/**" },
          { path: "$DOWNLOAD/**" },
          { path: "$DOCUMENT/**" },
          { path: "$PICTURE/**" },
        ],
      },
    ],
  },
  {
    id: "haptics",
    crate: "tauri-plugin-haptics",
    version: "2",
    platforms: ["android", "ios"],
    permissions: [
      "haptics:allow-impact-feedback",
      "haptics:allow-notification-feedback",
      "haptics:allow-selection-feedback",
      "haptics:allow-vibrate",
    ],
  },
  {
    id: "barcode-scanner",
    crate: "tauri-plugin-barcode-scanner",
    version: "2",
    platforms: ["android", "ios"],
    permissions: [],
  },
  {
    id: "notification",
    crate: "tauri-plugin-notification",
    version: "2",
    permissions: [
      "notification:allow-is-permission-granted",
      "notification:allow-request-permission",
      "notification:allow-notify",
      "notification:allow-create-channel",
      "notification:allow-list-channels",
    ],
  },
  {
    id: "shell",
    crate: "tauri-plugin-shell",
    version: "2",
    permissions: [],
  },
];

export function crateIdent(p) {
  return p.crate.replace(/-/g, "_");
}

export function initCall(p) {
  return p.initFn || `${crateIdent(p)}::init()`;
}

export function pluginsFor(target) {
  return PLUGINS.filter((p) => !p.platforms || p.platforms.includes(target));
}
