import fs from "@vistta/fs";
import { devSuffix, getInfo, nameSuffix, resolveAppId, resolveTargets, writeIfChanged } from "../utils/index.js";

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
  const appId = resolveAppId(config);
  const appName = config?.app?.name || config?.title || "Vistta App";
  // Two suffixes, two purposes:
  //   - nameSuffix() (".dev" in dev) goes into productName so dev + release
  //     installs have distinct machine names and can coexist on the same
  //     device. Empty in release.
  //   - devSuffix() (" [DEV]" in dev) goes into user-visible strings (window
  //     title, Android launcher label) so the running app is marked.
  const name = nameSuffix();
  const dev = devSuffix();
  const { version } = await getInfo(config);

  const generated = {
    $schema: "https://schema.tauri.app/config/2",
    productName: `${appName}${name}`,
    identifier: appId,
    version,
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
          title: config?.app?.title || config?.title ? `${config?.app?.title || config?.title}${dev}` : `Vistta App${dev}`,
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
      targets: resolveBundleTargets(config),
      icon: ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"],
      // In development, Tauri appends this suffix to the Android
      // applicationId so the dev APK installs side-by-side with the
      // release APK. The namespace stays stable (no suffix) so the
      // generated Kotlin source tree doesn't drift between dev/release.
      ...(process.env.NODE_ENV === "development" ? { android: { debugApplicationIdSuffix: ".dev" } } : {}),
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
 *   keystore: { file: "./release.keystore", password: "..." },
 *   signing: {
 *     windows: { certificateThumbprint: "...", digestAlgorithm: "sha256", timestampUrl: "..." },
 *     macos:   { signingIdentity: "Developer ID Application: ...", providerShortName: "...", entitlements: "entitlements.plist" }
 *   }
 */
function buildSigning(config) {
  const s = config?.signing;
  if (!s) return {};
  const out = {};
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
 * Resolves `bundle.targets` for the generated tauri.conf.json. Only applies to
 * desktop — Android/iOS bundle formats are controlled via CLI flags in `build()`.
 * Returns a single string (Tauri accepts a string or array) or an array when
 * multiple targets are specified. Returns "all" for non-desktop platforms since
 * Tauri's bundle.targets doesn't accept mobile format names (apk/aab/ipa/app).
 * Accepts convenience aliases: "exe" → "nsis", "appimage" → "appimage".
 */
const TARGET_ALIASES = { exe: "nsis" };
function resolveBundleTargets(config) {
  if (config?.platform && config.platform !== "desktop") return "all";
  const targets = resolveTargets(config, "desktop");
  if (targets.length === 0 || targets.includes("all")) return "all";
  const mapped = targets.map((t) => TARGET_ALIASES[t] || t);
  return mapped.length === 1 ? mapped[0] : mapped;
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
