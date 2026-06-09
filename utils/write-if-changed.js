import fs from "@vistta/fs";

/**
 * Writes `data` to `path` only when its current contents differ. Avoids touching
 * mtime so Cargo / Gradle / Tauri's dev-watcher don't trigger spurious rebuilds.
 * @param {string} path
 * @param {string|Buffer} data
 * @returns {Promise<boolean>} true if a write happened.
 */
export async function writeIfChanged(path, data) {
  try {
    const existing = await fs.readFile(path);
    const next = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (existing.equals(next)) return false;
  } catch {
    // missing or unreadable — fall through to write.
  }
  await fs.writeFile(path, data);
  return true;
}
