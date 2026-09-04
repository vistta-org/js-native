// Native screen recording for the Android WebView (MediaProjection).
//
// Android has no getUserMedia({video:{displaySurface}}) equivalent inside the
// WebView, so screen capture must go through MediaProjection. This class
// owns the consent flow and the capture session:
//
//   start(id, filePath)  → shows the system consent dialog; on grant, starts
//                          a MediaProjection + MediaRecorder capture writing
//                          an MP4 to filePath.
//   stop(id)             → stops the capture and finalises the MP4.
//
// JS contract (see packages/js-runtime/plugins/recorder.js):
//   invoke("vistta|start_screen_recording", { id, filePath }) → resolves once
//     the consent dialog is granted and capture has begun; rejects if denied.
//   invoke("vistta|stop_screen_recording", { id }) → resolves after the file
//     is finalised; the JS side then reads it back via the fs plugin.
//
// Only one screen recording runs at a time; a new start while active stops
// the previous capture.

package org.vistta.runtime

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.lang.ref.WeakReference

@InvokeArg
class StartScreenArgs {
    lateinit var id: String
    lateinit var filePath: String
}

@InvokeArg
class StopScreenArgs {
    lateinit var id: String
}

class VisttaScreenRecorder(private val plugin: Plugin, private val activity: Activity) {
    companion object {
        private const val TAG = "VisttaScreenRecorder"
    }

    private val mainHandler = Handler(Looper.getMainLooper())

    private var projectionRef: WeakReference<MediaProjection>? = null
    private var displayRef: WeakReference<VirtualDisplay>? = null
    private var recorder: MediaRecorder? = null
    private var activeId: String? = null
    private var pendingId: String? = null
    private var pendingPath: String? = null
    private var pendingInvoke: Invoke? = null

    @Command
    fun startScreenRecording(invoke: Invoke) {
        val args = invoke.parseArgs(StartScreenArgs::class.java)
        if (recorder != null) {
            // One capture at a time — finalise the previous session first.
            stopCapture()
        }
        pendingId = args.id
        pendingPath = args.filePath
        pendingInvoke = invoke
        val mgr = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        // Tauri's own activity-result plumbing: the @ActivityCallback method
        // below receives the consent result.
        plugin.startActivityForResult(invoke, mgr.createScreenCaptureIntent(), "onProjectionConsent")
    }

    @ActivityCallback
    fun onProjectionConsent(invoke: Invoke, result: ActivityResult) {
        val id = pendingId ?: return
        val path = pendingPath ?: return
        val consentInvoke = pendingInvoke
        pendingId = null
        pendingPath = null
        pendingInvoke = null
        if (result.resultCode != Activity.RESULT_OK || result.data == null) {
            consentInvoke?.reject("Screen recording permission was denied.")
            return
        }
        try {
            beginCapture(id, path, result.resultCode, result.data!!)
            consentInvoke?.resolve(JSObject())
        } catch (t: Throwable) {
            Log.w(TAG, "Screen capture failed: ${t.message}")
            consentInvoke?.reject(t.message ?: "Screen recording failed to start.")
        }
    }

    private fun beginCapture(id: String, path: String, resultCode: Int, data: Intent) {
        val mgr = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val projection = mgr.getMediaProjection(resultCode, data)
            ?: throw IllegalStateException("MediaProjection was denied.")
        val metrics = activity.resources.displayMetrics
        val width = minOf(metrics.widthPixels, 1280)
        val height = minOf(metrics.heightPixels, 720)
        recorder = MediaRecorder().apply {
            setVideoSource(MediaRecorder.VideoSource.SURFACE)
            setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            setOutputFile(path)
            setVideoEncoder(MediaRecorder.VideoEncoder.H264)
            setVideoEncodingBitRate(4_000_000)
            setVideoFrameRate(30)
            setVideoSize(width, height)
            prepare()
        }
        val display = projection.createVirtualDisplay(
            "vistta-screen-$id",
            width,
            height,
            metrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            recorder!!.surface,
            null,
            mainHandler,
        )
        recorder!!.start()
        projectionRef = WeakReference(projection)
        displayRef = WeakReference(display)
        activeId = id
    }

    @Command
    fun stopScreenRecording(invoke: Invoke) {
        val args = invoke.parseArgs(StopScreenArgs::class.java)
        if (activeId != args.id) {
            invoke.reject("No active screen recording with that id.")
            return
        }
        try {
            stopCapture()
            invoke.resolve(JSObject())
        } catch (t: Throwable) {
            Log.w(TAG, "Stop failed: ${t.message}")
            invoke.reject(t.message ?: "Screen recording failed to stop.")
        }
    }

    private fun stopCapture() {
        try {
            recorder?.stop()
        } catch (_: Throwable) {
        }
        try {
            displayRef?.get()?.release()
        } catch (_: Throwable) {
        }
        try {
            projectionRef?.get()?.stop()
        } catch (_: Throwable) {
        }
        recorder?.release()
        recorder = null
        displayRef = null
        projectionRef = null
        activeId = null
    }
}