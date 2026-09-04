/**
 * Cross-platform media recording API. Audio, screen, and camera capture all
 * follow the same contract: a start function resolves with a recording
 * handle — `{ on, stop }` — where `stop()` resolves with `{ blob, stoppedBy }`
 * and `on(event, callback)` subscribes to recording events.
 *
 * Audio additionally supports **silence-aware auto-stop** (`autoStop` option):
 * a voice-activity watcher stops the recording on its own once the user has
 * been quiet for a while, so push-to-talk UX becomes voice-first.
 *
 * Events (`on(event, callback)`):
 * - `"started"` — capture has actually begun (after permission/grant).
 * - `"vad"` — live voice-activity sample `{ rms, speech }` (audio only,
 *   fires ~every 100–200 ms). The tap starts with the recording when
 *   `autoStop` is enabled, or on the first `"vad"` subscription otherwise —
 *   samples only, so consumers can implement their own auto-stop.
 * - `"stopped"` — the recording ended; the payload is the same object
 *   `stop()` resolves with (`{ blob, stoppedBy }`), delivered once before
 *   the stop promise settles. Useful when the caller prefers events over
 *   awaiting `stop()` (auto-stop flows, cleanup handlers).
 *
 * Audio:
 * - **Tauri (Android/iOS/desktop)**: captured via tauri-plugin-audio-recorder
 *   (native capture + standard Tauri IPC; the Android runtime permission is
 *   requested through the plugin). Mobile captures M4A/AAC, desktop WAV —
 *   both are handled server-side by the AIDA /stt ffmpeg transcode. The
 *   finished file is read back as a Blob via the Tauri fs plugin. On Android
 *   live loudness for the VAD comes from the runtime's `VisttaVad` bridge
 *   (a parallel AudioRecord tap — the WebView media stack is bypassed, so
 *   JS cannot tap the recording stream there).
 * - **Browser**: standard `MediaRecorder` pipeline (`getUserMedia`); the
 *   same stream is forked into an `AnalyserNode` for the VAD (multiple
 *   readers per stream are legal, so the recording is untouched).
 *
 * Screen:
 * - **Desktop/browser**: `getDisplayMedia` + `MediaRecorder` (webm). The user
 *   picks the whole screen, a window, or a tab via the platform picker.
 * - **Android**: MediaProjection via the system consent dialog, implemented
 *   natively in `VisttaScreenRecorder.kt` and bridged over Tauri IPC
 *   (`vistta|start_screen_recording` / `vistta|stop_screen_recording`); the
 *   MP4 lands in the app cache dir and is read back via the fs plugin.
 *
 * Camera:
 * - **Android/desktop/browser**: `getUserMedia({ video })` + `MediaRecorder`.
 *   Inside the Android WebView the camera permission request is forwarded by
 *   the system permission dialog (the WebView surfaces getUserMedia requests
 *   for video when the app holds CAMERA and grants are wired).
 *
 * Recording requires a user gesture on most platforms; invoke the start
 * function from a UI event handler.
 */

import {
  requestPermission,
  startRecording as startPluginRecording,
  stopRecording as stopPluginRecording,
} from "tauri-plugin-audio-recorder-api";

/**
 * Silence-aware auto-stop tuning. Passed as the `autoStop` option to
 * override the defaults — `autoStop: true` uses all of them as-is.
 * @typedef {Object} AutoStopOptions
 * @property {number} [trailingSilenceMs=2000] - Silence duration after speech
 *   that triggers the auto-stop.
 * @property {number} [minDurationMs=3000] - Never auto-stop before this
 *   duration (short clips degrade STT quality; <2s can crash audio encoders).
 * @property {number} [initialSpeechTimeoutMs=10000] - Cancel the recording if
 *   no speech is detected within this window (0 = disabled).
 * @property {number} [maxDurationMs=45000] - Hard backstop regardless of VAD
 *   state.
 */

/**
 * Live voice-activity sample delivered to `"vad"` listeners.
 * @typedef {Object} VADEvent
 * @property {number} rms - Sampled RMS (0..1).
 * @property {boolean} speech - Whether the watcher classifies this sample as
 *   speech.
 */

/**
 * @typedef {Object} AudioRecordingOptions
 * @property {boolean|AutoStopOptions} [autoStop=false] - Opt in to
 *   silence-aware auto-stop (`true` = defaults, object = overrides).
 *   Independent of it, the handle emits live `"vad"` samples — the tap runs
 *   from the start when auto-stop is enabled, otherwise it starts on the
 *   first `"vad"` listener (enough to implement a custom auto-stop).
 * @property {string} [deviceId] - Input device id (from the platform device
 *   list) to record from; falls back to the default when unavailable.
 * @property {"low" | "medium" | "high"} [quality="low"] - Native capture
 *   quality (Tauri backend; the browser pipeline ignores this).
 * @property {boolean} [echoCancellation] - Browser capture processing
 *   toggles (Tauri backend ignores these; defaults to the browser's own
 *   processing, i.e. `true` on most platforms).
 * @property {boolean} [noiseSuppression]
 * @property {boolean} [autoGainControl]
 */

/**
 * @typedef {Object} AutoStopConfig
 * @property {AutoStopOptions} autoStop - Normalized auto-stop options.
 * @property {(event: { rms: number, speech: boolean }) => void} [emitVad]
 *   Forward VAD samples to the handle's `"vad"` listeners.
 * @property {(reason: "silence" | "max-duration" | "no-speech") => void} requestStop
 *   Ask the recording to stop automatically with the given reason.
 */

/** @typedef {"user" | "silence" | "max-duration" | "no-speech"} StoppedBy */

/**
 * Recording handle returned by the start functions.
 * @typedef {Object} RecordingHandle
 * @property {(event: "started" | "vad" | "stopped", callback: (...args: any[]) => void) => () => void} on
 *   Subscribe to a recording event; returns an unsubscribe function.
 *   Subscribing to `"vad"` starts the voice-activity tap when auto-stop is
 *   not already running it.
 * @property {() => Promise<{ blob?: Blob, stoppedBy?: StoppedBy }>} stop
 *   Stop the recording; resolves with the blob and the stop reason.
 */

/**
 * Minimal event emitter backing the recording handle. Listeners are keyed
 * by event name; subscribe returns an unsubscribe function.
 */
class RecordingEmitter {
  constructor() {
    /** @type {Map<string, Set<(...args: any[]) => void>>} */
    this.listeners = new Map();
  }

  /**
   * @param {string} event
   * @param {(...args: any[]) => void} callback
   * @returns {() => void} unsubscribe
   */
  on(event, callback) {
    if (typeof callback !== "function") throw new TypeError("callback must be a function");
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(callback);
    return () => {
      set.delete(callback);
    };
  }

  /**
   * @param {string} event
   * @param {...any} args
   */
  emit(event, ...args) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const callback of [...set]) {
      try {
        callback(...args);
      } catch {
        /* consumer listeners must never break the recording */
      }
    }
  }

  /** Drops every listener — called once a recording reaches its terminal state. */
  clear() {
    this.listeners.clear();
  }
}

/**
 * Normalized internal options shared by the recording pipelines. Everything
 * is optional so the screen/camera paths can pass `{}`.
 * @typedef {Object} ResolvedOptions
 * @property {AutoStopConfig["autoStop"]} [autoStop]
 * @property {string} [deviceId]
 * @property {"low" | "medium" | "high"} [quality]
 * @property {{ echoCancellation?: boolean, noiseSuppression?: boolean, autoGainControl?: boolean }} [capture]
 */

/**
 * Normalizes user-provided recording options: auto-stop thresholds against
 * the documented defaults, capture options against backend-supported values.
 * @param {AudioRecordingOptions|undefined} options
 * @returns {ResolvedOptions}
 */
function resolveRecordingOptions(options) {
  const o = options || {};
  return {
    autoStop: resolveAutoStopOptions(o.autoStop),
    deviceId: typeof o.deviceId === "string" && o.deviceId ? o.deviceId : undefined,
    quality: o.quality === "medium" || o.quality === "high" ? o.quality : "low",
    capture: {
      echoCancellation: typeof o.echoCancellation === "boolean" ? o.echoCancellation : undefined,
      noiseSuppression: typeof o.noiseSuppression === "boolean" ? o.noiseSuppression : undefined,
      autoGainControl: typeof o.autoGainControl === "boolean" ? o.autoGainControl : undefined,
    },
  };
}

function clampMs(value, fallback, min) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.round(n);
}

/**
 * Normalizes the `autoStop` option: absent/`false` disables (returns
 * `undefined`), `true` enables with the documented defaults, an object
 * enables with overrides (kept separate so `resolveRecordingOptions` stays
 * flat).
 * @param {boolean|AutoStopOptions|undefined} input
 * @returns {AutoStopConfig["autoStop"] | undefined}
 */
function resolveAutoStopOptions(input) {
  if (!input) return undefined;
  const o = input === true ? {} : input;
  return {
    trailingSilenceMs: clampMs(o.trailingSilenceMs, 2000, 100),
    minDurationMs: clampMs(o.minDurationMs, 3000, 0),
    initialSpeechTimeoutMs: clampMs(o.initialSpeechTimeoutMs, 10000, 0),
    maxDurationMs: clampMs(o.maxDurationMs, 45000, 0),
  };
}

/**
 * Watcher config for a samples-only tap (no auto-stop): voice-activity
 * classification with every auto-stop timer disabled, so the watcher never
 * settles and samples keep flowing — the consumer drives any custom stop.
 * @type {AutoStopOptions}
 */
const VAD_ONLY = {
  trailingSilenceMs: Number.MAX_SAFE_INTEGER,
  minDurationMs: 0,
  initialSpeechTimeoutMs: 0,
  maxDurationMs: 0,
};

/**
 * Shared silence/voice-activity watcher. Owns the timing state machine
 * (min-duration floor → trailing-silence window → max-duration backstop,
 * plus the optional initial-speech timeout) and calls `requestStop` with the
 * reason once; the recording backend feeds it audio levels and the manual
 * stop path cancels it. Platform-agnostic — the web path feeds RMS values
 * from an AnalyserNode, the Android path from the VisttaVad bridge. Every
 * sample and speech-state transition is forwarded via `emitVad` (so `"vad"`
 * listeners work even when auto-stop itself is disabled).
 */
class SilenceWatcher {
  /**
   * @param {AutoStopConfig["autoStop"]} options
   * @param {AutoStopConfig["requestStop"]} requestStop
   * @param {(event: { rms: number, speech: boolean }) => void} [emitVad]
   * @param {() => number} now
   */
  constructor(options, requestStop, emitVad, now = () => performance.now()) {
    this.options = options;
    this.requestStop = requestStop;
    this.emitVad = emitVad;
    this.now = now;
    this.startedAt = now();
    this.speechDetected = false;
    this.speechStartedAt = 0;
    this.silenceSince = 0;
    // Rolling noise floor (adaptive threshold): long-term quiet level.
    this.noiseFloor = 0.02;
    // Hysteresis: speech must rise above the floor by a margin, silence is
    // only registered below the floor itself.
    this.speechRiseFactor = 1.6;
    this.speechAbsMin = 0.045;
    this.settled = false;
  }

  /**
   * Feed one audio level (RMS, 0..1). Call at a regular cadence.
   * @param {number} rms
   */
  feed(rms) {
    if (this.settled) return;
    const t = this.now();
    // Hard backstop — fires regardless of VAD state (continuous speech
    // included), before any other transition is considered.
    if (this.options.maxDurationMs > 0 && t - this.startedAt >= this.options.maxDurationMs) {
      this.finish("max-duration");
      return;
    }
    const silenceThreshold = Math.max(this.noiseFloor * 1.15, 0.012);
    const speechThreshold = Math.max(this.noiseFloor * this.speechRiseFactor, this.speechAbsMin);

    // Track the noise floor while quiet (slow attack so a brief breath
    // doesn't drag it up).
    if (rms < silenceThreshold) {
      this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
    }

    if (rms >= speechThreshold) {
      if (!this.speechDetected) {
        this.speechDetected = true;
        this.speechStartedAt = t;
      }
      this.silenceSince = 0;
      this.emit(rms, true);
      return;
    }

    // Below the speech threshold.
    if (this.speechDetected) {
      if (this.silenceSince === 0) this.silenceSince = t;
      this.emit(rms, false);
      if (
        t - this.speechStartedAt >= this.options.minDurationMs &&
        t - this.silenceSince >= this.options.trailingSilenceMs
      ) {
        this.finish("silence");
      }
      return;
    }

    // No speech yet.
    this.emit(rms, false);
    const timeout = this.options.initialSpeechTimeoutMs;
    if (timeout > 0 && t - this.startedAt >= timeout) this.finish("no-speech");
  }

  /**
   * Forwards one sample to the `"vad"` listeners, if any.
   * @param {number} rms
   * @param {boolean} speech
   */
  emit(rms, speech) {
    if (!this.emitVad) return;
    try {
      this.emitVad({ rms, speech });
    } catch {
      /* consumer listeners must never break the watcher */
    }
  }

  /** @param {"silence" | "max-duration" | "no-speech"} reason */
  finish(reason) {
    if (this.settled) return;
    this.settled = true;
    this.requestStop(reason);
  }
}

let nextId = 0;

function isTauri() {
  // @ts-ignore — injected by the Tauri webview at runtime.
  return typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
}

function isAndroid() {
  // @ts-ignore — window.platform is set by the runtime.
  return typeof window !== "undefined" && window.platform === "mobile";
}

/**
 * Starts recording audio from the microphone.
 *
 * ```js
 * const recording = await startAudioRecording({
 *   autoStop: { trailingSilenceMs: 2000 }, // silence-aware auto-stop (true = defaults)
 *   deviceId: "...", // input device id (desktop)
 *   quality: "low", // native capture quality (Tauri)
 *   echoCancellation: true, // browser capture processing
 *   noiseSuppression: true,
 *   autoGainControl: true,
 * });
 *
 * recording.on("started", () => {}); // capture has begun
 * recording.on("vad", ({ rms, speech }) => {}); // live voice-activity feedback
 * const { blob, stoppedBy } = await recording.stop();
 * ```
 *
 * @param {AudioRecordingOptions} [options] - Capture + VAD options.
 * @returns {Promise<RecordingHandle>} A recording handle. Rejects on failure
 *   or permission denial.
 */
export function startAudioRecording(options) {
  const opts = resolveRecordingOptions(options);
  if (isTauri()) return startNativeAudio(opts);
  return startWebRecording(
    {
      audio: {
        ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
        ...(opts.capture.echoCancellation !== undefined ? { echoCancellation: opts.capture.echoCancellation } : {}),
        ...(opts.capture.noiseSuppression !== undefined ? { noiseSuppression: opts.capture.noiseSuppression } : {}),
        ...(opts.capture.autoGainControl !== undefined ? { autoGainControl: opts.capture.autoGainControl } : {}),
      },
    },
    opts,
  );
}

/**
 * Records the device/screen. On desktop and browser this opens
 * `getDisplayMedia` (the user picks a screen, window, or tab); on Android a
 * system consent dialog appears (MediaProjection).
 *
 * @returns {Promise<RecordingHandle>} A recording handle; `stop()` resolves
 * with `{ blob }` (webm on desktop/browser, mp4 on Android). Rejects on
 * failure, denial, or if the platform does not support screen capture.
 */
export function startScreenRecording() {
  if (isTauri() && isAndroid()) return startNativeScreen();
  return startDisplayRecording();
}

/**
 * Records the device camera.
 *
 * @returns {Promise<RecordingHandle>} A recording handle; `stop()` resolves
 * with `{ blob }` (webm/mp4). Rejects on failure or permission denial.
 */
export function startCameraRecording() {
  return startWebRecording({ video: { facingMode: "user" }, audio: false }, {});
}

/**
 * Captures the display via getDisplayMedia + MediaRecorder (desktop/browser).
 * @returns {Promise<RecordingHandle>}
 */
async function startDisplayRecording() {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("Screen recording is not supported on this device.");
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  return recordStream(stream, {});
}

/**
 * Core web pipeline shared by audio, screen, and camera capture:
 * getUserMedia + MediaRecorder, resolving a recording handle.
 * @param {MediaStreamConstraints} constraints
 * @param {ResolvedOptions} [opts]
 * @returns {Promise<RecordingHandle>}
 */
async function startWebRecording(constraints, opts = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Recording is not supported on this device.");
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  return recordStream(stream, opts);
}

/**
 * MediaRecorder over an acquired stream. Shared by all web capture paths.
 * When auto-stop is enabled (`autoStop`), the same stream is forked into a
 * Web Audio AnalyserNode (a parallel tap — multiple readers per stream are
 * legal) and RMS is sampled every ~200 ms to drive silence-aware auto-stop;
 * otherwise the tap starts lazily on the first `"vad"` subscription
 * (samples only, audio streams only).
 * @param {MediaStream} stream
 * @param {ResolvedOptions} opts
 * @returns {RecordingHandle} recording handle
 */
function recordStream(stream, opts = {}) {
  const emitter = new RecordingEmitter();
  const chunks = [];
  const recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (event) => event.data.size > 0 && chunks.push(event.data);

  /** @type {StoppedBy} */
  let stoppedBy = "user";
  let stopping = false;
  let onStopResolve;
  let onStopReject;
  const stopped = new Promise((resolve, reject) => {
    onStopResolve = resolve;
    onStopReject = reject;
  });

  recorder.onstop = () => {
    stream.getTracks().forEach((track) => track.stop());
    if (chunks.length === 0) {
      emitter.emit("stopped", { error: new Error("No media was captured.") });
      emitter.clear();
      return onStopReject(new Error("No media was captured."));
    }
    const type = chunks[0]?.type?.split(";")[0];
    const result = { blob: new Blob(chunks, { type }), stoppedBy };
    emitter.emit("stopped", result);
    emitter.clear();
    onStopResolve(result);
  };

  recorder.onerror = () => {
    stream.getTracks().forEach((track) => track.stop());
    teardownVad();
    emitter.clear();
    onStopReject(new Error("Recording failed."));
  };

  recorder.start(500);
  emitter.emit("started");

  // Voice-activity tap (audio only, opt-in): fork the stream into an
  // analyser and feed RMS to the shared watcher. The recording itself is
  // untouched. Starts with the recording when auto-stop is enabled, or
  // lazily on the first "vad" subscription (samples only — consumers can
  // implement their own auto-stop from them; the tap runs until stop()).
  let teardownVad = () => {};
  let vadRunning = false;
  const startVad = () => {
    if (vadRunning || stopping || recorder.state === "inactive") return;
    if (!stream.getAudioTracks().length) return; // video-only streams have no voice activity
    vadRunning = true;
    const watcher = new SilenceWatcher(
      opts.autoStop || VAD_ONLY,
      opts.autoStop
        ? (reason) => {
            stopping = true;
            stoppedBy = reason;
            if (recorder.state !== "inactive") recorder.stop();
          }
        : () => {},
      (event) => emitter.emit("vad", event),
    );
    teardownVad = attachWebVad(stream, watcher);
  };
  if (opts.autoStop) startVad();

  return {
    on: (event, callback) => {
      const unsubscribe = emitter.on(event, callback);
      if (event === "vad") startVad();
      return unsubscribe;
    },
    stop: () => {
      teardownVad();
      if (recorder.state !== "inactive" && !stopping) {
        stopping = true;
        stoppedBy = "user";
        recorder.stop();
      }
      return stopped;
    },
  };
}

/**
 * Forks `stream` into an AudioContext/AnalyserNode tap and samples RMS every
 * ~200 ms, feeding the given watcher. Returns a teardown function that
 * stops the sampling loop and closes the audio context.
 * @param {MediaStream} stream
 * @param {SilenceWatcher} watcher
 * @returns {() => void} teardown
 */
function attachWebVad(stream, watcher) {
  const Ctx = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
  const context = new Ctx();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let timer = 0;
  let disposed = false;
  const sample = () => {
    if (disposed) return;
    try {
      analyser.getFloatTimeDomainData(buf);
    } catch {
      return teardown();
    }
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    watcher.feed(Math.sqrt(sum / buf.length));
  };
  const teardown = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    try {
      source.disconnect();
    } catch {
      /* source may already be disconnected */
    }
    context.close?.().catch?.(() => {});
  };
  timer = /** @type {any} */ (setInterval(sample, 200));
  return teardown;
}

// ── Native backends (Tauri webview) ──────────────────────────────

/**
 * Records audio via tauri-plugin-audio-recorder (native capture + Tauri IPC).
 * Applies the backend-supported options (quality, deviceId); live loudness
 * for the VAD comes from the `VisttaVad` bridge (Android) or a parallel
 * getUserMedia tap (desktop Tauri).
 * @param {ReturnType<typeof resolveRecordingOptions>} opts
 * @returns {Promise<RecordingHandle>}
 */
async function startNativeAudio(opts) {
  const { granted } = await requestPermission();
  if (!granted) throw new Error("Microphone access was denied.");
  const id = `vistta-audio-${++nextId}-${Date.now().toString(36)}`;
  // Output path (no extension — the plugin appends .wav/.m4a by platform)
  // inside the app cache dir.
  // @ts-ignore — Tauri path API only exists inside a Tauri webview.
  const { cacheDir, join } = await import("@tauri-apps/api/path");
  const base = await join(await cacheDir(), id);
  await startPluginRecording({
    outputPath: base,
    quality: opts.quality,
    ...(opts.deviceId ? { deviceId: opts.deviceId } : {}),
  });
  return nativeRecordingHandle(opts);
}

/**
 * Builds the recording handle for the native audio path, wiring the VAD
 * watcher (VisttaVad bridge on Android, parallel getUserMedia tap on
 * desktop Tauri) and the started/vad/stopped events.
 * @param {ReturnType<typeof resolveRecordingOptions>} opts
 * @returns {RecordingHandle}
 */
function nativeRecordingHandle(opts) {
  const emitter = new RecordingEmitter();
  emitter.emit("started");

  /** @type {StoppedBy} */
  let stoppedBy = "user";
  let stopping = null;

  /** @type {{ stop: () => void } | null} */
  let vad = null;
  let vadRunning = false;

  const doStop = () => {
    if (!stopping) {
      stopping = (async () => {
        // Stop the VAD tap first so no further auto-stop can race teardown.
        vad?.stop();
        try {
          const { filePath } = await stopPluginRecording();
          const result = { blob: await nativeAudioBlob(filePath), stoppedBy };
          emitter.emit("stopped", result);
          return result;
        } finally {
          // Terminal either way — release consumer listeners (e.g. "vad").
          emitter.clear();
        }
      })();
    }
    return stopping;
  };

  // VAD tap: starts with the recording when auto-stop is enabled, or lazily
  // on the first "vad" subscription (samples only — consumers can implement
  // their own auto-stop from them; the tap runs until stop()).
  const startVad = () => {
    if (vadRunning || stopping) return;
    vadRunning = true;
    const requestStop = opts.autoStop
      ? (reason) => {
          // The auto path records its reason first, then finalises via
          // doStop; a manual stop afterwards sees `stopping` set and reuses
          // the result.
          if (stopping) return;
          stoppedBy = reason;
          void doStop();
        }
      : () => {};
    vad = attachNativeVad(opts.autoStop || VAD_ONLY, requestStop, (event) => emitter.emit("vad", event));
  };
  if (opts.autoStop) startVad();

  return {
    on: (event, callback) => {
      const unsubscribe = emitter.on(event, callback);
      if (event === "vad") startVad();
      return unsubscribe;
    },
    stop: () => {
      if (!stopping) stoppedBy = "user";
      return doStop();
    },
  };
}

/** Reads the finished native recording file back as a Blob. */
async function nativeAudioBlob(filePath) {
  // @ts-ignore — Tauri fs API only exists inside a Tauri webview.
  const { readFile } = await import("@tauri-apps/plugin-fs");
  const data = await readFile(filePath);
  const ext = filePath.split(".").pop()?.toLowerCase();
  return new Blob([data], { type: ext === "wav" ? "audio/wav" : "audio/mp4" });
}

/**
 * Wires a live-audio tap into the shared SilenceWatcher for the native
 * (Tauri) path. Android uses the `VisttaVad` bridge (a parallel AudioRecord
 * tap — the WebView media stack is bypassed there). Desktop Tauri has no
 * bridge: the plugin writes to disk, so a parallel `getUserMedia` stream is
 * opened and fed to the web AnalyserNode tap instead; if the webview denies
 * the extra capture the tap yields no samples (manual stop still works).
 * @param {AutoStopConfig["autoStop"]} autoStop - Watcher options (`VAD_ONLY`
 *   for a samples-only tap).
 * @param {(reason: "silence" | "max-duration" | "no-speech") => void} requestStop
 * @param {(event: { rms: number, speech: boolean }) => void} emitVad
 * @returns {{ stop: () => void } | null}
 */
function attachNativeVad(autoStop, requestStop, emitVad) {
  const bridge = typeof window !== "undefined" ? /** @type {any} */ (window).VisttaVad : null;
  if (bridge && typeof bridge.start === "function") {
    const watcher = new SilenceWatcher(autoStop, requestStop, emitVad);
    bridge.start((rms) => watcher.feed(Number(rms) || 0));
    return { stop: () => bridge.stop() };
  }
  // Desktop Tauri fallback: parallel getUserMedia tap feeding the web VAD.
  let stopped = false;
  /** @type {(() => void) | null} */
  let teardown = null;
  navigator.mediaDevices
    ?.getUserMedia({ audio: true })
    .then((stream) => {
      if (stopped) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      teardown = attachWebVad(stream, new SilenceWatcher(autoStop, requestStop, emitVad));
    })
    .catch(() => {
      /* extra capture denied — silence auto-stop unavailable, manual stop still works */
    });
  return {
    stop: () => {
      stopped = true;
      teardown?.();
    },
  };
}

/**
 * Records the screen on Android via MediaProjection (native). The system
 * consent dialog is shown by the runtime's `VisttaScreenRecorder`; the
 * resulting MP4 lands in the app cache dir and is read back as a Blob.
 * @returns {Promise<RecordingHandle>}
 */
async function startNativeScreen() {
  // @ts-ignore — Tauri invoke only exists inside a Tauri webview.
  const { invoke } = await import("@tauri-apps/api/core");
  const emitter = new RecordingEmitter();
  const id = `vistta-screen-${++nextId}-${Date.now().toString(36)}`;
  // @ts-ignore — Tauri path API only exists inside a Tauri webview.
  const { cacheDir, join } = await import("@tauri-apps/api/path");
  const filePath = await join(await cacheDir(), `${id}.mp4`);
  await invoke("vistta|start_screen_recording", { id, filePath });
  emitter.emit("started");
  let stopping = null;
  return {
    on: (event, callback) => emitter.on(event, callback),
    stop: () => {
      if (!stopping) {
        stopping = (async () => {
          await invoke("vistta|stop_screen_recording", { id });
          // @ts-ignore — Tauri fs API only exists in a Tauri webview.
          const { readFile } = await import("@tauri-apps/plugin-fs");
          const data = await readFile(filePath);
          const result = { blob: new Blob([data], { type: "video/mp4" }), stoppedBy: "user" };
          emitter.emit("stopped", result);
          emitter.clear();
          return result;
        })();
      }
      return stopping;
    },
  };
}
