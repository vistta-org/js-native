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
  return {
    name: slug,
    version: pkg.version || "0.1.0",
    description: pkg.description || pkg.name || "",
    author,
    // Suffix `_lib` so the auto-derived binary (`<name>`) and the lib target have
    // distinct filenames; without this Windows emits an output-collision warning
    // and the build can fail when both `src/main.rs` and `src/lib.rs` are present.
    lib: `${sanitizeCrateName(slug)}_lib`,
  };
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
  const merged = Object.assign({ stdio: onOutput ? "pipe" : "pipe", shell: shellDefault, env }, spawnOptions);
  const child = spawn(cmd, argv, /** @type {any} */ (merged));

  if (onOutput && merged.stdio === "pipe") {
    const handler = (data) => {
      const msg = data.toString();
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
