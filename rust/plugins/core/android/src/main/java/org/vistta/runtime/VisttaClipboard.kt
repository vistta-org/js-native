package org.vistta.runtime

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import java.lang.ref.WeakReference

object VisttaClipboard {

    private val mainHandler = Handler(Looper.getMainLooper())

    @Volatile
    private var webViewRef: WeakReference<WebView>? = null

    fun attachWebView(webView: WebView) {
        webViewRef = WeakReference(webView)
    }

    fun syncClipboard(context: Context): Boolean {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return false
        val text = try {
            clipboard.primaryClip
                ?.takeIf { it.itemCount > 0 }
                ?.getItemAt(0)
                ?.coerceToText(context)
                ?.toString()
        } catch (_: Throwable) {
            null
        } ?: return false
        if (text.isEmpty()) return false
        deliverClip(text)
        return true
    }

    private fun deliverClip(text: String) {
        val webView = webViewRef?.get() ?: return
        val js = "(function(){try{window.dispatchEvent(new CustomEvent('background-clipboard'," +
            "{detail:{text:" + jsString(text) + ",type:\"text\"}}))}" +
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