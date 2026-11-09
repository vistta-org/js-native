import fs from "@vistta/fs";
import { fileURLToPath } from "node:url";
import {
  mergeConfig,
  patchAndroidManifest,
  patchAndroidStrings,
  patchAppGradleSigning,
  patchBuildTask,
  patchCapabilities,
  patchCargoToml,
  patchLibRs,
  patchMainActivity,
  patchMainRs,
} from "./patches/index.js";
import {
  applyTemplate,
  exec,
  generateIcons,
  getInfo,
  platform,
  resolveAppId,
  resolveApplicationId,
  resolveIconPath,
  resolvePlatform,
  resolveTargets,
} from "./utils/index.js";

const TEMPLATE_DIR = fs.resolve(import.meta.dirname, "./rust");
const TAURI_CLI = fileURLToPath(import.meta.resolve("@tauri-apps/cli/tauri.js"));
const TAURI_VERSION = "2.12.1";
const DEV = process.env.NODE_ENV === "development";

/**
 * @typedef {Object} Config
 * @property {"desktop"|"android"|"ios"|"linux"|"windows"|"macos"} platform - Target platform. "linux"/"windows"/"macos" map to "desktop" (with "windows"/"macos" auto-setting crossCompile); at the runtime level only "desktop"/"android"/"ios" are used internally.
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
 * @property {boolean} [app.multipleInstances] - Desktop only. Desktop apps run as a single instance by default: launching again shows the existing window (`main`, or `ide` when `app.visible` is false) instead of starting a second process. Set to true to allow multiple instances. Has no effect on Android/iOS.
 * @property {boolean} [app.assistant] - Android only. When true, the app registers an ASSIST intent-filter so it can be chosen as the system Digital Assistant app (long-press power / assistant gesture). The trigger opens the app with a `launch-action` `{ id: "assistant", payload }` where `payload` is the app-published payload set via `Accessibility.setAssistant()`. Has no effect on desktop/iOS.
 * @property {boolean} [app.autofill] - Android only. Registers the API 26+ Vistta Autofill service when true. The application must provide a Vault handler; disabled by default.
 * @property {string} [app.version] - App version (forwarded to bundle versioning; used to disambiguate desktop installers).
 * @property {string} [title] - Window title.
 * @property {string} [icon] - Icon path (relative to buildDir/www, a web-root asset URL, or an absolute filesystem path).
 * @property {string} [backgroundColor] - Window background color (hex).
 * @property {{csp?: string|null}} [security]
 * @property {Object} [extraTauriConfig] - Deep-merged into the generated tauri.conf.json.
 * @property {Record<string, string|object>} [extraCargoDependencies] - Extra Cargo deps appended to [dependencies].
 * @property {Array<string|object>} [extraCapabilities] - Extra entries merged into capabilities/default.json permissions.
 * @property {string} [devUrl] - Tauri devUrl for external dev tooling. run() only launches an already-built app.
 * @property {Object | string} [keystore] - Path to a pre-existing Android signing keystore (`.keystore`/`.jks`) or an object with `file` and `password` properties. If set, overrides auto-generation.
 * @property {string} [keystore.file] - Path to a pre-existing Android signing keystore (`.keystore`/`.jks`). If set, overrides auto-generation.
 * @property {string} [keystore.password] - Password for the keystore and key (alias is `upload`). If `keystore.file` is set but this is omitted, falls back to the `ANDROID_KEYSTORE_PASSWORD` env var.
 * @property {string} [name] - Override for the artifact base name (defaults to `app.name`). Output is lowercased.
 * @property {string} [crossCompile] - Rust target triple for cross-compilation (e.g. `"x86_64-pc-windows-gnu"` to build Windows installers from Linux). When set, `--target <triple>` is passed to `tauri build` and artifact paths are resolved under `target/<triple>/release/`.
 * @property {string|string[]|Object<string,string|string[]>} [target] - Bundle format(s) to produce for the current platform. Accepts a single value, a list, or a per-platform object keyed by `desktop`/`android`/`ios`. Android: `"apk"` / `"aab"` (default: both). iOS: `"ipa"` / `"app"` (default: ipa). Desktop: Tauri `bundle.targets` values (`"msi"`, `"nsis"`, `"deb"`, `"rpm"`, `"appimage"`, `"app"`, `"dmg"`, or `"all"`; default: `"all"`).
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
  const resolved = resolvePlatform(config.platform);
  config = { ...config, ...resolved };
  switch (config.platform) {
    case "ios":
      throw new Error("iOS target is not supported yet.");
    case "android": {
      let closeCallback = null;
      let closed = false;
      const appId = resolveApplicationId(config);
      const namespace = resolveAppId(config);
      const type = DEV ? "debug" : "release";
      const apk = fs.resolve(
        config.buildDir,
        `gen/android/app/build/outputs/apk/universal/${type}/app-universal-${type}.apk`,
      );
      if (!fs.existsSync(apk))
        throw new Error(`Built APK not found at ${apk}. Run build() with target: "apk" in the same NODE_ENV first.`);
      await adb(["install", "-r", apk]);
      // The component name is {applicationId}/{namespace}.MainActivity.
      // The applicationId may have a .dev suffix (via debugApplicationIdSuffix)
      // but the activity class lives under the stable namespace.
      await adb(["shell", "am", "start", "-n", `${appId}/${namespace}.MainActivity`]);
      let resolveClosed;
      const completion = new Promise((resolve) => {
        resolveClosed = resolve;
      });
      const finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(interval);
        resolveClosed();
        closeCallback?.(0, null);
      };
      let polling = false;
      const interval = setInterval(async () => {
        if (closed || polling) return;
        polling = true;
        try {
          const result = await adb(["shell", "pidof", appId]);
          if (!result.trim()) finish();
        } catch {
          finish();
        } finally {
          polling = false;
        }
      }, 1000);
      return {
        on(event, callback) {
          if (event === "close") closeCallback = callback;
        },
        close: async () => {
          if (closed) return;
          try {
            await adb(["shell", "am", "force-stop", appId]);
          } finally {
            finish();
          }
        },
        end: () => completion,
      };
    }
    case "desktop": {
      const info = await getInfo(config);
      const app = info.name + (platform() === "win32" ? ".exe" : "");
      const target = config.crossCompile
        ? fs.resolve(config.buildDir, "target", config.crossCompile)
        : fs.resolve(config.buildDir, "target");
      const executable = fs.resolve(target, DEV ? "debug" : "release", app);
      if (!fs.existsSync(executable))
        throw new Error(`Built executable not found at ${executable}. Run build() in the same NODE_ENV first.`);
      return exec(executable, [], { shell: false });
    }
    default:
      throw new Error(`Unsupported platform "${config.platform}". Supported platforms: desktop, android, ios.`);
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
  const cliPlatform = config.platform;
  const resolved = resolvePlatform(cliPlatform);
  config = { ...config, ...resolved, __cliPlatform: cliPlatform };
  await applyConfig(config);

  const cwd = config.buildDir;
  const iconPath = resolveIconPath(config);
  const type = /** @type {"release" | "debug"} */ (DEV ? "debug" : "release");
  const debug = DEV ? "--debug" : "";

  const artifacts = [];
  let expectBundlePaths = false;
  const collectLine = (line) => {
    const header = line.match(/Finished\s+\d+\s+(?:bundles?|artifacts?|apks?|aabs?)\s+at:\s*$/i);
    if (header) {
      expectBundlePaths = true;
      return;
    }
    if (expectBundlePaths) {
      const m = line.match(
        /^\s+(.+\.(?:msi|exe|app|ipa|apk|aab|deb|rpm|appimage|dmg))(?:\s+\(\d+(?:\.\d+)?\s+[KMGTPE]?i?B\))?\s*$/i,
      );
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
  let pendingOutput = "";
  const onLine = (msg) => {
    const lines = (pendingOutput + String(msg)).split(/\r?\n/);
    pendingOutput = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      collectLine(line);
    }
  };
  const flushOutput = () => {
    if (pendingOutput) collectLine(pendingOutput);
    pendingOutput = "";
  };

  switch (config.platform) {
    case "android": {
      const androidGen = fs.resolve(cwd, "gen", "android");
      if (!fs.existsSync(androidGen)) await tauri(["android", "init"], { cwd, onLine });
      await patchBuildTask(cwd, config);
      await patchAndroidManifest(cwd, config);
      await patchMainActivity(cwd, config);
      await patchAndroidStrings(cwd, config);
      const signingEnv = await patchAppGradleSigning(cwd, config);
      await generateIcons({ target: "android", buildDir: cwd, sourceIcon: iconPath });
      const androidTargets = resolveTargets(config, "android");
      const apkFlag = androidTargets.includes("apk") ? "--apk" : "";
      const aabFlag = androidTargets.includes("aab") ? "--aab" : "";
      const formatFlags = [apkFlag, aabFlag].filter(Boolean);
      try {
        await tauri(["android", "build", ...[debug].filter(Boolean), ...formatFlags], {
          cwd,
          onLine,
          env: { ...process.env, ...signingEnv },
        });
      } catch (error) {
        throw new Error(`Android build failed: ${error.message}. Check the Android SDK and build tools.`, { cause: error });
      }
      flushOutput();
      if (artifacts.length === 0) artifacts.push(...defaultAndroidArtifacts(cwd, debug, androidTargets));
      return { type, paths: artifacts };
    }
    case "ios": {
      if (!fs.existsSync(fs.resolve(cwd, "gen", "ios"))) await tauri(["ios", "init"], { cwd, onLine });
      await generateIcons({ target: "ios", buildDir: cwd, sourceIcon: iconPath });
      const iosTargets = resolveTargets(config, "ios");
      const archiveFlag = iosTargets.includes("app") && !iosTargets.includes("ipa") ? "--archive-only" : "";
      await tauri(["ios", "build", ...[debug, archiveFlag].filter(Boolean)], { cwd, onLine });
      flushOutput();
      if (artifacts.length === 0) artifacts.push(...defaultIosArtifacts(cwd));
      return { type, paths: artifacts };
    }
    case "desktop": {
      await generateIcons({ target: "desktop", buildDir: cwd, sourceIcon: iconPath });
      const crossTarget = config?.crossCompile || "";
      const targetFlag = crossTarget ? ["--target", crossTarget] : [];
      try {
        await tauri(["build", ...[debug].filter(Boolean), ...targetFlag], { cwd, onLine });
      } catch (error) {
        throw new Error(`${desktopBuildHint()} ${error.message}`, { cause: error });
      }
      // Prefer installers (msi/nsis) captured from tauri output; fall back to
      // well-known bundle paths, then the raw binary.
      flushOutput();
      if (artifacts.length === 0 && config?.extraTauriConfig?.bundle?.active !== false)
        artifacts.push(
          ...defaultDesktopBundles(cwd, debug, config?.app?.version, crossTarget, resolveTargets(config, "desktop")),
        );
      artifacts.push(...(await defaultDesktopArtifacts(cwd, debug, crossTarget, config)));
      return { type, paths: [...new Set(artifacts.map((artifact) => fs.resolve(cwd, artifact)))] };
    }
    default:
      throw new Error(`Unsupported platform "${config.platform}". Supported: desktop, android, ios.`);
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
 * @param {string} [args.name] - Override for the base name (takes priority over `appName`).
 * @param {string} [args.version]
 * @param {"release" | "debug"} args.type
 * @param {string} args.sourcePath - The original artifact path (used to pick the right extension).
 * @returns {string}
 */
export function artifactName({ appName, name, version, type, sourcePath }) {
  const ext = fs.extname(sourcePath);
  const safe = (s) =>
    String(s || "")
      .replace(/[\s\\/:*?"<>|]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .trim();
  const installer = /^\.exe$/i.test(ext) && /[\\/]bundle[\\/]nsis[\\/]/i.test(sourcePath);
  const includeType = /^\.(apk|exe)$/i.test(ext);
  const typeSeg = installer ? "-setup" : includeType ? `-${type}` : "";
  const dev = DEV ? ".dev" : "";
  if (name) {
    if (safe(name) !== name) throw new Error(`Invalid artifact name "${name}". Example of a safe name: "${safe(name)}"`);
    return `${name}${typeSeg}${dev}${ext}`;
  }
  return `${safe(appName) || "app"}${version ? `-${safe(version)}` : ""}${typeSeg}${dev}${ext}`.toLowerCase();
}

export { getInfo, platform, TAURI_VERSION };
export const Tauri = { run, build };

function defaultAndroidArtifacts(cwd, debug, targets) {
  const buildType = debug ? "debug" : "release";
  const apkName = debug ? `app-universal-${buildType}.apk` : null;
  const aabName = debug ? "debug" : "release";
  const aabDir = debug ? "universalDebug" : "universalRelease";
  const out = [];
  if (targets.includes("apk")) {
    if (apkName) {
      out.push(fs.resolve(cwd, `gen/android/app/build/outputs/apk/universal/${buildType}/${apkName}`));
    } else {
      out.push(
        fs.resolve(cwd, `gen/android/app/build/outputs/apk/universal/${buildType}/app-universal-release.apk`),
        fs.resolve(cwd, `gen/android/app/build/outputs/apk/universal/${buildType}/app-universal-release-unsigned.apk`),
      );
    }
  }
  if (targets.includes("aab")) {
    out.push(fs.resolve(cwd, `gen/android/app/build/outputs/bundle/${aabDir}/app-universal-${aabName}.aab`));
  }
  return out;
}

function defaultIosArtifacts(cwd) {
  return [fs.resolve(cwd, "gen/ios/build/Build/Products/Release-iphoneos")];
}

async function defaultDesktopArtifacts(cwd, debug, crossTarget = "", config = {}) {
  const info = await getInfo(config);
  const isWindows = crossTarget ? /-windows-/.test(crossTarget) : platform() === "win32";
  const exe = info.name + (isWindows ? ".exe" : "");
  const targetDir = crossTarget ? fs.resolve(cwd, "target", crossTarget) : fs.resolve(cwd, "target");
  return [fs.resolve(targetDir, debug ? "debug" : "release", exe)];
}

/**
 * Fallback paths for desktop installers (msi on Windows, .deb/.rpm/.AppImage
 * on Linux, .app/.dmg on macOS) when tauri's `Finished N bundles at:` lines
 * weren't captured. Only returns paths that exist on disk.
 */
function defaultDesktopBundles(cwd, debug, version, crossTarget = "", targets = ["all"]) {
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
  const requested = new Set(targets.map((target) => (target === "exe" ? "nsis" : target)));
  for (const dir of candidates) {
    if (!requested.has("all") && !requested.has(fs.basename(dir))) continue;
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
 * Asserts that the declared and resolved installed CLI versions match
 * the hardcoded template baseline `TAURI_VERSION`.
 * The two are separate sources of truth — `TAURI_VERSION` drives the
 * template baseline and the generated `Cargo.toml`, while
 * `@tauri-apps/cli` is resolved directly for execution. A mismatch causes
 * confusing build failures (e.g. the template is for 2.11 but the CLI is
 * 2.12 and emits a different `gen/android` layout). This check turns a
 * silent mismatch into a clear error at the start of the build.
 */
function assertTauriVersion() {
  const pkgPath = fs.resolve(import.meta.dirname, "package.json");
  const pkg = JSON.parse(String(fs.readFileSync(pkgPath, "utf8")));
  const cliDep = pkg.dependencies?.["@tauri-apps/cli"];
  const installed = JSON.parse(String(fs.readFileSync(fs.resolve(fs.dirname(TAURI_CLI), "package.json"), "utf8")));
  if (cliDep !== TAURI_VERSION || installed.version !== TAURI_VERSION) {
    throw new Error(
      `Tauri version mismatch: expected "${TAURI_VERSION}", declared "${cliDep}", installed "${installed.version}". ` +
        `Update both to the same version. See the "Upgrading Tauri" section in the README.`,
    );
  }
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

async function adb(args) {
  let output = "";
  const command = exec("adb", args, { shell: false, stdio: "pipe" });
  command.on("data", (text) => {
    output += text;
  });
  try {
    await command.end();
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error("ADB not found. Please install Android SDK Platform Tools and ensure 'adb' is in your PATH.", {
        cause: error,
      });
    throw new Error(`ADB command failed: ${output.trim() || error.message}`, { cause: error });
  }
  return output;
}

/**
 * Spawns the installed Tauri CLI with an argument array and waits for completion.
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
  return exec(process.execPath, [TAURI_CLI, ...args], { ...execOptions, shell: false }).end();
}
