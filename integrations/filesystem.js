// Unified filesystem integration for Tauri (all platforms) and web.

/**
 * Read a file.
 * @param {{ path: string, directory?: string, encoding?: string }} options
 * @returns {Promise<{ data: string }>}
 */
export async function readFile(options) {
  if (window.platform === "server") return;
  if (window.platform !== "browser") {
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    return { data: await readTextFile(options.path) };
  }
  if ("showOpenFilePicker" in window) {
    const [handle] = await window.showOpenFilePicker();
    const file = await handle.getFile();
    const text = await file.text();
    return { data: text };
  }
  throw new Error("File System Access API not available in this browser.");
}

/**
 * Write a file.
 * @param {{ path: string, data: string, directory?: string, encoding?: string, recursive?: boolean }} options
 * @returns {Promise<{ uri: string }>}
 */
export async function writeFile(options) {
  if (window.platform === "server") return;
  if (window.platform !== "browser") {
    try {
      const { writeTextFile, mkdir, BaseDirectory } = await import("@tauri-apps/plugin-fs");
      const dir = options.directory
        ? BaseDirectory[options.directory.charAt(0).toUpperCase() + options.directory.slice(1)]
        : undefined;
      if (options.recursive && dir !== undefined) {
        try {
          await mkdir({ path: options.path.split("/").slice(0, -1).join("/"), recursive: true, directory: dir });
        } catch {}
      }
      await writeTextFile({ path: options.path, contents: options.data }, { directory: dir });
      return { uri: options.path };
    } catch {
      /* Do Nothing */
    }
  }

  if (window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({ suggestedName: options.path });
    const writable = await handle.createWritable();
    await writable.write(options.data);
    await writable.close();
    return { uri: handle.name };
  }
  throw new Error("File System Access API not available in this browser.");
}

/**
 * Delete a file.
 * @param {{ path: string, directory?: string }} options
 */
export async function deleteFile(options) {
  if (window.platform === "server") return;
  if (window.platform !== "browser") {
    const { removeFile, BaseDirectory } = await import("@tauri-apps/plugin-fs");
    const dir = options.directory
      ? BaseDirectory[options.directory.charAt(0).toUpperCase() + options.directory.slice(1)]
      : undefined;
    await removeFile({ path: options.path, directory: dir });
    return;
  }
  throw new Error("deleteFile() requires Tauri runtime on desktop.");
}

/**
 * Create a directory.
 * @param {string} path
 * @param {{ directory?: string, recursive?: boolean }} options
 */
export async function mkdir(path, options) {
  if (window.platform === "server") return;
  if (window.platform !== "browser") {
    const { mkdir, BaseDirectory } = await import("@tauri-apps/plugin-fs");
    const dir = options.directory
      ? BaseDirectory[options.directory.charAt(0).toUpperCase() + options.directory.slice(1)]
      : undefined;
    await mkdir(path, { recursive: options.recursive || false, baseDir: dir });
    return;
  }
  throw new Error("mkdir() requires Tauri runtime on desktop.");
}
