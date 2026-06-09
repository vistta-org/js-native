export const PLUGINS = [
  { id: "clipboard-manager", crate: "tauri-plugin-clipboard-manager", version: "2" },
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
    permissions: [
      "fs:allow-read-file",
      "fs:allow-write-file",
      "fs:allow-read-dir",
      "fs:allow-mkdir",
      "fs:allow-remove",
      "fs:allow-exists",
      "fs:allow-rename",
      "fs:allow-copy-file",
      {
        identifier: "fs:scope",
        allow: [
          { path: "$APPDATA/**" },
          { path: "$APPCONFIG/**" },
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
    permissions: [
      {
        identifier: "shell:allow-execute",
        allow: [
          { name: "cmd", cmd: "cmd", args: true },
          { name: "powershell", cmd: "powershell", args: true },
          { name: "npx", cmd: "npx", args: true },
          { name: "npm", cmd: "npm", args: true },
          { name: "node", cmd: "node", args: true },
        ],
      },
      {
        identifier: "shell:allow-spawn",
        allow: [
          { name: "npm", cmd: "npm", args: true },
          { name: "npx", cmd: "npx", args: true },
          { name: "node", cmd: "node", args: true },
        ],
      },
    ],
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
