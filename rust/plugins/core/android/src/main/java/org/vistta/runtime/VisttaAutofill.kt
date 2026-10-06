package org.vistta.runtime

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.autofill.AutofillManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap

object VisttaAutofill {
    private val main = Handler(Looper.getMainLooper())
    private val random = SecureRandom()
    private var webView: WeakReference<WebView>? = null
    private var activity: WeakReference<Activity>? = null
    private val pending = ConcurrentHashMap<String, (JSONObject?) -> Unit>()

    private fun trusted(view: WebView?): Boolean {
        val url = view?.url ?: return false
        return url.startsWith("http://tauri.localhost/") || url.startsWith("https://tauri.localhost/")
    }

    fun attach(view: WebView, host: Activity) {
        pending.clear()
        webView = WeakReference(view)
        activity = WeakReference(host)
    }

    fun returnToCaller() {
        main.post { activity?.get()?.moveTaskToBack(true) }
    }

    fun request(operation: String, data: JSONObject, callback: (JSONObject?) -> Unit) {
        main.post {
            val view = webView?.get()
            if (view == null || !trusted(view)) {
                callback(null)
                return@post
            }
            val bytes = ByteArray(24).also(random::nextBytes)
            val id = bytes.joinToString("") { "%02x".format(it) }
            pending[id] = callback
            main.postDelayed({ pending.remove(id)?.invoke(null) }, 2500)
            val message = JSONObject().put("id", id).put("operation", operation).put("data", data)
            val script = "window.dispatchEvent(new CustomEvent('vistta-autofill-request'," +
                "{detail:JSON.parse(${JSONObject.quote(message.toString())})}))"
            view.evaluateJavascript(script) { result ->
                if (result != "true") pending.remove(id)?.invoke(null)
            }
        }
    }

    @JavascriptInterface
    fun reply(id: String, json: String) {
        if (id.length != 48 || json.length > 32768) return
        main.post {
            val callback = pending.remove(id) ?: return@post
            if (!trusted(webView?.get())) {
                callback(null)
                return@post
            }
            callback(try { JSONObject(json) } catch (_: Exception) { null })
        }
    }

    @JavascriptInterface
    fun enabled(): Boolean {
        if (Build.VERSION.SDK_INT < 26) return false
        val host = activity?.get() ?: return false
        return host.getSystemService(AutofillManager::class.java)?.hasEnabledAutofillServices() == true
    }

    @JavascriptInterface
    fun openSettings() {
        if (Build.VERSION.SDK_INT < 26) return
        main.post {
            val host = activity?.get() ?: return@post
            host.startActivity(Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE).apply {
                data = android.net.Uri.parse("package:${host.packageName}")
            })
        }
    }
}
