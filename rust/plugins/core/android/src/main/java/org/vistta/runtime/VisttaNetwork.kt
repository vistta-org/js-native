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
import android.net.ConnectivityManager
import android.net.Network
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
import okhttp3.MediaType.Companion.toMediaTypeOrNull
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

    @Volatile
    private var eventWakeLock: PowerManager.WakeLock? = null

    @Volatile
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    @Volatile
    private var defaultNetwork: Network? = null

    // No read timeout, matching WebView fetch: responses such as AI generation can take minutes.
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
        .readTimeout(0, java.util.concurrent.TimeUnit.SECONDS)
        .pingInterval(20, java.util.concurrent.TimeUnit.SECONDS)
        .build()

    @Volatile
    private var webViewRef: WeakReference<WebView>? = null

    private val inFlightFetches = ConcurrentHashMap<String, Call>()
    private val sockets = ConcurrentHashMap<String, Socket>()

    // Socket id -> event names registered with `mobile: { background: true }`.
    private val backgroundEvents = ConcurrentHashMap<String, MutableSet<String>>()

    // Sockets that dropped events while backgrounded; they resync on resume.
    private val droppedWhileBackground = ConcurrentHashMap.newKeySet<String>()

    @Volatile
    private var inBackground = false

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

    private const val FETCH_CHUNK_SIZE = 64 * 1024

    private fun executeFetch(
        id: String,
        urlStr: String,
        methodStr: String,
        headersJson: String,
        bodyBase64: String?,
    ) {
        var headSent = false
        try {
            val requestBody: RequestBody? = if (bodyBase64 != null) {
                val bytes = Base64.decode(bodyBase64, Base64.DEFAULT)
                val mediaType = headerValue(headersJson, "content-type")?.toMediaTypeOrNull()
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
            call.execute().use { response ->
                val headerLines = response.headers.toMultimap().flatMap { (k, v) ->
                    v.map { k + "\t" + it }
                }.joinToString("\n")
                dispatchFetchEvent("background-fetch-head", id, ",status:" + response.code + ",headers:" + jsString(headerLines))
                headSent = true
                response.body?.byteStream()?.use { input ->
                    val buffer = ByteArray(FETCH_CHUNK_SIZE)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        if (read > 0) {
                            val data = Base64.encodeToString(buffer, 0, read, Base64.NO_WRAP)
                            dispatchFetchEvent("background-fetch-chunk", id, ",data:" + jsString(data))
                        }
                    }
                }
                dispatchFetchEvent("background-fetch-end", id, "")
            }
        } catch (e: Throwable) {
            val error = jsString(e.message ?: e.javaClass.simpleName)
            if (headSent) dispatchFetchEvent("background-fetch-end", id, ",error:" + error)
            else dispatchFetchEvent("background-fetch-result", id, ",error:" + error)
        } finally {
            inFlightFetches.remove(id)
        }
    }

    private fun headerValue(headersJson: String, name: String): String? {
        if (headersJson.isEmpty()) return null
        return try {
            val obj = JSONObject(headersJson)
            obj.keys().asSequence().firstOrNull { it.equals(name, ignoreCase = true) }?.let { obj.getString(it) }
        } catch (_: Throwable) {
            null
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

    private fun dispatchFetchEvent(name: String, id: String, fields: String) {
        val webView = webViewRef?.get() ?: return
        val js = "(function(){try{window.dispatchEvent(new CustomEvent('" + name + "',{detail:{id:" + jsString(id) +
            fields + "}}))}catch(e){}})()"
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
                    opts.javaClass.getField("reconnectionDelayMax").setLong(opts, 300_000L)
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
                watchNetwork()
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
                sockets.remove(id)
                dispatchSocketEvent(id, "connect_error", arrayOf(e.message ?: e.javaClass.simpleName))
            }
        }
    }

    fun disconnectSocket(id: String) {
        droppedWhileBackground.remove(id)
        val s = sockets.remove(id) ?: return
        try { s.disconnect() } catch (_: Throwable) {}
        try { s.close() } catch (_: Throwable) {}
    }

    fun setBackground(id: String, name: String, background: Boolean) {
        synchronized(backgroundEvents) {
            if (background) {
                backgroundEvents.getOrPut(id) { ConcurrentHashMap.newKeySet() }.add(name)
            } else {
                val names = backgroundEvents[id] ?: return
                names.remove(name)
                if (names.isEmpty()) backgroundEvents.remove(id)
            }
            appContext?.get()?.let { VisttaService.setBackgroundEvents(it, backgroundEvents.isNotEmpty()) }
        }
    }

    fun onAppBackground() {
        inBackground = true
    }

    fun onAppForeground() {
        inBackground = false
        appContext?.get()?.let { VisttaService.resumePendingStart(it) }
        for (id in droppedWhileBackground.toList()) {
            droppedWhileBackground.remove(id)
            val s = sockets[id] ?: continue
            // Reported first so JS sees a drop even if the socket is not connected right now.
            dispatchSocketEvent(id, "disconnect", arrayOf("background"))
            executor.execute {
                try {
                    s.disconnect()
                    s.connect()
                } catch (_: Throwable) {}
            }
        }
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
        if (inBackground && backgroundEvents[id]?.contains(name) != true) {
            droppedWhileBackground.add(id)
            return
        }
        holdBriefly()
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

    private const val EVENT_WAKE_LOCK_MS = 10_000L

    // Short timed lock so an incoming event is delivered before the device sleeps again.
    private fun holdBriefly() {
        val lock = eventWakeLock ?: run {
            val pm = appContext?.get()?.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
            pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "vistta:network")
                .apply { setReferenceCounted(false) }
                .also { eventWakeLock = it }
        }
        try { lock.acquire(EVENT_WAKE_LOCK_MS) } catch (_: Throwable) {}
    }

    // Disconnects while offline (no retries) and reconnects with a reset backoff when a new default network appears.
    private fun watchNetwork() {
        if (networkCallback != null) return
        val cm = appContext?.get()?.getSystemService(ConnectivityManager::class.java) ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                if (network == defaultNetwork) return
                defaultNetwork = network
                for (s in sockets.values) {
                    try {
                        s.disconnect()
                        s.connect()
                    } catch (_: Throwable) {}
                }
            }

            override fun onLost(network: Network) {
                if (network != defaultNetwork) return
                defaultNetwork = null
                for (s in sockets.values) {
                    try { s.disconnect() } catch (_: Throwable) {}
                }
            }
        }
        try {
            defaultNetwork = cm.activeNetwork
            cm.registerDefaultNetworkCallback(callback)
            networkCallback = callback
        } catch (_: Throwable) {}
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