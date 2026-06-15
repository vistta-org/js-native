import fs from "@vistta/fs";
import { applyTemplate } from "./apply-template.js";
import {
  mergeConfig,
  patchAndroidManifest,
  patchAndroidStrings,
  patchBuildTask,
  patchCapabilities,
  patchCargoToml,
  patchLibRs,
  patchMainActivity,
  patchMainRs,
  patchVisttaService,
} from "./patches/index.js";
import { exec, generateIcons, getInfo, platform, resolveAppId } from "./utils/index.js";

const TEMPLATE_DIR = fs.resolve(import.meta.dirname, "./template");
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
 * @property {string} [title] - Window title.
 * @property {string} [icon] - Icon path (relative to buildDir/www).
 * @property {string} [backgroundColor] - Window background color (hex).
 * @property {{csp?: string|null}} [security]
 * @property {Object} [extraTauriConfig] - Deep-merged into the generated tauri.conf.json.
 * @property {Record<string, string|object>} [extraCargoDependencies] - Extra Cargo deps appended to [dependencies].
 * @property {Array<string|object>} [extraCapabilities] - Extra entries merged into capabilities/default.json permissions.
 * @property {string} [devUrl] - For `run()`: dev server URL the webview loads (otherwise frontendDist is used).
 * @param {(message: string, isError: boolean) => void} [onOutput] - Receives stdout/stderr lines from `tauri`. When provided, child stdio is piped; otherwise it's inherited.
 * @property {Object} [signing] - Platform code-signing settings. Windows + macOS settings are forwarded to `tauri.conf.json` bundle config; Android signing is currently opt-in (set `signing.android` to provide a pre-existing keystore) and the runtime does not auto-generate a keystore.
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
        const appId = resolveAppId(config);
        await adb(
          `install -r ${fs.resolve(
            config.buildDir,
            "gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk",
          )}`,
        );
        await adb(`shell am start -n ${appId}/${appId}.MainActivity`);
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
            await adb(`shell pm uninstall ${appId}`);
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
  const collectLine = (line) => {
    const m = line.match(/Finished\s+\d+\s+\S+\s+at:\s*(.+)$/i);
    if (m) artifacts.push(m[1].trim());
  };
  const onLine = (msg, isError) => {
    for (const line of String(msg).replace(/\r\n/g, "\n").split("\n")) {
      if (!line) continue;
      collectLine(line);
      if (config.onOutput) config.onOutput(line + "\n", isError);
    }
  };

  switch (config.target) {
    case "android": {
      const androidGen = fs.resolve(cwd, "gen", "android");
      if (!fs.existsSync(androidGen)) await tauri("android init", { cwd, onLine });
      await patchBuildTask(cwd, config);
      await patchAndroidManifest(cwd, config);
      await patchAndroidStrings(cwd, config);
      await patchMainActivity(cwd, config);
      await patchVisttaService(cwd, config);
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
      try {
        await tauri(`build ${debug}`, { cwd, onLine });
      } catch {
        throw new Error(desktopBuildHint());
      }
      artifacts.push(...(await defaultDesktopArtifacts(cwd, debug)));
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

async function defaultDesktopArtifacts(cwd, debug) {
  const info = await getInfo({});
  const exe = info.name + (platform() === "win32" ? ".exe" : "");
  const release = fs.resolve(cwd, "target/release", exe);
  const dbg = fs.resolve(cwd, "target/debug", exe);
  if (fs.existsSync(release)) return [release];
  if (fs.existsSync(dbg)) return [dbg];
  return [debug ? dbg : release];
}

/**
 * Seeds buildDir from the package's `template/` directory (a verbatim
 * `tauri init` baseline at TAURI_VERSION), then runs the generators
 * (patchMainRs, patchLibRs, patchCargoToml, mergeConfig, patchCapabilities)
 * which overwrite their files in full. Consumers customise via the
 * config object, not by editing files in buildDir.
 */
async function applyConfig(config) {
  const cwd = config.buildDir;
  await applyTemplate({ buildDir: cwd, tplDir: TEMPLATE_DIR });
  await patchMainRs(cwd, config);
  await patchLibRs(cwd, config);
  await patchCargoToml(cwd, config);
  await mergeConfig(cwd, config);
  await patchCapabilities(cwd, config);
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
 * The mode handling (tee-to-TTY + dispatch when an `onLine`/`onOutput`
 * callback is present, inherit-stdio fast path otherwise) lives in `exec()`
 * so every spawned command — adb, the desktop binary, this one — gets the
 * same treatment. This wrapper is now just a thin convenience for the
 * `npx tauri` prefix.
 *
 * Rejects on non-zero exit.
 */
function tauri(args, options = {}) {
  return exec("npx", `tauri ${args}`, options).end();
}
