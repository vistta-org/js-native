import fs from "@vistta/fs";
import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";

let env;
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
  // written by patchCargoToml. Cargo identifiers forbid dots, so any dev
  // suffix uses a dash (see crateNameSuffix).
  return {
    name: slug + crateNameSuffix(),
    version: pkg.version || "0.1.0",
    description: pkg.description || pkg.name || "",
    author,
    lib: `${sanitizeCrateName(slug)}_lib`,
  };
}

/**
 * Returns the app ID the build is actually targeting. In development (NODE_ENV=development)
 * a `.dev` suffix is appended so the resulting APK installs side-by-side with the
 * release build. Every patch and the build switch itself call this so the source
 * layout under `gen/android/app/src/main/java/<id>/...` always matches the
 * identifier Tauri just generated.
 */
export function resolveAppId(config) {
  const id = config?.app?.id || "org.vistta.app";
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
 * Suffix appended to machine names that Cargo accepts as a valid package
 * identifier. Cargo's `[package].name` only allows letters, digits,
 * `-`, `_`. Use `-` here, not `.`.
 */
export function crateNameSuffix() {
  return process.env.NODE_ENV === "development" ? "-dev" : "";
}

/**
 * Suffix appended to user-facing machine names (productName in
 * tauri.conf.json, app display name) in development builds. Tauri's
 * productName accepts dots, so `.dev` is fine. Ensures the dev install
 * has a distinct name from the release install, so both can coexist on
 * the same machine/device without overwriting each other. Single source
 * of truth — mergeConfig and patchCargoToml both read from here.
 */
export function nameSuffix() {
  return process.env.NODE_ENV === "development" ? ".dev" : "";
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
  // Arrays imply the consumer wants no shell quoting/expansion. Strings keep the
  // legacy shell-mode default for backward compat.
  const shellDefault = !Array.isArray(args);

  if (!env) {
    if (platform() === "win32") {
      const ps = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `
  $machine = [System.Environment]::GetEnvironmentVariables('Machine')
  $user = [System.Environment]::GetEnvironmentVariables('User')

  $result = @{}

  foreach ($k in $machine.Keys) {
    $result[$k] = $machine[$k]
  }

  foreach ($k in $user.Keys) {
    $result[$k] = $user[$k]
  }

  $result | ConvertTo-Json -Compress
        `,
        ],
        { encoding: "utf8" },
      );

      if (ps.status !== 0) env = { ...process.env };
      else env = { ...process.env, ...JSON.parse(ps.stdout) };
    } else env = { ...process.env };
  }
  const { onOutput, ...spawnOptions } = options || {};
  const stdio = spawnOptions.stdio ? spawnOptions.stdio : onOutput ? "pipe" : "inherit";
  const merged = Object.assign({ stdio, shell: shellDefault, env }, spawnOptions);
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

export { generateIcons } from "./icons.js";
export { writeIfChanged } from "./write-if-changed.js";
export { platform };
