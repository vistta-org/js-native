import fs from "@vistta/fs";
import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";

let env;

export async function getInfo(config) {
  const pkg = await import(fs.resolve(process.cwd(), "package.json")).catch(() => ({}));
  const name = config?.app?.name || pkg.name || config?.title || "Vistta App";
  return {
    name: name.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase(),
    version: pkg.version || "0.1.0",
    description: pkg.description || pkg.name || "",
    author: pkg.author || "unknown",
    lib: name
      .replace(/[^a-zA-Z0-9-_]/g, "-")
      .toLowerCase()
      .replace(/-/g, "_"),
  };
}

export function exec(cmd, args = "", options = {}) {
  if (typeof args === "object") {
    options = args;
    args = "";
  }

  if (!env)
    env =
      platform() === "win32"
        ? () => {
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

            if (ps.status !== 0) throw new Error(ps.stderr);

            return { ...process.env, ...JSON.parse(ps.stdout) };
          }
        : { ...process.env };
  options = Object.assign({ stdio: "pipe", shell: true, env }, options);
  const child = spawn(cmd, args.split(" "), /** @type {any} */ (options));
  return {
    close: () => !child.killed && child.kill(),
    on: (event, callback) => {
      if (event === "data") {
        if (options.stdio === "inherit") throw new Error('Cannot listen for "data" events when stdio is set to "inherit".');
        const handler = (data) => {
          const msg = data.toString().trim();
          callback(msg, /error|failed|Error|FAILED/i.test(msg));
        };
        child.stdout.on("data", handler);
        child.stderr.on("data", handler);
      } else child.on(event, callback);
    },
    end() {
      return new Promise((resolve, reject) => {
        child.on("close", (code) => {
          if (code === 0) resolve(child);
          else reject(`Command "${cmd} ${args}" exited with code ${code}`);
        });
      });
    },
  };
}

export { generateIcons } from "./icons.js";
export { platform };
