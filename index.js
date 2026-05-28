import fs from "@vistta/fs";
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
  await mergeConfig(cwd, config);

  const iconPath = config?.icon && config?.buildDir && fs.resolve(config.buildDir, "www", config.icon);
  switch (config.target) {
    case "android": {
      try {
        if (!fs.existsSync(fs.resolve(config.buildDir, "gen", config.target))) await tauri(`${config.target} init`, { cwd });
        await patchBuildTask(cwd, config);
        await patchAndroidManifest(cwd);
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
        return await tauri(`build ${DEV ? "--debug" : "--release"}`, { cwd });
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
    else if (!fs.existsSync(destPath)) await fs.copyFile(srcPath, destPath);
  }
}

async function patchBuildTask(targetDir, config) {
  const appId = config?.app?.id || "org.vistta.app";
  const packagePath = appId.replace(/\./g, "/");
  const buildTaskPath = fs.resolve(
    targetDir,
    "gen",
    "android",
    "buildSrc",
    "src",
    "main",
    "java",
    packagePath,
    "kotlin",
    "BuildTask.kt",
  );
  if (!fs.existsSync(buildTaskPath)) return;
  let content = String(await fs.readFile(buildTaskPath, "utf8"));
  content = content.replace(/val executable = """npm""";/g, 'val executable = """npx""";');
  content = content.replace(/val args = listOf\("run", "--", "tauri"/g, 'val args = listOf("tauri"');
  await fs.writeFile(buildTaskPath, content);
}

async function patchAndroidManifest(targetDir) {
  const manifestPath = fs.resolve(targetDir, "gen", "android", "app", "src", "main", "AndroidManifest.xml");
  if (!fs.existsSync(manifestPath)) return;
  let content = String(await fs.readFile(manifestPath, "utf8"));
  if (!content.includes("POST_NOTIFICATIONS")) {
    content = content.replace(
      /<uses-permission android:name="android.permission.INTERNET" \/>/,
      `<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />`,
    );
    await fs.writeFile(manifestPath, content);
  }
}

async function patchCargoToml(targetDir, config) {
  const cargoPath = fs.resolve(targetDir, "Cargo.toml");
  if (!fs.existsSync(cargoPath)) return;
  const { name, version, description, author, lib } = await getInfo(config);
  await fs.writeFile(
    cargoPath,
    String(await fs.readFile(cargoPath, "utf8"))
      .replace(/^name\s*=\s*".*"/m, `name = "${name}"`)
      .replace(/^version\s*=\s*".*"/m, `version = "${version}"`)
      .replace(/^description\s*=\s*".*"/m, `description = "${description}"`)
      .replace(/^authors\s*=\s*\[.*\]/m, `authors = ["${author}"]`)
      .replace(/^\[lib\]\s*\nname\s*=\s*".*"/m, `[lib]\nname = "${lib}"`),
  );
}

async function patchMainRs(targetDir, config) {
  const mainPath = fs.resolve(targetDir, "src", "main.rs");
  if (!fs.existsSync(mainPath)) return;
  const { lib } = await getInfo(config);
  const appId = config?.app?.id || "org.vistta.app";
  await fs.writeFile(
    mainPath,
    String(await fs.readFile(mainPath, "utf8"))
      .replace(/vistta_js_example/g, lib)
      .replace(/vistta_app_id/g, appId),
  );
}

async function mergeConfig(targetDir, config) {
  const confPath = fs.resolve(targetDir, "tauri.conf.json");

  const tauriConf = {
    $schema: "https://schema.tauri.app/config/2",
    productName: config?.app?.name || config?.title || "Vistta App",
    identifier: config?.app?.id || "org.vistta.app",
    version: "0.1.0",
    build: {
      beforeBuildCommand: "",
      beforeDevCommand: "",
      frontendDist: "www",
    },
    app: {
      withGlobalTauri: true,
      windows: [
        {
          title: config?.app?.title || config?.title || "Vistta App",
          width: config?.app?.width || 1280,
          height: config?.app?.height || 800,
          minWidth: config?.app?.minWidth || 320,
          minHeight: config?.app?.minHeight || 480,
          center: config?.app?.center !== undefined ? config.app.center : true,
          resizable: config?.app?.resizable !== undefined ? config.app.resizable : true,
          fullscreen: config?.app?.fullscreen !== undefined ? config.app.fullscreen : false,
          decorations: true,
          transparent: false,
          alwaysOnTop: false,
        },
      ],
      security: { csp: null },
    },
    bundle: {
      active: true,
      targets: "all",
      icon: ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"],
    },
    plugins: { shell: { open: true } },
  };

  if (config?.backgroundColor) tauriConf.app.windows[0].backgroundColor = config.backgroundColor;

  await fs.writeFile(confPath, JSON.stringify(tauriConf, null, 2));
}

function tauri(args, options) {
  return exec("npx", `tauri ${args}`, options).end();
}

function adb(args, options) {
  return exec("adb", args, { shell: false, ...options }).end();
}
