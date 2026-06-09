import fs from "@vistta/fs";
import { writeIfChanged } from "../utils/index.js";

/**
 * Writes `tauri.conf.json` by deep-merging the consumer config and any `extraTauriConfig`
 * into the generated defaults. Existing tauri.conf.json on disk is overwritten — consumers
 * customise via the JS config object, not by editing the generated file.
 *
 * Array merge semantics: arrays from `extraTauriConfig` REPLACE arrays from the
 * defaults (no concatenation). To extend e.g. bundle.icon, redeclare the full list.
 */
export async function mergeConfig(targetDir, config) {
  const confPath = fs.resolve(targetDir, "tauri.conf.json");

  const generated = {
    $schema: "https://schema.tauri.app/config/2",
    productName: config?.app?.name || config?.title || "Vistta App",
    identifier: config?.app?.id || "org.vistta.app",
    version: "0.1.0",
    build: {
      beforeBuildCommand: "",
      beforeDevCommand: "",
      frontendDist: "www",
      ...(config?.devUrl ? { devUrl: config.devUrl } : {}),
    },
    app: {
      withGlobalTauri: true,
      windows: [
        {
          label: "main",
          title: config?.app?.title || config?.title || "Vistta App",
          width: config?.app?.width ?? 1280,
          height: config?.app?.height ?? 800,
          minWidth: config?.app?.minWidth ?? 320,
          minHeight: config?.app?.minHeight ?? 480,
          center: config?.app?.center ?? true,
          resizable: config?.app?.resizable ?? true,
          fullscreen: config?.app?.fullscreen ?? false,
          decorations: true,
          transparent: false,
          alwaysOnTop: false,
          ...(config?.backgroundColor ? { backgroundColor: config.backgroundColor } : {}),
        },
      ],
      security: {
        csp: config?.security?.csp ?? null,
      },
    },
    bundle: {
      active: true,
      targets: "all",
      icon: ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"],
      ...buildSigning(config),
    },
    plugins: {
      shell: { open: true },
    },
  };

  const merged = deepMerge(generated, config?.extraTauriConfig || {});

  await writeIfChanged(confPath, JSON.stringify(merged, null, 2));
}

/**
 * Maps the high-level `signing` config to Tauri bundle signing fields.
 *
 * @example
 *   signing: {
 *     android: { keystorePath: "release.keystore", keystorePassword: "...", keyAlias: "...", keyPassword: "..." },
 *     windows: { certificateThumbprint: "...", digestAlgorithm: "sha256", timestampUrl: "..." },
 *     macos:   { signingIdentity: "Developer ID Application: ...", providerShortName: "...", entitlements: "entitlements.plist" }
 *   }
 */
function buildSigning(config) {
  const s = config?.signing;
  if (!s) return {};
  const out = {};
  if (s.android) {
    out.android = {
      ...(s.android.minSdkVersion ? { minSdkVersion: s.android.minSdkVersion } : {}),
      ...(s.android.versionCode ? { versionCode: s.android.versionCode } : {}),
    };
    // Keystore credentials are surfaced via env vars (TAURI_ANDROID_*) at build time —
    // we expose the file path here so `tauri android build` finds it, but never
    // embed the passwords in tauri.conf.json.
    if (s.android.keystorePath) out.android.signingConfig = { keystorePath: s.android.keystorePath };
  }
  if (s.windows) {
    out.windows = { wix: {}, nsis: {} };
    if (s.windows.certificateThumbprint) {
      out.windows.certificateThumbprint = s.windows.certificateThumbprint;
      if (s.windows.digestAlgorithm) out.windows.digestAlgorithm = s.windows.digestAlgorithm;
      if (s.windows.timestampUrl) out.windows.timestampUrl = s.windows.timestampUrl;
    }
  }
  if (s.macos) {
    out.macOS = {};
    if (s.macos.signingIdentity) out.macOS.signingIdentity = s.macos.signingIdentity;
    if (s.macos.providerShortName) out.macOS.providerShortName = s.macos.providerShortName;
    if (s.macos.entitlements) out.macOS.entitlements = s.macos.entitlements;
  }
  return out;
}

/**
 * Recursively merges `b` into `a`. Arrays from `b` replace arrays from `a`.
 * Returns a new object; inputs are not mutated.
 */
function deepMerge(a, b) {
  if (Array.isArray(b)) return b.slice();
  if (b && typeof b === "object" && a && typeof a === "object" && !Array.isArray(a)) {
    const out = { ...a };
    for (const k of Object.keys(b)) {
      out[k] = k in a ? deepMerge(a[k], b[k]) : b[k];
    }
    return out;
  }
  return b === undefined ? a : b;
}
