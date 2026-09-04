// Android voice-activity tap for silence-aware auto-stop (Phase 5).
//
// The audio recording itself runs through tauri-plugin-audio-recorder, whose
// WebView-facing API only reports `{ state, durationMs }` — JS cannot see
// live audio there (the WebView media stack is bypassed; M4A isn't parseable
// until finalised). This object runs a parallel lightweight AudioRecord
// (same app UID — concurrent capture is permitted) and evaluates RMS values
// into the webview via a JavascriptInterface callback so the JS side can run
// its shared SilenceWatcher unchanged.
//
// JS contract (see packages/js-runtime/plugins/recorder.js):
//   window.VisttaVad.start(callback(rms)) — begins sampling; `callback` is
//     invoked on a background thread with a 0..1 RMS value every ~100 ms.
//   window.VisttaVad.stop() — releases the AudioRecord.
//
// The tap emits nothing while idle (no recording session is active unless
// JS calls start); stopping releases the mic buffer immediately.

package org.vistta.runtime

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface

object VisttaVad {

    private const val TAG = "VisttaVad"
    private const val SAMPLE_RATE = 16_000
    private const val SAMPLE_INTERVAL_MS = 100

    private val mainHandler = Handler(Looper.getMainLooper())

    @Volatile
    private var thread: Thread? = null

    @Volatile
    private var callback: Any? = null

    /**
     * Starts the RMS tap. `callback` is a JS function value passed from the
     * webview; it is invoked with a single numeric argument (0..1 RMS).
     * A new start while active releases the previous tap first.
     */
    @SuppressLint("MissingPermission")
    @android.webkit.JavascriptInterface
    fun start(callback: Any?) {
        stop()
        if (callback == null) return
        this.callback = callback
        val minBuf =
            AudioRecord.getMinBufferSize(
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
            )
        if (minBuf <= 0) {
            Log.w(TAG, "AudioRecord unavailable (minBufferSize=$minBuf)")
            return
        }
        val record =
            try {
                @Suppress("MissingPermission")
                AudioRecord(
                    MediaRecorder.AudioSource.MIC,
                    SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    maxOf(minBuf, SAMPLE_RATE), // ≥ 1 s of buffer headroom
                )
            } catch (t: Throwable) {
                Log.w(TAG, "Failed to open AudioRecord: ${t.message}")
                return
            }
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            Log.w(TAG, "AudioRecord not initialized")
            record.release()
            return
        }
        val chunk = ShortArray(SAMPLE_RATE * SAMPLE_INTERVAL_MS / 1000) // ~100 ms of samples
        val worker = Thread {
            try {
                record.startRecording()
                while (!Thread.currentThread().isInterrupted && this.callback === callback) {
                    val read = record.read(chunk, 0, chunk.size)
                    if (read <= 0) continue
                    var sum = 0.0
                    for (i in 0 until read) sum += chunk[i] * chunk[i].toDouble()
                    val rms = kotlin.math.sqrt(sum / read) / Short.MAX_VALUE
                    val cb = this.callback ?: break
                    try {
                        mainHandler.post { callJsCallback(cb, rms) }
                    } catch (_: Throwable) {
                    }
                }
            } catch (t: Throwable) {
                Log.w(TAG, "VAD loop stopped: ${t.message}")
            } finally {
                try {
                    record.stop()
                } catch (_: Throwable) {
                }
                record.release()
            }
        }
        worker.name = "vistta-vad"
        worker.isDaemon = true
        this.thread = worker
        worker.start()
    }

    /** Releases the tap. Safe to call repeatedly. */
    @android.webkit.JavascriptInterface
    fun stop() {
        callback = null
        thread?.interrupt()
        thread = null
    }

    // AudioRecord callbacks arrive on the VAD worker thread; WebView
    // evaluateJavascript must run on the UI thread, hence the hop through
    // mainHandler in `start`.

    private fun callJsCallback(callback: Any, rms: Double) {
        // The callback object is the injected JS function proxy from
        // addJavascriptInterface; invoking it requires reflection.
        try {
            callback.javaClass.methods
                .first { it.name == "callback" || it.name == "invoke" }
                .invoke(callback, rms)
        } catch (t: Throwable) {
            Log.w(TAG, "VAD callback failed: ${t.message}")
        }
    }
}