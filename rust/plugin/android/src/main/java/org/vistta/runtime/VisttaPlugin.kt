// Vistta.js Runtime Android plugin.
//
// Registered by the Rust crate `tauri-plugin-vistta` via
// `register_android_plugin("org.vistta.runtime", "VisttaPlugin")`. Owns the
// three JavascriptInterface bridges injected into the webview:
//
//   VisttaScheduler — start/stop background timers (see VisttaService).
//   VisttaFetch     — route fetch() through the foreground service so it
//                     completes while the activity is paused.
//   VisttaSocket    — open/close/emit Socket.IO connections that survive
//                     backgrounding (see VisttaNetwork).
//
// The plugin also creates the default notification channel used by the
// Tauri notification plugin, and publishes the webview reference to
// VisttaService + VisttaNetwork so they can evalScript results back into
// JS even when the activity is paused.

package org.vistta.runtime

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.webkit.JavascriptInterface
import android.webkit.WebView
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Plugin

@TauriPlugin
class VisttaPlugin(private val activity: Activity) : Plugin(activity) {

    private var webView: WebView? = null

    override fun load(webView: WebView) {
        super.load(webView)
        this.webView = webView
        ensureDefaultNotificationChannel()
        VisttaService.attachWebView(webView)
        VisttaNetwork.attachWebView(webView)
        VisttaNetwork.attachContext(activity)
        webView.addJavascriptInterface(visttaSchedulerBridge, "VisttaScheduler")
        webView.addJavascriptInterface(visttaFetchBridge, "VisttaFetch")
        webView.addJavascriptInterface(visttaSocketBridge, "VisttaSocket")
    }

    private fun ensureDefaultNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel("default") == null) {
            val name = activity.applicationInfo.loadLabel(activity.packageManager).toString()
            mgr.createNotificationChannel(
                NotificationChannel("default", name, NotificationManager.IMPORTANCE_DEFAULT),
            )
        }
    }

    private val visttaSchedulerBridge = object {
        @JavascriptInterface
        fun registerTimer(id: String, intervalMs: Double) {
            VisttaService.registerTimer(activity, id, intervalMs.toLong())
        }

        @JavascriptInterface
        fun clearTimer(id: String) {
            VisttaService.clearTimer(activity, id)
        }

        @JavascriptInterface
        fun stopIfEmpty() {
            VisttaService.stopIfEmpty(activity)
        }
    }

    private val visttaFetchBridge = object {
        @JavascriptInterface
        fun fetchUrl(id: String, url: String, method: String, headersJson: String, bodyBase64: String?) {
            VisttaNetwork.fetchUrl(id, url, method, headersJson, bodyBase64)
        }

        @JavascriptInterface
        fun abortFetch(id: String) {
            VisttaNetwork.abortFetch(id)
        }
    }

    private val visttaSocketBridge = object {
        @JavascriptInterface
        fun connect(id: String, url: String, optsJson: String) {
            VisttaNetwork.connectSocket(id, url, optsJson)
        }

        @JavascriptInterface
        fun disconnect(id: String) {
            VisttaNetwork.disconnectSocket(id)
        }

        @JavascriptInterface
        fun emit(id: String, name: String, argsJson: String) {
            VisttaNetwork.emitSocket(id, name, argsJson)
        }
    }
}