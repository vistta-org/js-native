// Background clipboard sync for Android 10+ (API 29+).
//
// Android restricts `ClipboardManager.primaryClip` reads to the foreground
// app or the default IME. A running foreground service is *not* enough —
// `primaryClip` returns null when the app is backgrounded. The only
// legitimate way for a non-IME app to read the clipboard in the background
// is to be an enabled AccessibilityService, which is exempt from the
// restriction.
//
// This object owns the webview reference and the delivery path. The
// actual `ClipboardManager` listener lives in `VisttaAccessibilityService`
// (that is the context with clipboard-read privilege). When the
// accessibility service fires `onPrimaryClipChanged`, it calls back into
// `VisttaClipboard.onClipChanged()` here, which reads the clip text and
// pushes it into the webview via a `background-clipboard` CustomEvent.
//
// The JS side (`@vistta/js-runtime/plugins/clipboard.js`) listens for that
// event and forwards the text to the sync provider.
//
// Public surface used by JS via the `VisttaClipboard` JavascriptInterface
// (registered from `VisttaPlugin`):
//
//   start()                 — register the listener via the accessibility service
//   stop()                  — unregister the listener
//   isAccessibilityEnabled() — returns whether the service is enabled in Settings
//   openAccessibilitySettings() — launches the system Accessibility settings screen

package org.vistta.runtime

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.webkit.WebView
import java.lang.ref.WeakReference

object VisttaClipboard {

    private val mainHandler = Handler(Looper.getMainLooper())

    @Volatile
    private var webViewRef: WeakReference<WebView>? = null

    @Volatile
    private var appContext: WeakReference<Context>? = null

    fun attachWebView(webView: WebView) {
        webViewRef = WeakReference(webView)
    }

    fun attachContext(context: Context) {
        appContext = WeakReference(context.applicationContext)
    }

    /**
     * Returns true if `VisttaAccessibilityService` is currently enabled by
     * the user in Settings → Accessibility. The clipboard listener only
     * delivers content while this is true.
     */
    fun isAccessibilityEnabled(): Boolean {
        val ctx = appContext?.get() ?: return false
        val expected = ctx.packageName + "/org.vistta.runtime.VisttaAccessibilityService"
        val enabled = Settings.Secure.getString(
            ctx.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ) ?: return false
        return enabled.split(":").any { it.equals(expected, ignoreCase = true) }
    }

    /**
     * Launches the system Accessibility settings screen so the user can
     * enable the Vistta service. Must be called from the activity.
     */
    fun openAccessibilitySettings(context: Context) {
        val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }

    /**
     * Called from `VisttaAccessibilityService.onPrimaryClipChanged` with the
     * text already read from `ClipboardManager.primaryClip` by the service
     * (which has the accessibility clipboard-read privilege). This object
     * only delivers the text into the webview — it does NOT read
     * `primaryClip` itself, because the application context it holds does
     * not carry the accessibility privilege on Android 10+.
     */
    fun onClipChanged(text: String) {
        if (text.isEmpty()) return
        deliverClip(text, "text")
    }

    private fun deliverClip(text: String, type: String) {
        val webView = webViewRef?.get() ?: return
        val js = "(function(){try{window.dispatchEvent(new CustomEvent('background-clipboard'," +
            "{detail:{text:" + jsString(text) + ",type:" + jsString(type) + "}}))}" +
            "catch(e){}})()"
        mainHandler.post { webView.evaluateJavascript(js, null) }
    }

    // Minimal JSON string escaper (mirrors VisttaNetwork.jsString usage).
    private fun jsString(s: String): String {
        val sb = StringBuilder("\"")
        for (c in s) {
            when (c) {
                '\\' -> sb.append("\\\\")
                '"' -> sb.append("\\\"")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> {
                    if (c.code < 0x20) {
                        sb.append(String.format("\\u%04x", c.code))
                    } else {
                        sb.append(c)
                    }
                }
            }
        }
        sb.append('"')
        return sb.toString()
    }
}