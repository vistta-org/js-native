// Unified filesystem integration for Capacitor (app), Electron (desktop), and web.

/**
 * Read a file.
 * @param {{ path: string, directory?: string, encoding?: string }} options
 * @returns {Promise<{ data: string }>}
 */
export async function readFile(options) {
  if (window.platform === "mobile") {
    const { Filesystem } = await import("@capacitor/filesystem");
    return Filesystem.readFile(options);
  }

  if (window.platform === "desktop") {
    // Electron: could use IPC to main process; fallback to File System Access API
    if (window.showOpenFilePicker) {
      const [handle] = await window.showOpenFilePicker();
      const file = await handle.getFile();
      const text = await file.text();
      return { data: text };
    }
    throw new Error("File System Access API not available in this Electron build.");
  }

  // Web fallback using File System Access API
  if (window.showOpenFilePicker) {
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
  if (window.platform === "mobile") {
    const { Filesystem } = await import("@capacitor/filesystem");
    return Filesystem.writeFile(options);
  }

  if (window.platform === "desktop") {
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({ suggestedName: options.path });
      const writable = await handle.createWritable();
      await writable.write(options.data);
      await writable.close();
      return { uri: handle.name };
    }
    throw new Error("File System Access API not available in this Electron build.");
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
  if (window.platform === "mobile") {
    const { Filesystem } = await import("@capacitor/filesystem");
    return Filesystem.deleteFile(options);
  }

  // Desktop / Web: no direct File System Access API for deletion without a handle
  throw new Error("deleteFile() is not supported on desktop/web without a file handle.");
}

/**
 * Create a directory.
 * @param {{ path: string, directory?: string, recursive?: boolean }} options
 */
export async function mkdir(options) {
  if (window.platform === "mobile") {
    const { Filesystem } = await import("@capacitor/filesystem");
    return Filesystem.mkdir(options);
  }

  // Desktop / Web: no direct equivalent in File System Access API
  throw new Error("mkdir() is not supported on desktop/web.");
}
