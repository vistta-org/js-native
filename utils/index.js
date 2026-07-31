import fs from "@vistta/fs";
import { spawn } from "node:child_process";
import { platform } from "node:os";

let cachedPkg;

async function readPkg() {
  if (cachedPkg) return cachedPkg;
  const pkgPath = fs.resolve(process.cwd(), "package.json");
  if (!fs.existsSync(pkgPath)) return (cachedPkg = {});
  try {
    cachedPkg = JSON.parse(String(await fs.readFile(pkgPath, "utf8")));
  } catch {
    cachedPkg = {};
  }
  return cachedPkg;
}

export async function getInfo(config) {
  const pkg = await readPkg();
  const rawName = config?.app?.name || pkg.name || config?.title || "Vistta App";
  const slug = rawName.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase();
  const author = typeof pkg.author === "object" ? pkg.author?.name || "unknown" : pkg.author || "unknown";
  // The Cargo package name drives the binary artifact name on disk
  // (target/debug/<name>.exe, etc.), so this must match [package].name
  // written by patchCargoToml. The crate name is mode-stable (no dev
  // suffix) so Cargo's incremental build cache isn't invalidated when
  // switching between dev and release. Cargo's own target/debug/ vs
  // target/release/ split keeps the dev and release binaries separate.
  return {
    name: slug,
    version: pkg.version || "0.1.0",
    description: pkg.description || pkg.name || "",
    author,
    lib: `${sanitizeCrateName(slug)}_lib`,
  };
}

/**
 * Returns the base app identifier (e.g. `org.vistta.connect`). This is the
 * value used for the Tauri `identifier` in `tauri.conf.json`, the Android
 * `namespace`, and the Kotlin package path — all of which must stay stable
 * across dev/release so `tauri android init`'s generated source tree doesn't
 * drift.
 *
 * For the actual runtime applicationId (what `adb` installs/launches, what
 * appears on the Windows taskbar), use `resolveApplicationId()` which
 * appends the `.dev` suffix in development. Tauri's
 * `bundle.android.debugApplicationIdSuffix` handles the Android
 * applicationId suffix natively.
 */
export function resolveAppId(config) {
  return config?.app?.id || "org.vistta.app";
}

const DEFAULT_TARGETS = {
  android: ["apk", "aab"],
  ios: ["ipa"],
  desktop: ["all"],
};

/**
 * Maps CLI platform names to runtime platform + optional cross-compile triple.
 * "windows" and "linux" map to "desktop"; "windows" auto-sets crossCompile
 * to the MinGW target so Windows installers are cross-compiled from a non-Windows
 * host (e.g. Linux → Windows). When building *on* Windows, no crossCompile is
 * set so the native MSVC toolchain is used. "macos" is not supported yet (like
 * "ios"). "desktop" is kept as a hidden alias for backward compatibility — it
 * builds for the host platform natively.
 *
 * @param {string} platform - Platform name (linux, windows, macos, desktop, android, ios)
 * @returns {{platform: "desktop"|"android"|"ios", crossCompile?: string}}
 */
const host = platform();
const PLATFORM_MAP = {
  linux: { platform: "desktop" },
  windows: { platform: "desktop", ...(host !== "win32" && { crossCompile: "x86_64-pc-windows-gnu" }) },
  macos: { platform: "desktop", ...(host !== "darwin" && { crossCompile: "x86_64-apple-darwin" }) },
  desktop: { platform: "desktop" },
  android: { platform: "android" },
  ios: { platform: "ios" },
};
export function resolvePlatform(platform) {
  return PLATFORM_MAP[platform] || { platform };
}

/**
 * Resolves the bundle format list for a given platform from `config.target`.
 * Accepts a flat value/list (applies to the current platform) or a per-platform
 * object keyed by platform name. When using a per-platform object, both the
 * resolved runtime platform ("desktop"/"android"/"ios") and the original CLI
 * platform name ("linux"/"windows"/"macos") are checked. Returns the platform's
 * default list when `config.target` is absent.
 *
 * @param {object} config
 * @param {"desktop"|"android"|"ios"} platform
 * @returns {string[]}
 */
export function resolveTargets(config, platform) {
  const t = config?.target;
  if (t == null) return DEFAULT_TARGETS[platform] || [];
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t;
  if (typeof t === "object") {
    // Check the resolved platform name first, then the original CLI platform
    // name (e.g. "windows" → "desktop" but the user may have keyed by "windows").
    const cliPlatform = config?.__cliPlatform;
    const v = t[platform] ?? (cliPlatform ? t[cliPlatform] : null);
    if (v == null) return DEFAULT_TARGETS[platform] || [];
    return typeof v === "string" ? [v] : Array.isArray(v) ? v : [];
  }
  return [];
}

/**
 * Returns the actual applicationId the built app will have at runtime.
 * In development a `.dev` suffix is appended so the resulting APK installs
 * side-by-side with the release build. On Android this matches what Tauri
 * produces via `bundle.android.debugApplicationIdSuffix`; on desktop it's
 * used for the Windows AppUserModelID. Use this for `adb` commands and
 * any runtime identifier that needs to match the installed app.
 */
export function resolveApplicationId(config) {
  const id = resolveAppId(config);
  return process.env.NODE_ENV === "development" ? `${id}.dev` : id;
}

/**
 * Suffix appended to user-facing display names (window title, launcher label,
 * notification text, etc.) when `NODE_ENV=development`, so dev and release
 * builds are visually distinguishable on a device that has both installed.
 * Empty string in release builds. Single source of truth for the format —
 * `mergeConfig` (tauri.conf.json productName/title), the Android manifest
 * patch, and the Android strings.xml patch all read from here so they
 * never drift apart.
 */
export function devSuffix() {
  return process.env.NODE_ENV === "development" ? " [DEV]" : "";
}

/**
 * Suffix appended to user-facing machine names (productName in
 * tauri.conf.json, app display name) in development builds, so the dev
 * install has a distinct name from the release install and both can
 * coexist on the same machine/device. Single source of truth —
 * mergeConfig and patchCargoToml both read from here.
 */
export function nameSuffix() {
  return process.env.NODE_ENV === "development" ? " (Dev)" : "";
}

// Cargo crate name rules: snake_case, must start with a letter, cannot be a Rust
// keyword or a Cargo reserved name (test, bench, etc). Falls back to a prefixed
// name when input is invalid.
const RUST_RESERVED = new Set([
  "test",
  "tests",
  "bench",
  "build",
  "core",
  "std",
  "self",
  "super",
  "crate",
  "type",
  "match",
  "fn",
  "mod",
  "use",
  "let",
  "mut",
  "ref",
  "as",
  "where",
]);
function sanitizeCrateName(slug) {
  let name = slug.replace(/-/g, "_").replace(/[^a-zA-Z0-9_]/g, "_");
  if (!/^[a-zA-Z]/.test(name) || RUST_RESERVED.has(name)) name = "app_" + name;
  return name;
}

/**
 * Spawns a child process.
 *
 * `args` accepts either a string (split on spaces — convenient but fragile if any
 * argument contains spaces) or an array (preferred; passed straight through).
 *
 * Returns a handle with `close()`, `on(event, cb)`, and `end()` (Promise that
 * resolves with the child on exit code 0, or rejects otherwise).
 *
 * Output handling — three modes, picked from the options bag:
 *
 *  - `stdio: "inherit"` (explicit): the child's stdio is bound straight to the
 *    parent TTY. No parsing, no buffering, no callback. Use this for short
 *    commands where you don't want captured output (e.g. background adb polls
 *    that would otherwise spam the terminal every second).
 *  - `onOutput` callback set: stdio is piped and every chunk is (a) written
 *    verbatim to `process.stdout` so the user sees live progress bars while
 *    the callback parses them, and (b) forwarded to `onOutput(msg, isError)`
 *    for line-splitting / artifact collection. `isError` is a heuristic
 *    (`/\b(error|failed)\b/i.test(msg)`) — true for either stream.
 *  - neither (default): stdio is inherited. Equivalent to passing
 *    `stdio: "inherit"` explicitly, but kept as the no-arg default so callers
 *    like `run()`'s adb polling get the quiet fast path automatically.
 *
 * The legacy `on(event, cb)` interface (where `event === "data"` attaches a
 * second listener post-spawn) is preserved for backward compatibility — it
 * only works when stdio is piped.
 *
 * @param {string} cmd
 * @param {string|string[]|object} [args]
 * @param {object} [options] - spawn options + `{ onOutput?: (msg, isError) => void }`.
 */
export function exec(cmd, args = "", options = {}) {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    options = args;
    args = "";
  }
  const argv = Array.isArray(args) ? args : String(args).split(" ").filter(Boolean);

  const { onOutput, ...spawnOptions } = options || {};
  const stdio = spawnOptions.stdio ? spawnOptions.stdio : onOutput ? "pipe" : "inherit";
  // On Windows, spawn() without shell:true can't find .cmd/.bat wrappers like
  // npx.cmd. Enable shell mode automatically unless the caller explicitly
  // set shell: false.
  const shell = spawnOptions.shell !== undefined ? spawnOptions.shell : process.platform === "win32";
  const merged = Object.assign({ stdio, shell }, spawnOptions);
  const child = spawn(cmd, argv, /** @type {any} */ (merged));

  if (onOutput && merged.stdio === "pipe") {
    const handler = (data) => {
      const msg = data.toString();
      if (process.stdout?.writable) process.stdout.write(msg);
      onOutput(msg, /\b(error|failed)\b/i.test(msg));
    };
    child.stdout?.on("data", handler);
    child.stderr?.on("data", handler);
  }

  return {
    close: () => !child.killed && child.kill(),
    on: (event, callback) => {
      if (event === "data") {
        if (merged.stdio === "inherit") throw new Error('Cannot listen for "data" events when stdio is set to "inherit".');
        const handler = (data) => {
          const msg = data.toString().trim();
          callback(msg, /\b(error|failed)\b/i.test(msg));
        };
        child.stdout.on("data", handler);
        child.stderr.on("data", handler);
      } else child.on(event, callback);
    },
    end() {
      return new Promise((resolve, reject) => {
        child.on("close", (code) => {
          if (code === 0) resolve(child);
          else reject(new Error(`Command "${cmd} ${Array.isArray(args) ? args.join(" ") : args}" exited with code ${code}`));
        });
      });
    },
  };
}

export { applyTemplate } from "./apply-template.js";
export { generateIcons } from "./icons.js";
export { writeIfChanged } from "./write-if-changed.js";
export { platform };
