// Owns the OkHttp client and the Socket.IO connections used by the
// background fetch and background socket plugins. The instance is
// process-wide; VisttaService calls into it on the main thread to
// start/stop sockets and fetches. The actual network work happens on
// OkHttp's internal dispatcher / Socket.IO's worker thread, so it
// keeps running when the activity is paused.
//
// Public surface used by JS via the VisttaFetch and VisttaSocket
// JavascriptInterfaces (registered from VisttaPlugin):
//
//   fetchUrl(id, url, method, headersJson, bodyBase64)
//   abortFetch(id)
//   connectSocket(id, url, optsJson)
//   disconnectSocket(id)
//   emitSocket(id, name, argsJson)

package org.vistta.runtime

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Base64
import android.webkit.WebView
import io.socket.client.IO
import io.socket.client.Socket
import java.lang.ref.WeakReference
import java.net.URI
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

object VisttaNetwork {

    private val mainHandler = Handler(Looper.getMainLooper())
    private val executor = Executors.newCachedThreadPool { r ->
        Thread(r, "vistta-network").apply { isDaemon = true }
    }

    @Volatile
    private var appContext: WeakReference<Context>? = null

    // Ref-counted wake lock: one PARTIAL_WAKE_LOCK is held while any
    // socket is open. Without it, Android pauses the network after a
    // few minutes of background time even with a foreground service.
    private val wakeLockLock = Any()
    private var wakeLock: PowerManager.WakeLock? = null
    private var wakeLockRefCount: Int = 0

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
        .readTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
        .pingInterval(20, java.util.concurrent.TimeUnit.SECONDS)
        .build()

    @Volatile
    private var webViewRef: WeakReference<WebView>? = null

    private val inFlightFetches = ConcurrentHashMap<String, Call>()
    private val sockets = ConcurrentHashMap<String, Socket>()

    fun attachWebView(webView: WebView) {
        webViewRef = WeakReference(webView)
    }

    fun detachWebView() {
        webViewRef = null
    }

    fun attachContext(context: Context) {
        appContext = WeakReference(context.applicationContext)
    }

    // --- Fetch ---

    fun fetchUrl(
        id: String,
        url: String,
        method: String,
        headersJson: String,
        bodyBase64: String?,
    ) {
        executor.execute {
            executeFetch(id, url, method, headersJson, bodyBase64)
        }
    }

    fun abortFetch(id: String) {
        inFlightFetches.remove(id)?.cancel()
    }

    private fun executeFetch(
        id: String,
        urlStr: String,
        methodStr: String,
        headersJson: String,
        bodyBase64: String?,
    ) {
        try {
            val requestBody: RequestBody? = if (bodyBase64 != null) {
                val bytes = Base64.decode(bodyBase64, Base64.DEFAULT)
                val mediaType = "application/octet-stream".toMediaType()
                bytes.toRequestBody(mediaType, 0, bytes.size)
            } else null

            val builder = Request.Builder().url(urlStr)
            val method = methodStr.uppercase()
            when {
                method == "GET" -> builder.get()
                method == "HEAD" -> builder.head()
                requestBody != null -> builder.method(method, requestBody)
                else -> builder.method(method, ByteArray(0).toRequestBody(null, 0, 0))
            }

            applyHeaders(builder, headersJson)

            val call = client.newCall(builder.build())
            inFlightFetches[id] = call
            val response = call.execute()
            val responseBody = response.body
            val bytes = responseBody?.bytes() ?: ByteArray(0)
            val bodyB64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
            val headerLines = response.headers.toMultimap().flatMap { (k, v) ->
                v.map { k + "\t" + it }
            }.joinToString("\n")
            deliverFetchResult(
                id = id,
                ok = true,
                status = response.code,
                headers = headerLines,
                bodyBase64 = bodyB64,
                error = "",
            )
        } catch (e: Throwable) {
            deliverFetchResult(
                id = id,
                ok = false,
                status = 0,
                headers = "",
                bodyBase64 = "",
                error = (e.message ?: e.javaClass.simpleName),
            )
        } finally {
            inFlightFetches.remove(id)
        }
    }

    private fun applyHeaders(builder: Request.Builder, headersJson: String) {
        if (headersJson.isEmpty()) return
        try {
            val obj = JSONObject(headersJson)
            val keys = obj.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                val lower = key.lowercase()
                if (lower in setOf("host", "content-length", "connection", "transfer-encoding", "expect")) continue
                builder.header(key, obj.getString(key))
            }
        } catch (_: Throwable) {}
    }

    private fun deliverFetchResult(
        id: String,
        ok: Boolean,
        status: Int,
        headers: String,
        bodyBase64: String,
        error: String,
    ) {
        val webView = webViewRef?.get() ?: return
        val js = "(function(){try{window.dispatchEvent(new CustomEvent('background-fetch-result',{detail:{id:" + jsString(id) +
            ",ok:" + (if (ok) "true" else "false") +
            ",status:" + status +
            ",headers:" + jsString(headers) +
            ",bodyBase64:" + jsString(bodyBase64) +
            ",error:" + jsString(error) +
            "}}))}catch(e){}})()"
        mainHandler.post { webView.evaluateJavascript(js, null) }
    }

    // --- Socket ---

    fun connectSocket(id: String, url: String, optsJson: String) {
        executor.execute {
            try {
                val opts = IO.Options()
                try {
                    opts.javaClass.getField("reconnection").setBoolean(opts, true)
                    opts.javaClass.getField("reconnectionAttempts").setInt(opts, Int.MAX_VALUE)
                    opts.javaClass.getField("reconnectionDelay").setLong(opts, 1000L)
                    opts.javaClass.getField("reconnectionDelayMax").setLong(opts, 5000L)
                    opts.javaClass.getField("timeout").setLong(opts, 20_000L)
                    // Force WebSocket-only transport. The polling fallback
                    // creates new HTTP requests that Android aggressively
                    // blocks when the app is backgrounded, even with a
                    // foreground service. A persistent WebSocket survives
                    // backgrounding much better.
                    opts.javaClass.getField("transports").set(opts, arrayOf("websocket"))
                    opts.javaClass.getField("pingInterval").setInt(opts, 15_000)
                    opts.javaClass.getField("pingTimeout").setInt(opts, 10_000)
                } catch (_: Throwable) {}
                if (optsJson.isNotEmpty() && optsJson != "{}") {
                    try {
                        val custom = JSONObject(optsJson)
                        val keys = custom.keys()
                        while (keys.hasNext()) {
                            val k = keys.next()
                            val v = custom.opt(k)
                            if (v != null) {
                                when (k) {
                                    "auth", "query" -> {
                                        val map = mutableMapOf<String, String>()
                                        val obj = v as JSONObject
                                        val ks = obj.keys()
                                        while (ks.hasNext()) {
                                            val mk = ks.next()
                                            map[mk] = obj.opt(mk)?.toString() ?: ""
                                        }
                                        try { opts.javaClass.getField(k).set(opts, map) } catch (_: Throwable) {}
                                    }
                                }
                            }
                        }
                    } catch (_: Throwable) {}
                }
                val socket = IO.socket(URI.create(url), opts)
                sockets[id] = socket
                acquireWakeLock()
                appContext?.get()?.let { VisttaService.socketOpened(it) }
                socket.on(Socket.EVENT_CONNECT) { dispatchSocketEvent(id, "connect", emptyArray()) }
                socket.on(Socket.EVENT_DISCONNECT) { args ->
                    dispatchSocketEvent(id, "disconnect", arrayOf(args.firstOrNull()?.toString() ?: ""))
                }
                socket.on(Socket.EVENT_CONNECT_ERROR) { args ->
                    dispatchSocketEvent(id, "connect_error", arrayOf(args.firstOrNull()?.toString() ?: ""))
                }
                socket.onAnyIncoming { args ->
                    if (args.isEmpty()) return@onAnyIncoming
                    val name = args[0]?.toString() ?: ""
                    val rest = if (args.size > 1) args.copyOfRange(1, args.size) else emptyArray()
                    dispatchSocketEvent(id, name, rest)
                }
                socket.connect()
            } catch (e: Throwable) {
                dispatchSocketEvent(id, "connect_error", arrayOf(e.message ?: e.javaClass.simpleName))
            }
        }
    }

    fun disconnectSocket(id: String) {
        val s = sockets.remove(id) ?: return
        try { s.disconnect() } catch (_: Throwable) {}
        try { s.close() } catch (_: Throwable) {}
        releaseWakeLock()
        appContext?.get()?.let { VisttaService.socketClosed(it) }
    }

    fun emitSocket(id: String, name: String, argsJson: String) {
        val s = sockets[id]
        if (s == null || !s.connected()) {
            dispatchSocketEvent(id, "error", arrayOf("not connected"))
            return
        }
        try {
            val args: Array<Any?> = if (argsJson.isEmpty() || argsJson == "[]") {
                emptyArray()
            } else {
                val arr = JSONArray(argsJson)
                Array(arr.length()) { i -> arr.opt(i) }
            }
            s.emit(name, *args)
        } catch (e: Throwable) {
            dispatchSocketEvent(id, "error", arrayOf(e.message ?: e.javaClass.simpleName))
        }
    }

    private fun dispatchSocketEvent(id: String, name: String, args: Array<Any?>) {
        val webView = webViewRef?.get() ?: return
        val argsJson = JSONArray().apply {
            for (a in args) put(a ?: JSONObject.NULL)
        }.toString()
        val js = "(function(){try{window.dispatchEvent(new CustomEvent('background-socket-event',{detail:{id:" + jsString(id) +
            ",name:" + jsString(name) +
            ",args:" + argsJson +
            "}}))}catch(e){}})()"
        mainHandler.post { webView.evaluateJavascript(js, null) }
    }

    fun shutdown() {
        for ((_, s) in sockets) {
            try { s.disconnect() } catch (_: Throwable) {}
            try { s.close() } catch (_: Throwable) {}
        }
        sockets.clear()
        for ((_, c) in inFlightFetches) {
            try { c.cancel() } catch (_: Throwable) {}
        }
        inFlightFetches.clear()
        releaseWakeLock(force = true)
        webViewRef = null
    }

    // Ref-counted wake lock helpers.
    private fun acquireWakeLock() {
        val ctx = appContext?.get() ?: return
        synchronized(wakeLockLock) {
            wakeLockRefCount++
            val current = wakeLock
            if (current != null && current.isHeld) return
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: run {
                wakeLockRefCount--
                return
            }
            val lock = pm.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "vistta:network",
            ).apply {
                setReferenceCounted(false)
            }
            try {
                lock.acquire(60 * 60 * 1000L) // 1 hour ceiling; we re-arm on each acquire
                wakeLock = lock
            } catch (_: Throwable) {
                wakeLockRefCount--
            }
        }
    }

    private fun releaseWakeLock(force: Boolean = false) {
        synchronized(wakeLockLock) {
            if (force) wakeLockRefCount = 0 else if (wakeLockRefCount > 0) wakeLockRefCount--
            if (wakeLockRefCount > 0) return
            val lock = wakeLock ?: return
            try { if (lock.isHeld) lock.release() } catch (_: Throwable) {}
            wakeLock = null
        }
    }

    private fun jsString(s: String): String {
        val sb = StringBuilder(s.length + 2)
        sb.append('"')
        var i = 0
        val n = s.length
        while (i < n) {
            val c = s[i]
            val code = c.code
            when (code) {
                34 -> sb.append("\\\"")
                92 -> sb.append("\\\\")
                10 -> sb.append("\\n")
                13 -> sb.append("\\r")
                9 -> sb.append("\\t")
                8 -> sb.append("\\b")
                12 -> sb.append("\\f")
                else -> if (code < 32) sb.append("\\u%04x".format(code)) else sb.append(c)
            }
            i++
        }
        sb.append('"')
        return sb.toString()
    }
}