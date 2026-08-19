package org.vistta.privilegedclipboard

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Plugin
import java.lang.ref.WeakReference

object PrivilegedClipboardBridge {
    private val handler = Handler(Looper.getMainLooper())
    private var webViewRef: WeakReference<WebView>? = null
    fun attachWebView(webView: WebView) { webViewRef = WeakReference(webView) }
    fun onClipboardChanged(text: String) {
        val webView = webViewRef?.get() ?: return
        val escaped = text.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r")
        handler.post { webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('background-clipboard',{detail:{text:\"$escaped\",type:'text'}}))", null) }
    }
    fun onMonitorStarted() { webViewRef?.get()?.let { webView -> handler.post { webView.evaluateJavascript("window.dispatchEvent(new Event('privileged-clipboard-ready'))", null) } } }
}

@TauriPlugin
class PrivilegedClipboardPlugin(private val activity: Activity) : Plugin(activity) {
    override fun load(webView: WebView) {
        super.load(webView)
        PrivilegedClipboardBridge.attachWebView(webView)
        ShizukuClipboard.attachContext(activity)
        webView.addJavascriptInterface(bridge, "VisttaPrivilegedClipboard")
    }
    private val bridge = object {
        @JavascriptInterface fun isShizukuAvailable() = ShizukuClipboard.isAvailable()
        @JavascriptInterface fun isShizukuAuthorized() = ShizukuClipboard.isAuthorized()
        @JavascriptInterface fun requestShizukuPermission() = ShizukuClipboard.requestPermission()
        @JavascriptInterface fun startMonitor(intervalMs: Double) = ShizukuClipboard.startMonitor(intervalMs.toLong())
        @JavascriptInterface fun stopMonitor() = ShizukuClipboard.stopMonitor()
        @JavascriptInterface fun writeText(text: String) = ShizukuClipboard.writeText(text)
    }
}