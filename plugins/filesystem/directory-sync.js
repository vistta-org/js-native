import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { watch } from "@tauri-apps/plugin-fs";

const COMMAND = "plugin:directory-sync|";
const MAX_PAGE_SIZE = 256;
const MAX_CHUNK_SIZE = 1024 * 1024;
const DEFAULT_POLL_INTERVAL = 30_000;

/**
 * True when Android refused a directory operation because the app is in the background without a
 * running foreground service.
 * @param {unknown} error
 */
export function isBackgroundUnavailable(error) {
  return /** @type {any} */ (error)?.code === "background-unavailable";
}

export async function probeDirectorySync(root) {
  requireRoot(root);
  if (!isTauri()) return unsupported("native-runtime-required");
  try {
    return await command("probe_root", { root });
  } catch (error) {
    return { ...unsupported("directory-access-unavailable"), detail: errorMessage(error) };
  }
}

export async function selectSyncDirectory() {
  if (!isTauri()) return null;
  if (isMobile()) {
    const selection = await command("select_root");
    return selection?.cancelled ? null : { path: selection.root, capabilities: selection };
  }

  const root = await open({ directory: true, recursive: true, multiple: false });
  if (!root) return null;
  return { path: root, capabilities: await requireSupportedRoot(root) };
}

/**
 * @param {string} root
 * @param {{ pageSize?: number, generation?: string, signal?: AbortSignal }} [options]
 */
export async function* scanSyncDirectory(root, { pageSize = MAX_PAGE_SIZE, generation = crypto.randomUUID(), signal } = {}) {
  requireRoot(root);
  requirePageSize(pageSize);
  requireOperationId(generation, "Scan generation");
  throwIfAborted(signal);

  const removeAbort = bindCancellation(signal, generation);
  try {
    await command("start_scan", { root, generation });
    let after = 0;
    while (true) {
      throwIfAborted(signal);
      const page = await command("next_scan_page", { generation, after, limit: pageSize });
      if (page.generation !== generation || page.count !== after + page.entries.length)
        throw new Error("Native scan returned a non-contiguous page");
      yield page;
      if (page.complete) return;
      after = page.count;
    }
  } finally {
    removeAbort();
  }
}

/**
 * @param {string} root
 * @param {string} relativePath
 * @param {{ operationId?: string, signal?: AbortSignal }} [options]
 */
export async function hashSyncFile(root, relativePath, { operationId = crypto.randomUUID(), signal } = {}) {
  requireRoot(root);
  requireRelativePath(relativePath);
  requireOperationId(operationId, "Hash operation id");
  throwIfAborted(signal);
  const removeAbort = bindCancellation(signal, operationId);
  try {
    return await command("hash_file", { root, relativePath, operationId });
  } finally {
    removeAbort();
  }
}

/**
 * @typedef {{ size: number, modified: string | null, identity: string | null }} FileFingerprint
 *
 * @param {string} root
 * @param {string} relativePath
 * @param {{ fingerprint?: FileFingerprint, signal?: AbortSignal }} [options]
 */
export async function* readSyncFileChunks(root, relativePath, { fingerprint, signal } = {}) {
  requireRoot(root);
  requireRelativePath(relativePath);
  const leaseId = crypto.randomUUID();
  if (isMobile()) await beginDirectorySyncLease(leaseId);
  try {
    const source = await hashSyncFile(root, relativePath, { signal });
    if (fingerprint && !sameFingerprint(source.fingerprint, fingerprint)) throw new Error("File changed before read");
    const expected = source.fingerprint;
    let offset = 0;
    while (true) {
      throwIfAborted(signal);
      const chunk = await command("read_file_chunk", {
        root,
        relativePath,
        offset,
        limit: MAX_CHUNK_SIZE,
        expected,
      });
      if (chunk.offset !== offset || chunk.nextOffset < offset)
        throw new Error("Native file read returned an invalid offset");
      yield decodeBase64(chunk.data);
      if (chunk.complete) break;
      if (chunk.nextOffset === offset) throw new Error("Native file read made no progress");
      offset = chunk.nextOffset;
    }
    const verified = await hashSyncFile(root, relativePath, { signal });
    if (verified.sha256 !== source.sha256 || !sameFingerprint(verified.fingerprint, source.fingerprint))
      throw new Error("File changed during read");
  } finally {
    if (isMobile()) await endDirectorySyncLease(leaseId).catch(() => {});
  }
}

export async function beginDirectorySyncLease(operationId) {
  requireOperationId(operationId, "Operation id");
  return command("begin_lease", { operationId });
}

export async function endDirectorySyncLease(operationId) {
  requireOperationId(operationId, "Operation id");
  return command("end_lease", { operationId });
}

/**
 * @param {string} root
 * @param {string} relativePath
 * @param {{ expected?: FileFingerprint | null }} [options]
 */
export async function beginSyncFileWrite(root, relativePath, { expected = null } = {}) {
  requireRoot(root);
  requireRelativePath(relativePath);
  return command("begin_write", { root, relativePath, expected });
}

export async function writeSyncFileChunk(id, bytes) {
  requireOperationId(id, "Write operation id");
  if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > MAX_CHUNK_SIZE)
    throw new TypeError(`Write chunks must be Uint8Array values between 1 and ${MAX_CHUNK_SIZE} bytes`);
  return command("write_chunk", { id, data: encodeBase64(bytes) });
}

export async function commitSyncFileWrite(id, sha256) {
  requireOperationId(id, "Write operation id");
  if (typeof sha256 !== "string" || !/^[a-f\d]{64}$/i.test(sha256)) throw new TypeError("A SHA-256 digest is required");
  return command("commit_write", { id, sha256 });
}

export async function abortSyncFileWrite(id) {
  requireOperationId(id, "Write operation id");
  const result = await command("abort_write", { id });
  return result === true || result?.aborted === true;
}

/**
 * @param {string} root
 * @param {string} relativePath
 * @param {Iterable<Uint8Array> | AsyncIterable<Uint8Array>} chunks
 * @param {{ expected?: FileFingerprint | null, sha256?: string, signal?: AbortSignal }} [options]
 */
export async function replaceSyncFile(root, relativePath, chunks, { expected = null, sha256, signal } = {}) {
  if (!chunks?.[Symbol.asyncIterator] && !chunks?.[Symbol.iterator]) throw new TypeError("File chunks must be iterable");
  const { id } = await beginSyncFileWrite(root, relativePath, { expected });
  try {
    for await (const chunk of chunks) {
      throwIfAborted(signal);
      await writeSyncFileChunk(id, chunk);
    }
    throwIfAborted(signal);
    return await commitSyncFileWrite(id, sha256);
  } catch (error) {
    await abortSyncFileWrite(id).catch(() => {});
    throw error;
  }
}

export async function recoverSyncDirectory(root) {
  requireRoot(root);
  return command("recover_root", { root });
}

export async function cancelDirectorySyncOperation(operationId) {
  requireOperationId(operationId, "Operation id");
  const result = await command("cancel_operation", { operationId });
  return result === true || result?.cancelled === true;
}

/**
 * @param {string} root
 * @param {(change: { source: string, event: unknown, authoritative: boolean }) => void} callback
 * @param {{ pollInterval?: number, signal?: AbortSignal }} [options]
 */
export async function watchSyncDirectory(root, callback, { pollInterval = DEFAULT_POLL_INTERVAL, signal } = {}) {
  requireRoot(root);
  if (typeof callback !== "function") throw new TypeError("A directory change callback is required");
  if (!Number.isSafeInteger(pollInterval) || pollInterval < 1_000)
    throw new TypeError("Poll interval must be at least 1000ms");
  throwIfAborted(signal);

  let stopped = false;
  let unwatch = null;
  const notify = (source, event = null) => {
    if (!stopped) callback({ source, event, authoritative: false });
  };
  if (!isMobile()) {
    try {
      unwatch = await watch(root, (event) => notify("watch", event), { recursive: true, delayMs: 500 });
    } catch (error) {
      notify("watch-error", { message: errorMessage(error) });
    }
  }

  const timer = setInterval(() => notify("poll"), pollInterval);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    unwatch?.();
    signal?.removeEventListener("abort", stop);
  };
  signal?.addEventListener("abort", stop, { once: true });
  return stop;
}

async function requireSupportedRoot(root) {
  const capabilities = await probeDirectorySync(root);
  if (!capabilities.supported)
    throw new Error(capabilities.detail || capabilities.reason || "Directory access is unavailable");
  return capabilities;
}

function command(name, args = {}) {
  if (!isTauri()) return Promise.reject(new Error("Directory sync requires the native runtime"));
  return invoke(`${COMMAND}${name}`, args);
}

function bindCancellation(signal, operationId) {
  if (!signal) return () => {};
  const cancel = () => void cancelDirectorySyncOperation(operationId).catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  return () => signal.removeEventListener("abort", cancel);
}

function unsupported(reason) {
  return {
    directoryMetadata: false,
    scopedSelection: false,
    persistedGrant: false,
    streamingRead: false,
    streamingWrite: false,
    hashing: false,
    sourceRevalidation: false,
    recoverableReplacement: false,
    atomicReplacement: false,
    durableReplacement: false,
    cancellation: false,
    foregroundLifecycle: false,
    watch: false,
    stableIdentity: false,
    supported: false,
    reason,
  };
}

function requireRoot(root) {
  if (typeof root !== "string" || !root.trim()) throw new TypeError("Directory root is required");
}

function requireRelativePath(path) {
  if (
    typeof path !== "string" ||
    !path ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === ".." || /[\\:\0]/.test(part))
  )
    throw new TypeError("A root-relative file path is required");
}

function requireOperationId(value, name) {
  if (typeof value !== "string" || !value) throw new TypeError(`${name} is required`);
}

function requirePageSize(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE)
    throw new TypeError(`Scan page size must be between 1 and ${MAX_PAGE_SIZE}`);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Operation was aborted", "AbortError");
}

function isMobile() {
  return typeof window !== "undefined" && "platform" in window && window.platform === "mobile";
}

function decodeBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64(value) {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000)
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sameFingerprint(left, right) {
  return left?.size === right?.size && left?.modified === right?.modified && left?.identity === right?.identity;
}
