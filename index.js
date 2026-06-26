import fs from "@vistta/fs";
import {
  mergeConfig,
  patchAndroidStrings,
  patchAppGradleSigning,
  patchBuildTask,
  patchCapabilities,
  patchCargoToml,
  patchLibRs,
  patchMainRs,
} from "./patches/index.js";
import { applyTemplate, exec, generateIcons, getInfo, platform, resolveAppId, resolveApplicationId } from "./utils/index.js";

const TEMPLATE_DIR = fs.resolve(import.meta.dirname, "./rust");
const TAURI_VERSION = "2.11.2";
const DEV = process.env.NODE_ENV === "development";

/**
 * @typedef {Object} Config
 * @property {"desktop"|"android"|"ios"} target - Target platform.
 * @property {string} buildDir - Build output directory (the src-tauri root for this app).
 * @property {Object} app - App settings.
 * @property {string} app.id - App identifier (e.g., "com.example.app").
 * @property {string} [app.name] - App display name.
 * @property {number} [app.width] - Window width.
 * @property {number} [app.height] - Window height.
 * @property {number} [app.minWidth] - Minimum window width.
 * @property {number} [app.minHeight] - Minimum window height.
 * @property {boolean} [app.center] - Center window on screen.
 * @property {boolean} [app.resizable] - Allow window resize.
 * @property {boolean} [app.fullscreen] - Start in fullscreen.
 * @property {boolean} [app.devTools] - Open DevTools on startup.
 * @property {boolean} [app.background] - Desktop only. When true, the app stays alive in the background (tray icon + hide-on-close). Has no effect on Android/iOS.
 * @property {string} [app.version] - App version (forwarded to bundle versioning; used to disambiguate desktop installers).
 * @property {string} [title] - Window title.
 * @property {string} [icon] - Icon path (relative to buildDir/www).
 * @property {string} [backgroundColor] - Window background color (hex).
 * @property {{csp?: string|null}} [security]
 * @property {Object} [extraTauriConfig] - Deep-merged into the generated tauri.conf.json.
 * @property {Record<string, string|object>} [extraCargoDependencies] - Extra Cargo deps appended to [dependencies].
 * @property {Array<string|object>} [extraCapabilities] - Extra entries merged into capabilities/default.json permissions.
 * @property {string} [devUrl] - For `run()`: dev server URL the webview loads (otherwise frontendDist is used).
 * @property {Object} [signing] - Platform code-signing settings. Windows + macOS settings are forwarded to `tauri.conf.json` bundle config; Android signing is auto-managed (keystore auto-generated in `buildDir/` for release builds, removed for debug builds).
 * @property {Object} [signing.android] - Android release signing. If omitted, a keystore is auto-generated in `buildDir/android.keystore` with a stable password. If `keystorePath` is set, that keystore is used instead with passwords from env vars.
 * @property {string} [signing.android.keystorePath] - Path to a pre-existing `.keystore`/`.jks` file. If set, overrides auto-generation and passwords are read from env vars.
 * @property {string} [signing.android.keystorePasswordEnv] - Env var name for the keystore password (default: `ANDROID_KEYSTORE_PASSWORD`). Only used when `keystorePath` is set.
 * @property {string} [signing.android.keyAlias] - Key alias in the keystore (default: `"upload"`).
 * @property {string} [signing.android.keyPasswordEnv] - Env var name for the key password (default: same as `keystorePasswordEnv`). Only used when `keystorePath` is set.
 * @property {number} [signing.android.minSdkVersion] - Forwarded to `tauri.conf.json` `bundle.android.minSdkVersion`.
 * @property {number} [signing.android.versionCode] - Forwarded to `tauri.conf.json` `bundle.android.versionCode`.
 * @property {string} [crossCompile] - Rust target triple for cross-compilation (e.g. `"x86_64-pc-windows-gnu"` to build Windows installers from Linux). When set, `--target <triple>` is passed to `tauri build` and artifact paths are resolved under `target/<triple>/release/`.
 */

/**
 * Launches an already-built app. Expects `build(config)` to have produced the
 * platform artifact (APK for android, native binary for desktop) under
 * `config.buildDir`. No Android Studio / emulator manager dependency: android
 * is deployed straight to the connected device via `adb`.
 *
 * Returns a handle (`{on, close, end}`); callers invoke `.close()` to stop
 * and `await handle.end()` to wait for app exit.
 * @param {Config} config
 */
export async function run(config) {
  switch (config.target) {
    case "ios":
      throw new Error("iOS target is not supported yet.");
    case "android": {
      try {
        let closeCallback = null;
        let closed = false;
        const appId = resolveApplicationId(config);
        const namespace = resolveAppId(config);
        await adb(
          `install -r ${fs.resolve(
            config.buildDir,
            "gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk",
          )}`,
        );
        // The component name is {applicationId}/{namespace}.MainActivity.
        // The applicationId may have a .dev suffix (via debugApplicationIdSuffix)
        // but the activity class lives under the stable namespace.
        await adb(`shell am start -n ${appId}/${namespace}.MainActivity`);
        const interval = setInterval(async () => {
          try {
            const result = await adb(`shell dumpsys activity activities ${appId}`);
            if (!result.toString().includes(appId)) throw new Error("App not running");
          } catch {
            closed = true;
            if (closeCallback) closeCallback(0, null);
            clearInterval(interval);
          }
        }, 1000);
        return {
          on(event, callback) {
            if (event === "close") closeCallback = callback;
          },
          close: async () => {
            await adb(`shell am force-stop ${appId}`);
          },
          end: () =>
            new Promise((resolve) => {
              closeCallback = resolve;
              if (closed) resolve();
            }),
        };
      } catch {
        throw new Error("ADB not found. Please install Android SDK Platform Tools and ensure 'adb' is in your PATH.");
      }
    }
    case "desktop": {
      const info = await getInfo(config);
      const app = info.name + (platform() === "win32" ? ".exe" : "");
      return exec(fs.resolve(config.buildDir, "target/debug", app), "", { shell: false });
    }
    default:
      throw new Error(`Unsupported target "${config.target}". Supported targets: desktop, android, ios.`);
  }
}

/**
 * Build the Tauri app for distribution. Awaits completion before returning so
 * callers can safely deploy/launch the produced artifact immediately after.
 * Returns `{ type, paths }` where `type` is the build variant that was
 * produced (`"release"` or `"debug"`) and `paths` is the list of absolute paths
 * to produced artifacts (APK/AAB for android, .app/.ipa for ios, native binary
 * for desktop). Parses the tauri child's stdout for `Finished ... at:`
 * markers and falls back to well-known default paths when no markers are
 * emitted.
 * @param {Config} config
 * @returns {Promise<{ type: "release" | "debug", paths: string[] }>}
 */
export async function build(config) {
  await applyConfig(config);

  const cwd = config.buildDir;
  const iconPath = resolveIconPath(config);
  const type = /** @type {"release" | "debug"} */ (DEV ? "debug" : "release");
  const debug = DEV ? "--debug" : "";

  const artifacts = [];
  // Tauri emits two kinds of "Finished ... at:" markers:
  //   1) Single-line: `Finished 1 artifact at: <path>` (android apk/aab, ios).
  //   2) Multi-line:  `Finished N bundles at:` followed by one indented
  //      path per line (desktop msi/nsis). The header has no path on it,
  //      so we track whether we just saw it and treat the next indented
  //      lines as artifact paths.
  let expectBundlePaths = false;
  const collectLine = (line) => {
    const header = line.match(/Finished\s+\d+\s+bundles\s+at:\s*$/i);
    if (header) {
      expectBundlePaths = true;
      return;
    }
    if (expectBundlePaths) {
      const m = line.match(/^\s+(.+\.(?:msi|exe|app|ipa|apk|aab))$/i);
      if (m) {
        artifacts.push(m[1].trim());
        return;
      }
      // First non-indented/non-artifact line ends the bundle list.
      expectBundlePaths = false;
    }
    const m = line.match(/Finished\s+\d+\s+\S+\s+at:\s*(.+)$/i);
    if (m) artifacts.push(m[1].trim());
  };
  const onLine = (msg) => {
    for (const line of String(msg).replace(/\r\n/g, "\n").split("\n")) {
      if (!line) continue;
      collectLine(line);
    }
  };

  switch (config.target) {
    case "android": {
      const androidGen = fs.resolve(cwd, "gen", "android");
      if (!fs.existsSync(androidGen)) await tauri("android init", { cwd, onLine });
      await patchBuildTask(cwd, config);
      await patchAndroidStrings(cwd, config);
      await patchAppGradleSigning(cwd, config);
      if (iconPath && fs.existsSync(iconPath))
        await generateIcons({ target: "android", buildDir: cwd, sourceIcon: iconPath });
      try {
        await tauri(`android build ${debug}`, { cwd, onLine });
      } catch {
        throw new Error("Build failed. Please ensure you have the Android SDK and necessary build tools installed.");
      }
      if (artifacts.length === 0) artifacts.push(...defaultAndroidArtifacts(cwd, debug));
      return { type, paths: artifacts };
    }
    case "ios": {
      if (!fs.existsSync(fs.resolve(cwd, "gen", "ios"))) await tauri("ios init", { cwd, onLine });
      if (iconPath && fs.existsSync(iconPath)) await generateIcons({ target: "ios", buildDir: cwd, sourceIcon: iconPath });
      await tauri(`ios build ${debug}`, { cwd, onLine });
      if (artifacts.length === 0) artifacts.push(...defaultIosArtifacts(cwd));
      return { type, paths: artifacts };
    }
    case "desktop": {
      if (iconPath && fs.existsSync(iconPath))
        await generateIcons({ target: "desktop", buildDir: cwd, sourceIcon: iconPath });
      const crossTarget = config?.crossCompile || "";
      const targetFlag = crossTarget ? `--target ${crossTarget}` : "";
      try {
        await tauri(`build ${debug} ${targetFlag}`, { cwd, onLine });
      } catch {
        throw new Error(desktopBuildHint());
      }
      // Prefer installers (msi/nsis) captured from tauri output; fall back to
      // well-known bundle paths, then the raw binary.
      if (artifacts.length === 0) artifacts.push(...defaultDesktopBundles(cwd, debug, config?.app?.version, crossTarget));
      artifacts.push(...(await defaultDesktopArtifacts(cwd, debug, crossTarget)));
      return { type, paths: artifacts };
    }
    default:
      throw new Error(`Unsupported target "${config.target}". Supported: desktop, android, ios.`);
  }
}

/**
 * Derives a versioned destination filename for an artifact produced by
 * `build()`. Naming convention: `<appName>-<version>[-<type>]<.ext>`. The
 * type segment (release|debug) is included for Android APKs and desktop
 * binaries; AABs and iOS `.ipa`/`.app` bundles omit it (single-variant per
 * build). The name is sanitised for filesystem safety (spaces preserved,
 * path separators and reserved characters stripped).
 *
 * @param {object} args
 * @param {string} args.appName
 * @param {string} [args.version]
 * @param {"release" | "debug"} args.type
 * @param {string} args.sourcePath - The original artifact path (used to pick the right extension).
 * @returns {string}
 */
export function artifactName({ appName, version, type, sourcePath }) {
  const ext = fs.extname(sourcePath);
  const safe = (s) =>
    String(s || "")
      .replace(/[\s\\/:*?"<>|]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .trim();
  const baseName = safe(appName) || "app";
  const ver = version ? `-${safe(version)}` : "";
  const includeType = /^(apk|exe)$/i.test(ext);
  const typeSeg = includeType ? `-${type}` : "";
  return `${baseName}${ver}${typeSeg}${ext}`;
}

export { getInfo, platform, TAURI_VERSION };

function defaultAndroidArtifacts(cwd, debug) {
  const buildType = debug ? "debug" : "release";
  const apkName = debug ? `app-universal-${buildType}.apk` : null;
  const aabName = debug ? "debug" : "release";
  const aabDir = debug ? "universalDebug" : "universalRelease";
  const out = [];
  if (apkName) {
    out.push(fs.resolve(cwd, `gen/android/app/build/outputs/apk/universal/${buildType}/${apkName}`));
  } else {
    out.push(
      fs.resolve(cwd, `gen/android/app/build/outputs/apk/universal/${buildType}/app-universal-release.apk`),
      fs.resolve(cwd, `gen/android/app/build/outputs/apk/universal/${buildType}/app-universal-release-unsigned.apk`),
    );
  }
  out.push(fs.resolve(cwd, `gen/android/app/build/outputs/bundle/${aabDir}/app-universal-${aabName}.aab`));
  return out;
}

function defaultIosArtifacts(cwd) {
  return [fs.resolve(cwd, "gen/ios/build/Build/Products/Release-iphoneos")];
}

async function defaultDesktopArtifacts(cwd, debug, crossTarget = "") {
  const info = await getInfo({});
  // Cross-compiled binaries land under target/<triple>/; native builds under target/.
  // The .exe extension is used when the target is Windows (either native win32 or
  // a cross-compile triple ending in -windows-*).
  const isWindows = crossTarget ? /-windows-/.test(crossTarget) : platform() === "win32";
  const exe = info.name + (isWindows ? ".exe" : "");
  const targetDir = crossTarget ? fs.resolve(cwd, "target", crossTarget) : fs.resolve(cwd, "target");
  const release = fs.resolve(targetDir, "release", exe);
  const dbg = fs.resolve(targetDir, "debug", exe);
  if (fs.existsSync(release)) return [release];
  if (fs.existsSync(dbg)) return [dbg];
  return [debug ? dbg : release];
}

/**
 * Fallback paths for desktop installers (msi on Windows, .deb/.rpm/.AppImage
 * on Linux, .app/.dmg on macOS) when tauri's `Finished N bundles at:` lines
 * weren't captured. Only returns paths that exist on disk.
 */
function defaultDesktopBundles(cwd, debug, version, crossTarget = "") {
  const buildType = debug ? "debug" : "release";
  const targetDir = crossTarget ? fs.resolve(cwd, "target", crossTarget) : fs.resolve(cwd, "target");
  const bundleDir = fs.resolve(targetDir, buildType, "bundle");
  const out = [];
  const candidates = [
    fs.resolve(bundleDir, "msi"),
    fs.resolve(bundleDir, "nsis"),
    fs.resolve(bundleDir, "deb"),
    fs.resolve(bundleDir, "rpm"),
    fs.resolve(bundleDir, "appimage"),
    fs.resolve(bundleDir, "app"),
    fs.resolve(bundleDir, "dmg"),
  ];
  // When version is known, only include artifacts whose filename contains it,
  // so stale artifacts from previous builds don't produce duplicates.
  const versionSeg = version ? `_${version}_` : null;
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (versionSeg && !name.includes(versionSeg)) continue;
      const ext = fs.extname(name).toLowerCase();
      if (/\.(msi|exe|deb|rpm|app|dmg)$/i.test(ext) || /appimage$/i.test(name)) {
        out.push(fs.resolve(dir, name));
      }
    }
  }
  return out;
}

/**
 * Seeds buildDir from the package's `template/` directory (a verbatim
 * `tauri init` baseline at TAURI_VERSION), then runs the generators
 * (patchMainRs, patchLibRs, patchCargoToml, mergeConfig, patchCapabilities)
 * which overwrite their files in full. Consumers customise via the
 * config object, not by editing files in buildDir.
 */
async function applyConfig(config) {
  assertTauriVersion();
  const cwd = config.buildDir;
  await applyTemplate({ buildDir: cwd, tplDir: TEMPLATE_DIR });
  await patchMainRs(cwd, config);
  await patchLibRs(cwd, config);
  await patchCargoToml(cwd, config);
  await mergeConfig(cwd, config);
  await patchCapabilities(cwd, config);
}

/**
 * Asserts that the `@tauri-apps/cli` version in this package's
 * `package.json` matches the hardcoded `TAURI_VERSION` in `index.js`.
 * The two are separate sources of truth — `TAURI_VERSION` drives the
 * template baseline and the generated `Cargo.toml`, while
 * `@tauri-apps/cli` is what `npx tauri` actually runs. A mismatch causes
 * confusing build failures (e.g. the template is for 2.11 but the CLI is
 * 2.12 and emits a different `gen/android` layout). This check turns a
 * silent mismatch into a clear error at the start of the build.
 */
function assertTauriVersion() {
  const pkgPath = fs.resolve(import.meta.dirname, "package.json");
  const pkg = JSON.parse(String(fs.readFileSync(pkgPath, "utf8")));
  const cliDep = pkg.dependencies?.["@tauri-apps/cli"];
  if (!cliDep) return;
  // Extract the version from the semver range (e.g. "^2.11.2" → "2.11.2").
  const cliVersion = cliDep.replace(/^[^0-9]+/, "");
  if (cliVersion !== TAURI_VERSION) {
    throw new Error(
      `Tauri version mismatch: TAURI_VERSION in index.js is "${TAURI_VERSION}" but @tauri-apps/cli in package.json is "${cliDep}". ` +
        `Update both to the same version. See the "Upgrading Tauri" section in the README.`,
    );
  }
}

function resolveIconPath(config) {
  if (!config?.icon || !config?.buildDir) return null;
  return fs.resolve(config.buildDir, "www", config.icon);
}

function desktopBuildHint() {
  switch (platform()) {
    case "win32":
      return "Build failed. Please ensure you have the Visual C++ Build Tools installed: https://visualstudio.microsoft.com/visual-cpp-build-tools/";
    case "darwin":
      return "Build failed. Please ensure you have Xcode Command Line Tools installed: xcode-select --install";
    case "linux":
      return "Build failed. Please ensure you have the necessary build tools installed (e.g., build-essential on Debian/Ubuntu).";
    default:
      return "Build failed. Please ensure you have the necessary build tools installed for your platform.";
  }
}

function adb(args, options) {
  return exec("adb", args, { shell: false, ...options }).end();
}

/**
 * Spawns `npx tauri <args>` and waits for completion.
 *
 * The mode handling (tee-to-TTY + dispatch when an `onLine`
 * callback is present, inherit-stdio fast path otherwise) lives in `exec()`
 * so every spawned command — adb, the desktop binary, this one — gets the
 * same treatment. This wrapper is now just a thin convenience for the
 * `npx tauri` prefix.
 *
 * Rejects on non-zero exit.
 */
function tauri(args, options = {}) {
  const { onLine, ...rest } = options;
  // exec() dispatches via `onOutput(msg, isError)`; index.js uses `onLine(msg)`.
  // Bridge the two so collectLine actually receives tauri's stdout.
  const execOptions = onLine ? { ...rest, onOutput: (msg) => onLine(msg) } : rest;
  return exec("npx", `tauri ${args}`, execOptions).end();
}
