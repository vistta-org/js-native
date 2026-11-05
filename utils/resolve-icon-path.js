import fs from "@vistta/fs";

export function resolveIconPath(config) {
  if (!config?.icon || !config?.buildDir) return null;
  const icon = String(config.icon);
  const bundledPath = fs.resolve(config.buildDir, "www", icon.replace(/^\/+/, ""));
  if (fs.existsSync(bundledPath)) return bundledPath;
  if (fs.isAbsolute(icon) && fs.existsSync(icon)) return icon;
  throw new Error(`Icon "${icon}" not found in "${fs.resolve(config.buildDir, "www")}" or at an absolute filesystem path.`);
}
