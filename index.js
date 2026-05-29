import fs from "@vistta/fs";
import {
  generateForegroundService,
  mergeConfig,
  patchAndroidManifest,
  patchBuildTask,
  patchCargoToml,
  patchLibRs,
  patchMainActivity,
  patchMainRs,
  removeForegroundService,
} from "./patches";
import { exec, generateIcons, getInfo, platform } from "./utils";

const TEMPLATE_DIR = fs.resolve(import.meta.dirname, "./template");
const DEV = process.env.NODE_ENV === "development";

/**
 * @typedef {Object} Config
 * @property {string} target - Target platform ("desktop", "android", "ios")
 * @property {string} buildDir - Build output directory
 * @property {Object} app - App settings (id, name, etc.)
 * @property {string} app.id - App identifier (e.g., "com.example.app")
 * @property {string} [app.name] - App display name
 * @property {number} [app.width] - Window width
 * @property {number} [app.height] - Window height
 * @property {number} [app.minWidth] - Minimum window width
 * @property {number} [app.minHeight] - Minimum window height
 * @property {boolean} [app.center] - Center window on screen
 * @property {boolean} [app.resizable] - Allow window resize
 * @property {boolean} [app.fullscreen] - Start in fullscreen
 * @property {boolean} [app.devTools] - Open DevTools on startup
 * @property {boolean} [app.background] - Keep app running in background (tray on desktop, foreground service on Android)
 * @property {string} [title] - Window title
 * @property {string} [icon] - Icon path (relative to buildDir)
 * @property {string} [backgroundColor] - Window background color (hex)
 */

/**
 * Run the Tauri app in development mode.
 * @param {Config} config - Configuration object
 */
export async function run(config) {
  switch (config.target) {
    case "ios":
      throw new Error("iOS target is not supported yet.");
    case "android":
      try {
        let closeCallback = null;
        let closed = false;
        await adb(
          `install -r ${fs.resolve(config.buildDir, `gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`)}`,
        );
        await adb(`shell am start -n ${config.app.id}/.MainActivity`);
        const interval = setInterval(async () => {
          try {
            const result = await adb(`shell dumpsys activity activities ${config.app.id}`);
            if (!result.toString().includes(config.app.id)) throw new Error("App not running");
          } catch {
            closed = true;
            if (closeCallback) closeCallback(0, null);
            clearInterval(interval);
          }
        }, 1000); // keep process alive

        return {
          on(event, callback) {
            if (event === "close") closeCallback = callback;
          },
          close: async () => {
            await adb(`shell am force-stop ${config.app.id}`);
            await adb(`shell pm uninstall ${config.app.id}`);
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
 * Build the Tauri app for distribution.
 * @param {Config} config - Configuration object
 */
export async function build(config) {
  const cwd = config.buildDir;
  await copyTemplate(TEMPLATE_DIR, cwd);
  await patchMainRs(cwd, config);
  await patchCargoToml(cwd, config);
  if (config?.app?.background) await patchLibRs(cwd);
  await mergeConfig(cwd, config);

  const iconPath = config?.icon && config?.buildDir && fs.resolve(config.buildDir, "www", config.icon);
  switch (config.target) {
    case "android": {
      try {
        if (!fs.existsSync(fs.resolve(config.buildDir, "gen", config.target))) await tauri(`${config.target} init`, { cwd });
        await patchBuildTask(cwd, config);
        await patchAndroidManifest(cwd, config);
        if (config?.app?.background) {
          await generateForegroundService(cwd, config);
          await patchMainActivity(cwd, config);
        } else {
          await removeForegroundService(cwd, config);
        }
        if (fs.existsSync(iconPath)) await generateIcons({ target: "android", buildDir: cwd, sourceIcon: iconPath });
        return await tauri(`${config.target} build ${DEV ? "--debug" : "--release"}`, { cwd, stdio: "inherit" });
      } catch {
        throw new Error("Build failed. Please ensure you have the Android SDK and necessary build tools installed.");
      }
    }
    case "ios": {
      if (!fs.existsSync(fs.resolve(config.buildDir, "gen", config.target))) await tauri(`${config.target} init`);
      if (fs.existsSync(iconPath)) await generateIcons({ target: "ios", buildDir: cwd, sourceIcon: iconPath });
      return await tauri(`${config.target} build ${DEV ? "--debug" : "--release"}`, { cwd });
    }
    case "desktop":
      try {
        if (fs.existsSync(iconPath)) await generateIcons({ target: "desktop", buildDir: cwd, sourceIcon: iconPath });
        return await tauri(`build ${DEV ? "--debug" : "--release"}`, { cwd, stdio: "inherit" });
      } catch {
        switch (platform()) {
          case "win32":
            throw new Error(
              "Build failed. Please ensure you have the Visual C++ Build Tools installed: https://visualstudio.microsoft.com/visual-cpp-build-tools/",
            );
          case "darwin":
            throw new Error(
              "Build failed. Please ensure you have Xcode Command Line Tools installed: xcode-select --install",
            );
          case "linux":
            throw new Error(
              "Build failed. Please ensure you have the necessary build tools installed (e.g., build-essential on Debian/Ubuntu).",
            );
          default:
            throw new Error("Build failed. Please ensure you have the necessary build tools installed for your platform.");
        }
      }
    default:
      throw new Error(`Unsupported target "${config.target}". Supported targets: desktop, android, ios.`);
  }
}

async function copyTemplate(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = fs.resolve(src, entry);
    const destPath = fs.resolve(dest, entry);
    if (fs.isDirectory(srcPath)) await copyTemplate(srcPath, destPath);
    else await fs.copyFile(srcPath, destPath);
  }
}

function tauri(args, options) {
  return exec("npx", `tauri ${args}`, options).end();
}

function adb(args, options) {
  return exec("adb", args, { shell: false, ...options }).end();
}
