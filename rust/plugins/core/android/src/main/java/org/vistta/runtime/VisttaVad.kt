// Android voice-activity tap for silence-aware auto-stop (Phase 5).
//
// The audio recording itself runs through tauri-plugin-audio-recorder, whose
// WebView-facing API only reports `{ state, durationMs }` — JS cannot see
// live audio there (the WebView media stack is bypassed; M4A isn't parseable
// until finalised). This object runs a parallel lightweight AudioRecord
// (same app UID — concurrent capture is permitted) and exposes its latest RMS
// through primitive JavascriptInterface methods so the JS side can run its
// shared SilenceWatcher unchanged.
//
// JS contract (see packages/js-native/plugins/recorder.js):
//   window.VisttaVad.start() — begins sampling.
//   window.VisttaVad.sample() — returns the latest 0..1 RMS value.
//   window.VisttaVad.sampleCount() — returns the number of captured samples.
//   window.VisttaVad.stop() — releases the AudioRecord.
//
// The tap emits nothing while idle (no recording session is active unless
// JS calls start); stopping releases the mic buffer immediately.

package org.vistta.runtime

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import android.webkit.JavascriptInterface

object VisttaVad {

    private const val TAG = "VisttaVad"
    private const val SAMPLE_RATE = 16_000
    private const val SAMPLE_INTERVAL_MS = 100

    @Volatile
    private var thread: Thread? = null

    @Volatile
    private var latestRms = 0.0

    @Volatile
    private var samples = 0L

    /**
     * Starts the RMS tap. JavaScript polls `sample()` for the latest value.
     * A new start while active releases the previous tap first.
     */
    @SuppressLint("MissingPermission")
    @android.webkit.JavascriptInterface
    fun start() {
        stop()
        latestRms = 0.0
        samples = 0
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
                while (!Thread.currentThread().isInterrupted) {
                    val read = record.read(chunk, 0, chunk.size)
                    if (read <= 0) continue
                    var sum = 0.0
                    for (i in 0 until read) sum += chunk[i] * chunk[i].toDouble()
                    latestRms = kotlin.math.sqrt(sum / read) / Short.MAX_VALUE
                    samples++
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
        thread?.interrupt()
        thread = null
    }

    /** Returns the latest RMS sample without crossing a callback boundary. */
    @JavascriptInterface
    fun sample(): Double = latestRms

    /** Lets JavaScript distinguish a real zero sample from no native reads. */
    @JavascriptInterface
    fun sampleCount(): Long = samples
}