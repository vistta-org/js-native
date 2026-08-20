package org.vistta.runtime

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebView
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import org.json.JSONArray
import java.lang.ref.WeakReference

/**
 * Android launcher-shortcut bridge.
 *
 * Published dynamically via [ShortcutManagerCompat] (works on all API levels
 * the runtime supports, unlike the raw [ShortcutManager] which is API 25+).
 * The webview-facing surface is the `VisttaShortcuts` JavascriptInterface
 * injected by [VisttaPlugin]; JS calls [setShortcuts] with a JSON array of
 * `{ id, label, icon, payload }` entries.
 *
 * When the user selects a shortcut, Android (re)launches the activity with an
 * intent whose action is [ACTION_LAUNCH_SHORTCUT] and whose
 * [EXTRA_SHORTCUT_ID] extra holds the shortcut id. [MainActivity] forwards
 * that intent here via [dispatchIntent]; this object evaluates a
 * `launch-action` `CustomEvent` into the webview so the JS
 * `onLaunchAction` handler receives `{ id, payload }`.
 *
 * `payload` is recovered from the shortcut's intent extras so it survives a
 * cold start (the JS `setShortcuts` list is not available until the webview
 * boots). The payload is stored as an intent extra at publish time.
 */
object VisttaShortcuts {

    private const val TAG = "VisttaShortcuts"
    const val ACTION_LAUNCH_SHORTCUT = "org.vistta.runtime.LAUNCH_SHORTCUT"
    const val EXTRA_SHORTCUT_ID = "vistta.shortcut.id"
    const val EXTRA_SHORTCUT_PAYLOAD = "vistta.shortcut.payload"

    private val mainHandler = Handler(Looper.getMainLooper())

    @Volatile
    private var activityRef: WeakReference<Activity>? = null

    @Volatile
    private var webViewRef: WeakReference<WebView>? = null

    fun attachActivity(activity: Activity) {
        activityRef = WeakReference(activity)
    }

    fun attachWebView(webView: WebView) {
        webViewRef = WeakReference(webView)
    }

    /**
     * Publishes the dynamic shortcut list. Called from JS via the
     * `VisttaShortcuts` JavascriptInterface bridge. Replaces the entire
     * dynamic set each call (static shortcuts declared in `shortcuts.xml`,
     * if any, are left untouched).
     *
     * @param json A JSON array: `[ { "id", "label", "icon", "payload" }, ... ]`.
     * `icon` is a drawable resource name (no extension); missing or
     * unresolvable icons result in a transparent icon so the launcher shows
     * no icon instead of the default app icon.
     */
    @android.webkit.JavascriptInterface
    fun setShortcuts(json: String) {
        val activity = activityRef?.get() ?: return
        val entries = parseList(activity, json) ?: return

        val shortcuts = entries.mapNotNull { entry ->
            val builder = ShortcutInfoCompat.Builder(activity, entry.id)
                .setShortLabel(entry.label)
                .setIntent(
                    Intent(ACTION_LAUNCH_SHORTCUT).apply {
                        setClassName(activity, activity.javaClass.name)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                        putExtra(EXTRA_SHORTCUT_ID, entry.id)
                        if (entry.payload != null) putExtra(EXTRA_SHORTCUT_PAYLOAD, entry.payload)
                    },
                )
            if (entry.iconRes != null) {
                builder.setIcon(IconCompat.createWithResource(activity, entry.iconRes))
            } else {
                // No icon specified — use a transparent icon so the launcher
                // shows nothing instead of falling back to the app icon.
                builder.setIcon(IconCompat.createWithBitmap(transparentBitmap()))
            }
            try {
                builder.build()
            } catch (t: Throwable) {
                Log.w(TAG, "Failed to build shortcut ${entry.id}: ${t.message}")
                null
            }
        }

        try {
            // Replace the dynamic set atomically. ShortcutManagerCompat
            // handles the API-level branching (ShortcutManager on 25+,
            // intent-based long-press menu fallback below that).
            ShortcutManagerCompat.removeAllDynamicShortcuts(activity)
            if (shortcuts.isNotEmpty()) {
                ShortcutManagerCompat.addDynamicShortcuts(activity, shortcuts)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to publish dynamic shortcuts: ${t.message}")
        }
    }

    /**
     * Called by [MainActivity] from `onCreate` / `onNewIntent` when the
     * activity was launched via a shortcut intent. Extracts the id + payload
     * and dispatches a `launch-action` event into the webview.
     *
     * If the webview is not yet attached (cold start before `VisttaPlugin`
     * has run), the action is stashed and re-dispatched once
     * [attachWebView] is called.
     */
    fun dispatchIntent(intent: Intent?) {
        if (intent == null) return
        if (ACTION_LAUNCH_SHORTCUT != intent.action) return
        val id = intent.getStringExtra(EXTRA_SHORTCUT_ID) ?: return
        val payload = intent.getStringExtra(EXTRA_SHORTCUT_PAYLOAD)
        deliverLaunchAction(id, payload)
    }

    /** Pending action to deliver once the webview attaches. */
    @Volatile
    private var pending: Pair<String, String?>? = null

    private fun deliverLaunchAction(id: String, payload: String?) {
        val webView = webViewRef?.get()
        if (webView == null) {
            pending = id to payload
            return
        }
        evaluateLaunchAction(webView, id, payload)
    }

    /**
     * Called from [VisttaPlugin.load] after the webview is ready. Flushes any
     * action that arrived during cold start.
     */
    fun flushPending() {
        val p = pending ?: return
        pending = null
        val webView = webViewRef?.get() ?: return
        evaluateLaunchAction(webView, p.first, p.second)
    }

    private fun evaluateLaunchAction(webView: WebView, id: String, payload: String?) {
        val payloadJson = if (payload != null) jsString(payload) else "null"
        val idJson = jsString(id)
        val js = "(function(){try{window.dispatchEvent(new CustomEvent('launch-action'," +
            "{detail:{id:$idJson,payload:$payloadJson}}))}catch(e){}})()"
        mainHandler.post { webView.evaluateJavascript(js, null) }
    }

    // --- Parsing helpers ---

    private fun parseList(context: Context, json: String): List<ParsedEntry>? {
        val arr = try {
            JSONArray(json)
        } catch (t: Throwable) {
            Log.w(TAG, "Invalid shortcuts JSON: ${t.message}")
            return null
        }
        val out = ArrayList<ParsedEntry>(arr.length())
        for (i in 0 until arr.length()) {
            val obj = arr.optJSONObject(i) ?: continue
            val id = obj.optString("id").takeIf { it.isNotEmpty() } ?: continue
            val label = obj.optString("label", id)
            val iconName = obj.optString("icon").takeIf { it.isNotEmpty() }
            val payload = obj.optString("payload").takeIf { it.isNotEmpty() }
            val iconRes = iconName?.let { resolveDrawable(context, it) }
            out.add(ParsedEntry(id, label, iconRes, payload))
        }
        return out
    }

    private class ParsedEntry(val id: String, val label: String, val iconRes: Int?, val payload: String?)

    private fun transparentBitmap(): Bitmap {
        return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888).apply {
            eraseColor(Color.TRANSPARENT)
        }
    }

    private fun resolveDrawable(context: Context, name: String): Int? {
        return try {
            val resId = context.resources.getIdentifier(name, "drawable", context.packageName)
            if (resId != 0) resId else null
        } catch (_: Throwable) {
            null
        }
    }

    // Minimal JSON string escaper (mirrors VisttaClipboard.jsString usage).
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