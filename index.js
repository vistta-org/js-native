import fs from "@vistta/fs";
import { default as electron } from "electron";
import { spawn } from "node:child_process";

export class Capacitor {
  static async run(config) {
    const target = config.target;
    const appId = config?.app?.id;
    const appName = config?.app?.name || config?.title || "Vistta Example App";
    const mobileScheme = config?.mobile?.scheme || "https";
    if (!appId) throw new Error("Missing app ID in config.app.id");
    try {
      const baseConfig = await import(fs.resolve(process.cwd(), "capacitor.config.json"));
      if (
        baseConfig?.default?.appId !== appId ||
        baseConfig?.default?.appName !== appName ||
        baseConfig?.default?.server?.androidScheme !== mobileScheme
      )
        throw new Error("Capacitor config mismatch");
    } catch {
      await fs.writeFile(
        fs.resolve(process.cwd(), "capacitor.config.json"),
        JSON.stringify(
          {
            appId: appId,
            appName: appName,
            webDir: config.buildDir,
            server: {
              androidScheme: mobileScheme,
            },
          },
          null,
          2,
        ),
      );
    }
    if (!fs.existsSync(fs.resolve(process.cwd(), target))) await Capacitor.exec(["add", target]);
    await Capacitor.exec(["sync", target]);
    await Capacitor.exec(["open", target]);
  }

  static exec(args, options) {
    return new Promise((resolve, reject) => {
      const child = spawn("npx", ["cap", ...args], { stdio: "pipe", shell: true, ...options });
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${args.join(" ")} exited with ${code}`))));
    });
  }
}

export class Electron {
  static async run(config) {
    const args = [fs.resolve(import.meta.dirname, "./electron.js"), config.buildDir];
    const desktopOpts = { ...config?.desktop };
    if (!desktopOpts.title && config?.title) desktopOpts.title = config.title;
    if (Object.keys(desktopOpts).length) args.push("--config", JSON.stringify(desktopOpts));
    if (process.env.NODE_DEBUG === "true" || desktopOpts.devTools) args.push("--debug");
    const child = Electron.exec(args, { stdio: "pipe" });
    child.on("close", (code) => process.exit(code || 0));
    process.on("SIGINT", () => !child.killed && child.kill("SIGINT"));
    process.on("SIGTERM", () => !child.killed && child.kill("SIGTERM"));
  }

  static exec(args, options) {
    return spawn(String(electron), args, options);
  }
}
