import fs from "@vistta/fs";
import { devSuffix, resolveAppId, writeIfChanged } from "../utils/index.js";

const STRINGS = { begin: "<!-- vistta:strings:begin -->", end: "<!-- vistta:strings:end -->" };
const ACTIVITY = { begin: "// vistta:activity:begin", end: "// vistta:activity:end" };
const ACTIVITY_IMPORTS = { begin: "// vistta:activity-imports:begin", end: "// vistta:activity-imports:end" };
const ACTIVITY_WEBVIEW = { begin: "// vistta:webview:begin", end: "// vistta:webview:end" };
const ACTIVITY_WEBVIEW_BRIDGE = { begin: "// vistta:webview-bridge:begin", end: "// vistta:webview-bridge:end" };
const SERVICE = { begin: "<!-- vistta:service:begin -->", end: "<!-- vistta:service:end -->" };
const SERVICE_PERMS = { begin: "<!-- vistta:service-perms:begin -->", end: "<!-- vistta:service-perms:end -->" };
const GRADLE_DEPS = { begin: "// vistta:gradle-deps:begin", end: "// vistta:gradle-deps:end" };

// Note: signing keystore / applicationIdSuffix patches have been removed
// (see package-level docs).
//
// Foreground-service based scheduling is back (see patchVisttaService).
// The service holds the process + webview alive so setBackgroundInterval
// callbacks keep firing when the app is backgrounded or the device is
// locked. Service is auto-stopped when no timers are registered.

/**
 * Rewrites Tauri 2.11.2's generated `BuildTask.kt` to call the `tauri` CLI
 * binary directly, instead of going through `npm run -- tauri ...`. The
 * latter assumes the consumer's `package.json` has a `tauri` script; this
 * runtime reaches the tauri binary via `npx tauri` from `index.js`, not
 * through an npm script. Rewriting to a direct invocation makes the
 * consumer's `package.json` self-contained (no `tauri` script required).
 *
 * Idempotent: also recognises and rewrites a previously-patched form
 * (`executable = "tauri"`, args list without the `run`/`--`/`tauri` prefix).
 * If Tauri changes the file's shape dramatically the patch silently
 * no-ops — the build will then fail with a clear error from Gradle.
 */
export async function patchBuildTask(targetDir, config) {
  const appId = resolveAppId(config);
  const packagePath = appId.replace(/\./g, "/");
  const buildTaskPath = fs.resolve(
    targetDir,
    "gen",
    "android",
    "buildSrc",
    "src",
    "main",
    "java",
    packagePath,
    "kotlin",
    "BuildTask.kt",
  );
  if (!fs.existsSync(buildTaskPath)) return;
  let content = String(await fs.readFile(buildTaskPath, "utf8"));
  // The tauri binary is resolved from PATH that Gradle passes to the task;
  // node_modules/.bin is on that PATH (where the tauri CLI lives once the
  // runtime's transitive deps install it). `npx` is NOT on that PATH.
  content = content.replace(/val\s+executable\s*=\s*"""(?:npm|npx)"""\s*;?/g, 'val executable = """tauri""";');
  // Strip the `run`/`--`/`tauri` prefix from the args list, in either order.
  content = content.replace(/val\s+args\s*=\s*listOf\(\s*"run"\s*,\s*"--"\s*,\s*"tauri"\s*,\s*/g, "val args = listOf(");
  content = content.replace(/val\s+args\s*=\s*listOf\(\s*"tauri"\s*,\s*/g, "val args = listOf(");
  await writeIfChanged(buildTaskPath, content);
}

/**
 * Adds the runtime's Maven dependencies to the generated app's
 * `build.gradle.kts`. The background fetch plugin uses OkHttp for HTTP
 * and the background socket plugin uses the Socket.IO Java client
 * (which transitively pulls OkHttp and Engine.IO). Versions are pinned
 * to known-good releases; bump deliberately rather than tracking latest.
 *
 * Idempotent: re-runs are a no-op once the dependencies are in place.
 */
export async function patchAppGradle(targetDir) {
  const appGradlePath = fs.resolve(targetDir, "gen", "android", "app", "build.gradle.kts");
  if (!fs.existsSync(appGradlePath)) return;
  let content = String(await fs.readFile(appGradlePath, "utf8"));

  // These three are the runtime-owned additions. Keep them inside the
  // marker block so a future re-patch can update them in place.
  const deps = [
    `    implementation("com.squareup.okhttp3:okhttp:4.12.0")`,
    `    implementation("io.socket:socket.io-client:2.1.0") {`,
    `        exclude(group = "org.json", module = "json")`,
    `    }`,
  ].join("\n");

  // The body has to live outside `dependencies { ... }` syntactically, so
  // insert it as the last entries of the existing block. ensureBlockLines
  // handles the placement.
  content = ensureBlockLines(content, GRADLE_DEPS, deps, (c, generated) => {
    // First-time insertion: place right before the closing brace of the
    // `dependencies { ... }` block. We anchor on the `testImplementation`
    // line which Tauri always emits; if it's missing we fall back to the
    // closing `}` after `dependencies {`.
    if (/testImplementation\s*\(/.test(c)) {
      return c.replace(/(\n}\s*\n?\s*apply\()/m, `\n${generated}\n$1`);
    }
    return c.replace(/(dependencies\s*\{\s*\n)/, `$1${generated}\n`);
  });

  await writeIfChanged(appGradlePath, content);
}

/**
 * Writes `VisttaNetwork.kt` in full. This class owns the runtime's
 * background HTTP and Socket.IO clients (OkHttp + the Socket.IO Java
 * client). It runs in-process and is invoked by `VisttaService` so the
 * clients survive the activity being paused.
 *
 * Public surface used by JS via the `VisttaFetch` and `VisttaSocket`
 * JavascriptInterfaces (registered from MainActivity):
 *
 *   fetchUrl(id, url, method, headersJson, body)  — OkHttp call, dispatches
 *                                                    a 'background-fetch-result'
 *                                                    event with the result.
 *   abortFetch(id)                                 — cancel an in-flight fetch.
 *
 *   connectSocket(id, url, optsJson)               — open a Socket.IO connection
 *                                                    on a background thread;
 *                                                    server events are forwarded
 *                                                    to the webview as
 *                                                    'background-socket-event'.
 *   disconnectSocket(id)                           — close a connection.
 *   emitSocket(id, name, argsJson)                 — emit an event.
 *
 * The class is the only place that holds a reference to the `RustWebView`
 * (weak, to avoid leaking the webview through service lifecycle). Inbound
 * Socket.IO events are delivered to the webview via `evalScript`.
 */
export async function patchVisttaNetwork(targetDir, config) {
  const appId = resolveAppId(config);
  const packagePath = appId.replace(/\./g, "/");
  const networkPath = fs.resolve(targetDir, "gen", "android", "app", "src", "main", "java", packagePath, "VisttaNetwork.kt");
  await fs.mkdir(fs.dirname(networkPath), { recursive: true });
  const lines = [
    "// Generated by @vistta/js-runtime. Do not edit by hand.",
    "package " + appId,
    "",
    "import android.os.Handler",
    "import android.os.Looper",
    "import android.os.PowerManager",
    "import android.util.Base64",
    "import android.content.Context",
    "import io.socket.client.IO",
    "import io.socket.client.Socket",
    "import java.lang.ref.WeakReference",
    "import java.net.URI",
    "import java.util.concurrent.ConcurrentHashMap",
    "import java.util.concurrent.Executors",
    "import okhttp3.Call",
    "import okhttp3.Headers",
    "import okhttp3.MediaType.Companion.toMediaType",
    "import okhttp3.OkHttpClient",
    "import okhttp3.Request",
    "import okhttp3.RequestBody",
    "import okhttp3.RequestBody.Companion.toRequestBody",
    "import org.json.JSONArray",
    "import org.json.JSONObject",
    "",
    "/**",
    " * Owns the OkHttp client and the Socket.IO connections used by the",
    " * background fetch and background socket plugins. The instance is",
    " * process-wide; `VisttaService` calls into it on the main thread to",
    " * start/stop sockets and fetches. The actual network work happens on",
    " * OkHttp's internal dispatcher / Socket.IO's worker thread, so it",
    " * keeps running when the activity is paused.",
    " */",
    "object VisttaNetwork {",
    "    private val mainHandler = Handler(Looper.getMainLooper())",
    "    private val executor = Executors.newCachedThreadPool { r ->",
    "        Thread(r, " + JSON.stringify("vistta-network") + ").apply { isDaemon = true }",
    "    }",
    "",
    "    // Application context (for PowerManager). Set by attachContext from",
    "    // MainActivity; weak so we don't keep the activity alive.",
    "    @Volatile",
    "    private var appContext: WeakReference<Context>? = null",
    "",
    "    // Ref-counted wake lock: one PARTIAL_WAKE_LOCK is held while any",
    "    // socket is open. Without it, Android pauses the network after a",
    "    // few minutes of background time even with a foreground service.",
    "    // The OS auto-releases a wake lock after ~15 min; we re-acquire on",
    "    // each new socket so a long-running connection stays alive.",
    "    private val wakeLockLock = Any()",
    "    private var wakeLock: PowerManager.WakeLock? = null",
    "    private var wakeLockRefCount: Int = 0",
    "",
    "    private val client: OkHttpClient = OkHttpClient.Builder()",
    "        .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)",
    "        .readTimeout(30, java.util.concurrent.TimeUnit.SECONDS)",
    "        .pingInterval(20, java.util.concurrent.TimeUnit.SECONDS)",
    "        .build()",
    "",
    "    // Weak ref to the webview so we can evalScript socket/fetch",
    "    // results. Set by VisttaService.attachWebView (which already",
    "    // holds a weak ref for scheduler ticks).",
    "    @Volatile",
    "    private var webViewRef: WeakReference<RustWebView>? = null",
    "",
    "    private val inFlightFetches = ConcurrentHashMap<String, Call>()",
    "    private val sockets = ConcurrentHashMap<String, Socket>()",
    "    private var evalIdCounter = 0",
    "",
    "    fun attachWebView(webView: RustWebView) {",
    "        webViewRef = WeakReference(webView)",
    "    }",
    "",
    "    fun detachWebView() {",
    "        webViewRef = null",
    "    }",
    "",
    "    fun attachContext(context: Context) {",
    "        appContext = WeakReference(context.applicationContext)",
    "    }",
    "",
    "    // --- Fetch ---",
    "",
    "    fun fetchUrl(",
    "        id: String,",
    "        url: String,",
    "        method: String,",
    "        headersJson: String,",
    "        bodyBase64: String?,",
    "    ) {",
    "        executor.execute {",
    "            executeFetch(id, url, method, headersJson, bodyBase64)",
    "        }",
    "    }",
    "",
    "    fun abortFetch(id: String) {",
    "        inFlightFetches.remove(id)?.cancel()",
    "    }",
    "",
    "    private fun executeFetch(",
    "        id: String,",
    "        urlStr: String,",
    "        methodStr: String,",
    "        headersJson: String,",
    "        bodyBase64: String?,",
    "    ) {",
    "        try {",
    "            val requestBody: RequestBody? = if (bodyBase64 != null) {",
    "                val bytes = Base64.decode(bodyBase64, Base64.DEFAULT)",
    "                val mediaType = " + JSON.stringify("application/octet-stream") + ".toMediaType()",
    "                bytes.toRequestBody(mediaType, 0, bytes.size)",
    "            } else null",
    "",
    "            val builder = Request.Builder().url(urlStr)",
    "            val method = methodStr.uppercase()",
    "            when {",
    "                method == " + JSON.stringify("GET") + " -> builder.get()",
    "                method == " + JSON.stringify("HEAD") + " -> builder.head()",
    "                requestBody != null -> builder.method(method, requestBody)",
    "                else -> builder.method(method, ByteArray(0).toRequestBody(null, 0, 0))",
    "            }",
    "",
    "            applyHeaders(builder, headersJson)",
    "",
    "            val call = client.newCall(builder.build())",
    "            inFlightFetches[id] = call",
    "            val response = call.execute()",
    "            val responseBody = response.body",
    "            val bytes = responseBody?.bytes() ?: ByteArray(0)",
    "            val bodyB64 = Base64.encodeToString(bytes, Base64.NO_WRAP)",
    "            val headerLines = response.headers.toMultimap().flatMap { (k, v) ->",
    "                v.map { k + " + JSON.stringify("\t") + " + it }",
    "            }.joinToString(" + JSON.stringify("\n") + ")",
    "            deliverFetchResult(",
    "                id = id,",
    "                ok = true,",
    "                status = response.code,",
    "                headers = headerLines,",
    "                bodyBase64 = bodyB64,",
    "                error = " + JSON.stringify("") + ",",
    "            )",
    "        } catch (e: Throwable) {",
    "            deliverFetchResult(",
    "                id = id,",
    "                ok = false,",
    "                status = 0,",
    "                headers = " + JSON.stringify("") + ",",
    "                bodyBase64 = " + JSON.stringify("") + ",",
    "                error = (e.message ?: e.javaClass.simpleName),",
    "            )",
    "        } finally {",
    "            inFlightFetches.remove(id)",
    "        }",
    "    }",
    "",
    "    private fun applyHeaders(builder: Request.Builder, headersJson: String) {",
    "        if (headersJson.isEmpty()) return",
    "        try {",
    "            val obj = JSONObject(headersJson)",
    "            val keys = obj.keys()",
    "            while (keys.hasNext()) {",
    "                val key = keys.next()",
    "                // OkHttp forbids these hop-by-hop / framing headers.",
    "                val lower = key.lowercase()",
    "                if (lower in setOf(" +
      JSON.stringify("host") +
      ", " +
      JSON.stringify("content-length") +
      ", " +
      JSON.stringify("connection") +
      ", " +
      JSON.stringify("transfer-encoding") +
      ", " +
      JSON.stringify("expect") +
      ")) continue",
    "                builder.header(key, obj.getString(key))",
    "            }",
    "        } catch (_: Throwable) {}",
    "    }",
    "",
    "    private fun deliverFetchResult(",
    "        id: String,",
    "        ok: Boolean,",
    "        status: Int,",
    "        headers: String,",
    "        bodyBase64: String,",
    "        error: String,",
    "    ) {",
    "        val webView = webViewRef?.get() ?: return",
    "        val evalId = ++evalIdCounter",
    "        val js = " +
      JSON.stringify("(function(){try{window.dispatchEvent(new CustomEvent('background-fetch-result',{detail:{id:") +
      " + jsString(id) + " +
      JSON.stringify(",ok:") +
      " + (if (ok) " +
      JSON.stringify("true") +
      " else " +
      JSON.stringify("false") +
      ") + " +
      JSON.stringify(",status:") +
      " + status + " +
      JSON.stringify(",headers:") +
      " + jsString(headers) + " +
      JSON.stringify(",bodyBase64:") +
      " + jsString(bodyBase64) + " +
      JSON.stringify(",error:") +
      " + jsString(error) + " +
      JSON.stringify("}}))}catch(e){}})()"),
    "        mainHandler.post { webView.evalScript(evalId, js) }",
    "    }",
    "",
    "    // --- Socket ---",
    "",
    "    fun connectSocket(id: String, url: String, optsJson: String) {",
    "        executor.execute {",
    "            try {",
    "                // Configure via reflection so we don't depend on",
    "                // the Kotlin compiler resolving the public fields of",
    "                // the socket.io-client's IO.Options class (which can",
    "                // vary between versions).",
    "                val opts = IO.Options()",
    "                try {",
    "                    opts.javaClass.getField(" + JSON.stringify("reconnection") + ").setBoolean(opts, true)",
    "                    opts.javaClass.getField(" +
      JSON.stringify("reconnectionAttempts") +
      ").setInt(opts, Int.MAX_VALUE)",
    "                    opts.javaClass.getField(" + JSON.stringify("reconnectionDelay") + ").setLong(opts, 1000L)",
    "                    opts.javaClass.getField(" + JSON.stringify("reconnectionDelayMax") + ").setLong(opts, 5000L)",
    "                    opts.javaClass.getField(" + JSON.stringify("timeout") + ").setLong(opts, 20_000L)",
    "                    // Force WebSocket-only transport. The polling",
    "                    // fallback creates new HTTP requests that Android",
    "                    // aggressively blocks when the app is backgrounded,",
    "                    // even with a foreground service. A persistent",
    "                    // WebSocket survives backgrounding much better.",
    "                    opts.javaClass.getField(" +
      JSON.stringify("transports") +
      ").set(opts, arrayOf(" +
      JSON.stringify("websocket") +
      "))",
    "                    // Tighter ping than the 25s/60s defaults so the",
    "                    // server's ping timeout doesn't fire on a single",
    "                    // missed ping while we're in Doze / throttled state.",
    "                    opts.javaClass.getField(" + JSON.stringify("pingInterval") + ").setInt(opts, 15_000)",
    "                    opts.javaClass.getField(" + JSON.stringify("pingTimeout") + ").setInt(opts, 10_000)",
    "                } catch (_: Throwable) {}",
    "                if (optsJson.isNotEmpty() && optsJson != " + JSON.stringify("{}") + ") {",
    "                    try {",
    "                        val custom = JSONObject(optsJson)",
    "                        val keys = custom.keys()",
    "                        while (keys.hasNext()) {",
    "                            val k = keys.next()",
    "                            val v = custom.opt(k)",
    "                            if (v != null) {",
    "                                when (k) {",
    "                                    " + JSON.stringify("auth") + ", " + JSON.stringify("query") + " -> {",
    "                                        val map = mutableMapOf<String, String>()",
    "                                        val obj = v as JSONObject",
    "                                        val ks = obj.keys()",
    "                                        while (ks.hasNext()) {",
    "                                            val mk = ks.next()",
    "                                            map[mk] = obj.opt(mk)?.toString() ?: " + JSON.stringify("") + "",
    "                                        }",
    "                                        try { opts.javaClass.getField(k).set(opts, map) } catch (_: Throwable) {}",
    "                                    }",
    "                                }",
    "                            }",
    "                        }",
    "                    } catch (_: Throwable) {}",
    "                }",
    "                val socket = IO.socket(URI.create(url), opts)",
    "                sockets[id] = socket",
    "                acquireWakeLock()",
    "                appContext?.get()?.let { VisttaService.socketOpened(it) }",
    "                socket.on(Socket.EVENT_CONNECT) { dispatchSocketEvent(id, " +
      JSON.stringify("connect") +
      ", emptyArray()) }",
    "                socket.on(Socket.EVENT_DISCONNECT) { args ->",
    "                    dispatchSocketEvent(id, " +
      JSON.stringify("disconnect") +
      ", arrayOf(args.firstOrNull()?.toString() ?: " +
      JSON.stringify("") +
      "))",
    "                }",
    "                socket.on(Socket.EVENT_CONNECT_ERROR) { args ->",
    "                    dispatchSocketEvent(id, " +
      JSON.stringify("connect_error") +
      ", arrayOf(args.firstOrNull()?.toString() ?: " +
      JSON.stringify("") +
      "))",
    "                }",
    // Socket.IO Java client v2.1 has no public "onAny" but
    // exposes Socket#onAnyIncoming(Listener), which fires for
    // every incoming event with the args as an array. The first
    // arg is the event name; the rest is the event payload.
    "                socket.onAnyIncoming { args ->",
    "                    if (args.isEmpty()) return@onAnyIncoming",
    "                    val name = args[0]?.toString() ?: " + JSON.stringify("") + "",
    "                    val rest = if (args.size > 1) args.copyOfRange(1, args.size) else emptyArray()",
    "                    dispatchSocketEvent(id, name, rest)",
    "                }",
    "                socket.connect()",
    "            } catch (e: Throwable) {",
    "                dispatchSocketEvent(id, " +
      JSON.stringify("connect_error") +
      ", arrayOf(e.message ?: e.javaClass.simpleName))",
    "            }",
    "        }",
    "    }",
    "",
    "    fun disconnectSocket(id: String) {",
    "        val s = sockets.remove(id) ?: return",
    "        try { s.disconnect() } catch (_: Throwable) {}",
    "        try { s.close() } catch (_: Throwable) {}",
    "        releaseWakeLock()",
    "        appContext?.get()?.let { VisttaService.socketClosed(it) }",
    "    }",
    "",
    "    fun emitSocket(id: String, name: String, argsJson: String) {",
    "        val s = sockets[id]",
    "        if (s == null || !s.connected()) {",
    "            dispatchSocketEvent(id, " + JSON.stringify("error") + ", arrayOf(" + JSON.stringify("not connected") + "))",
    "            return",
    "        }",
    "        try {",
    "            val args: Array<Any?> = if (argsJson.isEmpty() || argsJson == " + JSON.stringify("[]") + ") {",
    "                emptyArray()",
    "            } else {",
    "                val arr = JSONArray(argsJson)",
    "                Array(arr.length()) { i -> arr.opt(i) }",
    "            }",
    "            s.emit(name, *args)",
    "        } catch (e: Throwable) {",
    "            dispatchSocketEvent(id, " + JSON.stringify("error") + ", arrayOf(e.message ?: e.javaClass.simpleName))",
    "        }",
    "    }",
    "",
    "    private fun dispatchSocketEvent(id: String, name: String, args: Array<Any?>) {",
    "        val webView = webViewRef?.get() ?: return",
    "        val evalId = ++evalIdCounter",
    "        val argsJson = JSONArray().apply {",
    "            for (a in args) put(a ?: JSONObject.NULL)",
    "        }.toString()",
    "        val js = " +
      JSON.stringify("(function(){try{window.dispatchEvent(new CustomEvent('background-socket-event',{detail:{id:") +
      " + jsString(id) + " +
      JSON.stringify(",name:") +
      " + jsString(name) + " +
      JSON.stringify(",args:") +
      " + argsJson + " +
      JSON.stringify("}}))}catch(e){}})()"),
    "        mainHandler.post { webView.evalScript(evalId, js) }",
    "    }",
    "",
    "    fun shutdown() {",
    "        for ((_, s) in sockets) {",
    "            try { s.disconnect() } catch (_: Throwable) {}",
    "            try { s.close() } catch (_: Throwable) {}",
    "        }",
    "        sockets.clear()",
    "        for ((_, c) in inFlightFetches) {",
    "            try { c.cancel() } catch (_: Throwable) {}",
    "        }",
    "        inFlightFetches.clear()",
    "        releaseWakeLock(force = true)",
    "        webViewRef = null",
    "    }",
    "",
    "    // Ref-counted wake lock helpers. acquireWakeLock() bumps the count",
    "    // and lazily creates/holds the lock; releaseWakeLock() decrements",
    "    // and releases when the count hits zero (or unconditionally when",
    "    // `force = true`, used at shutdown).",
    "    private fun acquireWakeLock() {",
    "        val ctx = appContext?.get() ?: return",
    "        synchronized(wakeLockLock) {",
    "            wakeLockRefCount++",
    "            val current = wakeLock",
    "            if (current != null && current.isHeld) return",
    "            val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: run {",
    "                wakeLockRefCount--",
    "                return",
    "            }",
    "            val lock = pm.newWakeLock(",
    "                PowerManager.PARTIAL_WAKE_LOCK,",
    "                " + JSON.stringify("vistta:network") + ",",
    "            ).apply {",
    "                setReferenceCounted(false)",
    "            }",
    "            try {",
    "                lock.acquire(60 * 60 * 1000L) // 1 hour ceiling; we re-arm on each acquire",
    "                wakeLock = lock",
    "            } catch (_: Throwable) {",
    "                wakeLockRefCount--",
    "            }",
    "        }",
    "    }",
    "",
    "    private fun releaseWakeLock(force: Boolean = false) {",
    "        synchronized(wakeLockLock) {",
    "            if (force) wakeLockRefCount = 0 else if (wakeLockRefCount > 0) wakeLockRefCount--",
    "            if (wakeLockRefCount > 0) return",
    "            val lock = wakeLock ?: return",
    "            try { if (lock.isHeld) lock.release() } catch (_: Throwable) {}",
    "            wakeLock = null",
    "        }",
    "    }",
    "",
    "    private fun jsString(s: String): String {",
    "        val sb = StringBuilder(s.length + 2)",
    "        sb.append(" + JSON.stringify('"') + ")",
    "        var i = 0",
    "        val n = s.length",
    "        while (i < n) {",
    "            val c = s[i]",
    "            val code = c.code",
    "            when (code) {",
    "                34 -> sb.append(" + JSON.stringify('\\"') + ")",
    "                92 -> sb.append(" + JSON.stringify("\\\\") + ")",
    "                10 -> sb.append(" + JSON.stringify("\\n") + ")",
    "                13 -> sb.append(" + JSON.stringify("\\r") + ")",
    "                9 -> sb.append(" + JSON.stringify("\\t") + ")",
    "                8 -> sb.append(" + JSON.stringify("\\b") + ")",
    "                12 -> sb.append(" + JSON.stringify("\\f") + ")",
    "                else -> if (code < 32) sb.append(" + JSON.stringify("\\u%04x") + ".format(code)) else sb.append(c)",
    "            }",
    "            i++",
    "        }",
    "        sb.append(" + JSON.stringify('"') + ")",
    "        return sb.toString()",
    "    }",
    "}",
    "",
  ];
  const content = lines.join("\n");
  await writeIfChanged(networkPath, content);
}

/**
 * Adds the runtime-owned permissions to AndroidManifest.xml. The set is
 * deliberately small — just notification and haptics primitives. Tauri
 * auto-emits `INTERNET` and a few other framework permissions; we
 * idempotently insert ours after the existing `INTERNET` line, or before
 * `<application>` if it isn't present.
 */
export async function patchAndroidManifest(targetDir, config) {
  const manifestPath = fs.resolve(targetDir, "gen", "android", "app", "src", "main", "AndroidManifest.xml");
  if (!fs.existsSync(manifestPath)) return;
  let content = String(await fs.readFile(manifestPath, "utf8"));

  const perms = ["android.permission.POST_NOTIFICATIONS", "android.permission.VIBRATE", "android.permission.WAKE_LOCK"];
  const permsBlock = perms.map((p) => `    <uses-permission android:name="${p}" />`).join("\n");

  content = ensurePermissions(content, permsBlock);

  // Foreground-service declarations. Always emitted so the manifest is
  // complete on the first build (the service is only started when
  // setBackgroundInterval is called from JS, but the declarations must
  // exist before the manifest is processed). `FOREGROUND_SERVICE_DATA_SYNC`
  // is the right type for "running a periodic JS task while the app is
  // backgrounded" — it doesn't require a user-visible media notification
  // and is allowed to run as long as the data sync is ongoing.
  const appId = resolveAppId(config);
  const serviceClass = `${appId}.VisttaService`;
  const serviceBlock = [
    `    <service`,
    `        android:name="${serviceClass}"`,
    `        android:exported="false"`,
    `        android:foregroundServiceType="dataSync" />`,
  ].join("\n");
  const servicePermsBlock = [
    `    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />`,
    `    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />`,
  ].join("\n");

  content = ensureBlock(content, SERVICE_PERMS, servicePermsBlock, (c, generated) =>
    c.replace(/(<uses-permission android:name="android\.permission\.INTERNET"\s*\/>)/, `$1\n${generated}`),
  );
  content = ensureBlock(content, SERVICE, serviceBlock, (c, generated) =>
    c.replace(/(<\/application>)/, `${generated}\n$1`),
  );

  await writeIfChanged(manifestPath, content);
}

/**
 * Idempotently inserts the given `<uses-permission .../>` lines into the
 * manifest. Each line is checked independently so a half-applied state
 * (one perm present, one missing) converges on the next run.
 *
 * The expected manifest structure (Tauri's default) is:
 *   <manifest ...>
 *     <uses-permission android:name="android.permission.INTERNET" />
 *     ...
 *     <application ...>
 * We look for `INTERNET` first and insert after it; otherwise we fall back
 * to inserting before `<application>`.
 */
function ensurePermissions(content, block) {
  const lines = block.split("\n");
  let working = content;
  for (const line of lines) {
    const permName = line.match(/android:name="(.*?)"/)?.[1];
    if (!permName) continue;
    const existing = new RegExp(`<uses-permission[^>]*android:name="${permName.replace(/\./g, "\\.")}"[^>]*/>`);
    if (existing.test(working)) continue;
    if (/<uses-permission android:name="android\.permission\.INTERNET"\s*\/>/.test(working)) {
      working = working.replace(/(<uses-permission android:name="android\.permission\.INTERNET"\s*\/>)/, `$1\n${line}`);
    } else {
      working = working.replace(/(<application\b)/, `${line}\n    $1`);
    }
  }
  return working;
}

/**
 * Tauri generates `res/values/strings.xml` once on `tauri android init` and
 * never touches it again — so the launcher label (`@string/app_name`) and
 * the in-app title (`@string/main_activity_title`) keep whatever was baked
 * in at init time, even when `productName` in `tauri.conf.json` is later
 * updated.
 *
 * Brings the two strings back in sync with the runtime's source of truth
 * (`config.app.name` + the shared `devSuffix`). Idempotent; toggling
 * between dev and release switches the suffix in both directions on the
 * next build.
 *
 * Only touches the default-locale file the manifest's `android:label`
 * references; localisation files (e.g. `res/values-pt/strings.xml`) are
 * left untouched.
 */
export async function patchAndroidStrings(targetDir, config) {
  const stringsPath = fs.resolve(targetDir, "gen", "android", "app", "src", "main", "res", "values", "strings.xml");
  if (!fs.existsSync(stringsPath)) return;
  const appName = config?.app?.name || config?.title || "Vistta App";
  const suffix = devSuffix();

  let content = String(await fs.readFile(stringsPath, "utf8"));
  for (const name of ["app_name", "main_activity_title"]) {
    const re = new RegExp(`(<string\\s+name="${name}"\\s*>)([^<]*)(</string>)`);
    const replacement = `$1${appName}${suffix}$3`;
    if (re.test(content)) {
      content = content.replace(re, replacement);
    } else {
      content = ensureBlock(content, STRINGS, `    <string name="${name}">${appName}${suffix}</string>`, (c, generated) =>
        c.replace(/(<\/resources>)/, `${generated}\n$1`),
      );
    }
  }

  await writeIfChanged(stringsPath, content);
}

/**
 * Patches MainActivity.kt to create a default notification channel suitable
 * for Tauri's notification plugin. The channel is wrapped between markers
 * so it can be cleanly replaced if the app name changes.
 */
export async function patchMainActivity(targetDir, config) {
  const appId = resolveAppId(config);
  const appName = config?.app?.name || "Vistta App";
  const packagePath = appId.replace(/\./g, "/");
  const activityPath = fs.resolve(targetDir, "gen", "android", "app", "src", "main", "java", packagePath, "MainActivity.kt");
  if (!fs.existsSync(activityPath)) return;

  const imports = [
    "import android.app.NotificationChannel",
    "import android.app.NotificationManager",
    "import android.content.Context",
    "import android.os.Build",
  ].join("\n");

  const body = [
    `    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {`,
    `      val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager`,
    `      if (mgr.getNotificationChannel("default") == null) {`,
    `        mgr.createNotificationChannel(NotificationChannel("default", ${JSON.stringify(appName)}, NotificationManager.IMPORTANCE_DEFAULT))`,
    `      }`,
    `    }`,
  ].join("\n");

  // Hook that publishes the webview to VisttaService so scheduler ticks
  // can be eval'd into JS even when the activity is paused. Public in
  // WryActivity; safe to override.
  //
  // Also registers a `VisttaScheduler` JavascriptInterface so JS can
  // start/stop timers without going through a Tauri command. The bridge
  // is a thin wrapper that constructs Intents and calls
  // startForegroundService — the actual work happens in VisttaService.
  const webviewImports = ["import android.webkit.JavascriptInterface", "import android.content.Intent"].join("\n");

  const webviewBridge = [
    `    private val visttaSchedulerBridge = object {`,
    `      @JavascriptInterface`,
    `      fun registerTimer(id: String, intervalMs: Double) {`,
    `        VisttaService.registerTimer(this@MainActivity, id, intervalMs.toLong())`,
    `      }`,
    ``,
    `      @JavascriptInterface`,
    `      fun clearTimer(id: String) {`,
    `        VisttaService.clearTimer(this@MainActivity, id)`,
    `      }`,
    ``,
    `      @JavascriptInterface`,
    `      fun stopIfEmpty() {`,
    `        VisttaService.stopIfEmpty(this@MainActivity)`,
    `      }`,
    ``,
    `      // Delegate a fetch to the foreground service so it can complete`,
    `      // while the activity is paused. The service runs the request on a`,
    `      // background thread and dispatches the result back into the webview`,
    `      // via evalScript.`,
    `      @JavascriptInterface`,
    `      fun fetchUrl(id: String, url: String, method: String, headersJson: String, bodyBase64: String?) {`,
    `        VisttaService.fetchUrl(this@MainActivity, id, url, method, headersJson, bodyBase64)`,
    `      }`,
    ``,
    `      @JavascriptInterface`,
    `      fun abortFetch(id: String) {`,
    `        VisttaService.abortFetch(id)`,
    `      }`,
    `    }`,
    `    private val visttaFetchBridge = object {`,
    `      @JavascriptInterface`,
    `      fun fetchUrl(id: String, url: String, method: String, headersJson: String, bodyBase64: String?) {`,
    `        VisttaNetwork.fetchUrl(id, url, method, headersJson, bodyBase64)`,
    `      }`,
    `      @JavascriptInterface`,
    `      fun abortFetch(id: String) {`,
    `        VisttaNetwork.abortFetch(id)`,
    `      }`,
    `    }`,
    `    private val visttaSocketBridge = object {`,
    `      @JavascriptInterface`,
    `      fun connect(id: String, url: String, optsJson: String) {`,
    `        VisttaNetwork.connectSocket(id, url, optsJson)`,
    `      }`,
    `      @JavascriptInterface`,
    `      fun disconnect(id: String) {`,
    `        VisttaNetwork.disconnectSocket(id)`,
    `      }`,
    `      @JavascriptInterface`,
    `      fun emit(id: String, name: String, argsJson: String) {`,
    `        VisttaNetwork.emitSocket(id, name, argsJson)`,
    `      }`,
    `    }`,
  ].join("\n");

  const webviewBody = [
    `  override fun onWebViewCreate(webView: android.webkit.WebView) {`,
    `    super.onWebViewCreate(webView)`,
    `    val rw = webView as RustWebView`,
    `    VisttaService.attachWebView(rw)`,
    `    VisttaNetwork.attachWebView(rw)`,
    `    VisttaNetwork.attachContext(this@MainActivity)`,
    `    rw.addJavascriptInterface(visttaSchedulerBridge, "VisttaScheduler")`,
    `    rw.addJavascriptInterface(visttaFetchBridge, "VisttaFetch")`,
    `    rw.addJavascriptInterface(visttaSocketBridge, "VisttaSocket")`,
    `  }`,
  ].join("\n");

  // Combine imports — the existing import marker is replaced wholesale
  // when the activity is patched (we control the full block). We add
  // our webview imports to the existing notification-channel imports.
  const combinedImports = `${imports}\n${webviewImports}`;

  let content = String(await fs.readFile(activityPath, "utf8"));
  content = ensureBlockLines(content, ACTIVITY_IMPORTS, combinedImports, (c, generated) =>
    c.replace(/(import\s+[^\n]+\n)/, `$1${generated}\n`),
  );
  content = ensureBlockLines(content, ACTIVITY, body, (c, generated) =>
    c.replace(/(super\.onCreate\(savedInstanceState\)\s*\n)/, `$1${generated}\n`),
  );
  // Insert the bridge object as a class-level field, immediately after
  // the existing class opener. The webview override goes at the end
  // (same place as before).
  content = ensureBlockLines(content, ACTIVITY_WEBVIEW_BRIDGE, webviewBridge, (c, generated) =>
    c.replace(/(class\s+MainActivity[^{]*\{\s*\n)/, `$1${generated}\n`),
  );
  content = ensureBlockLines(content, ACTIVITY_WEBVIEW, webviewBody, (c, generated) =>
    c.replace(/(\n}\s*)$/, `\n${generated}\n$1`),
  );

  await writeIfChanged(activityPath, content);
}

/**
 * Writes `VisttaService.kt` in full. The runtime owns this class end-to-end;
 * the activity calls `VisttaService.attachWebView(...)` from `onWebViewCreate`
 * so the service can `evalScript(...)` ticks into JS even when the activity
 * is paused but the process is still alive (the foreground service keeps
 * the process + webview alive when the user backgrounds the app).
 *
 * Public surface used by JS via custom Tauri commands (or directly from
 * a synthesized plugin class if/when we add one):
 *
 *   startForegroundService(context)   — bring the service up; required
 *                                       before any timer can tick.
 *   registerTimer(id, intervalMs)     — schedule a recurring tick for
 *                                       `id` every `intervalMs` ms.
 *   clearTimer(id)                    — cancel a single timer.
 *   stopService()                     — stop the service if no timers
 *                                       are active.
 *
 * The service is the only place that holds the `RustWebView` reference
 * (weak, to avoid leaking the webview through service lifecycle). When
 * the last timer is cleared the service calls `stopSelf()` so no
 * notification remains.
 */
export async function patchVisttaService(targetDir, config) {
  const appId = resolveAppId(config);
  const packagePath = appId.replace(/\./g, "/");
  const servicePath = fs.resolve(targetDir, "gen", "android", "app", "src", "main", "java", packagePath, "VisttaService.kt");
  await fs.mkdir(fs.dirname(servicePath), { recursive: true });
  const appName = config?.app?.name || "Vistta App";
  // Kotlin escape-sequence builders. Using fromCharCode keeps the JS
  // template literal from collapsing "\\n" into a real newline, which
  // would break the Kotlin source.
  const B = String.fromCharCode(0x5c); // backslash
  const KNL = B + "n";
  const KT = B + "t";
  const KR = B + "r";
  const KQ = B + String.fromCharCode(0x22);
  const KBB = B + B;
  const lines = [
    "// Generated by @vistta/js-runtime. Do not edit by hand.",
    "package " + appId,
    "",
    "import android.app.Notification",
    "import android.app.NotificationChannel",
    "import android.app.NotificationManager",
    "import android.app.Service",
    "import android.content.Context",
    "import android.content.Intent",
    "import android.content.pm.ServiceInfo",
    "import android.os.Build",
    "import android.os.Handler",
    "import android.os.IBinder",
    "import android.os.Looper",
    "import android.util.Base64",
    "import androidx.core.app.NotificationCompat",
    "import java.lang.ref.WeakReference",
    "import java.net.HttpURLConnection",
    "import java.net.URL",
    "import java.util.concurrent.ConcurrentHashMap",
    "import java.util.concurrent.Executors",
    "import org.json.JSONObject",
    "",
    "/**",
    " * Foreground service that holds the process + webview alive so that",
    " * setBackgroundInterval callbacks continue to fire when the user",
    " * backgrounds the app, locks the device, or switches to another app.",
    " *",
    " * Started by JS via @vistta/js-runtime/scheduler when the first timer",
    " * is registered. Stops itself when the last timer is cleared.",
    " *",
    " * Ticks are delivered by [evalScript] into the webview, which fires a",
    " * 'scheduler-tick' CustomEvent on window. The runtime's scheduler.js",
    " * listener dispatches to the right callback.",
    " *",
    " * Also performs HTTP requests on behalf of the scheduler's fetch",
    " * override so that fetch() calls made from inside a scheduler-tick",
    " * callback complete while the activity is paused. Results are",
    " * delivered back to the webview via evalScript, which dispatches a",
    " * 'background-fetch-result' CustomEvent.",
    " */",
    "class VisttaService : Service() {",
    "    companion object {",
    "        private const val NOTIF_CHANNEL_ID = " + JSON.stringify("vistta_scheduler"),
    "        private const val NOTIF_ID = 1001",
    "        private const val ACTION_REGISTER = " + JSON.stringify("vistta.REGISTER_TIMER"),
    "        private const val ACTION_CLEAR = " + JSON.stringify("vistta.CLEAR_TIMER"),
    "        private const val ACTION_STOP_IF_EMPTY = " + JSON.stringify("vistta.STOP_IF_EMPTY"),
    "        private const val ACTION_SOCKET_OPENED = " + JSON.stringify("vistta.SOCKET_OPENED"),
    "        private const val ACTION_SOCKET_CLOSED = " + JSON.stringify("vistta.SOCKET_CLOSED"),
    "        const val EXTRA_ID = " + JSON.stringify("id"),
    "        const val EXTRA_INTERVAL_MS = " + JSON.stringify("intervalMs"),
    "",
    "        @Volatile",
    "        private var webViewRef: WeakReference<RustWebView>? = null",
    "",
    "        @Volatile",
    "        private var instance: VisttaService? = null",
    "",
    "        // Number of currently-open background sockets. Used by the",
    "        // service's stopSelf check so the foreground service (and the",
    "        // dataSync priority it grants) stay alive as long as any socket",
    "        // is open, even when no timers are registered. Without this the",
    "        // activity/webview can be reclaimed by the OS a few minutes after",
    "        // the app is backgrounded, and the webview reference in",
    "        // VisttaNetwork goes null — silently dropping all socket events.",
    "        @Volatile",
    "        private var socketCount: Int = 0",
    "",
    "        private val mainHandler = Handler(Looper.getMainLooper())",
    "        private val timers = mutableMapOf<String, Runnable>()",
    "        private var evalIdCounter = 0",
    "",
    "        // Pool for in-flight HTTP requests. Created lazily so the",
    "        // service does not hold threads while idle.",
    "        private val fetchExecutor = Executors.newCachedThreadPool { r ->",
    "            Thread(r, " + JSON.stringify("vistta-fetch") + ").apply { isDaemon = true }",
    "        }",
    "        private val inFlightFetches = ConcurrentHashMap<String, HttpURLConnection>()",
    "",
    "        fun attachWebView(webView: RustWebView) {",
    "            webViewRef = WeakReference(webView)",
    "        }",
    "",
    "        fun registerTimer(context: Context, id: String, intervalMs: Long) {",
    "            val intent = Intent(context, VisttaService::class.java).setAction(ACTION_REGISTER)",
    "                .putExtra(EXTRA_ID, id)",
    "                .putExtra(EXTRA_INTERVAL_MS, intervalMs)",
    "            context.startForegroundService(intent)",
    "        }",
    "",
    "        fun clearTimer(context: Context, id: String) {",
    "            val intent = Intent(context, VisttaService::class.java).setAction(ACTION_CLEAR)",
    "                .putExtra(EXTRA_ID, id)",
    "            context.startService(intent)",
    "        }",
    "",
    "        fun stopIfEmpty(context: Context) {",
    "            val intent = Intent(context, VisttaService::class.java).setAction(ACTION_STOP_IF_EMPTY)",
    "            context.startService(intent)",
    "        }",
    "",
    "        /**",
    "         * Called by VisttaNetwork when a background socket is opened.",
    "         * Starts the foreground service (which gives the process the",
    "         * dataSync priority so the activity/webview stay alive in the",
    "         * background). Increments the socket counter used by the",
    "         * service's stopSelf check.",
    "         */",
    "        fun socketOpened(context: Context) {",
    "            val intent = Intent(context, VisttaService::class.java).setAction(ACTION_SOCKET_OPENED)",
    "            try {",
    "                context.startForegroundService(intent)",
    "            } catch (_: Throwable) {",
    "                // No permission / already running; best-effort.",
    "            }",
    "        }",
    "",
    "        /**",
    "         * Called by VisttaNetwork when a background socket is closed.",
    "         * Decrements the socket counter; the service stops itself if no",
    "         * timers, in-flight fetches, or sockets remain.",
    "         */",
    "        fun socketClosed(context: Context) {",
    "            val intent = Intent(context, VisttaService::class.java).setAction(ACTION_SOCKET_CLOSED)",
    "            try { context.startService(intent) } catch (_: Throwable) {}",
    "        }",
    "",
    "        /**",
    "         * Kick off an HTTP request on a service-owned thread. The result",
    "         * is delivered into the webview via evalScript, which dispatches",
    "         * a 'background-fetch-result' CustomEvent. The id is allocated",
    "         * by the JS side so it can be cross-referenced with a stashed",
    "         * Promise.",
    "         */",
    "        fun fetchUrl(",
    "            context: Context,",
    "            id: String,",
    "            url: String,",
    "            method: String,",
    "            headersJson: String,",
    "            bodyBase64: String?,",
    "        ) {",
    "            val startIntent = Intent(context, VisttaService::class.java)",
    "            try {",
    "                context.startForegroundService(startIntent)",
    "            } catch (_: Throwable) {",
    "                // Already running or no permission; best-effort.",
    "            }",
    "            fetchExecutor.execute {",
    "                executeFetch(id, url, method, headersJson, bodyBase64)",
    "            }",
    "        }",
    "",
    "        fun abortFetch(id: String) {",
    "            inFlightFetches.remove(id)?.let { conn ->",
    "                try { conn.disconnect() } catch (_: Throwable) {}",
    "            }",
    "        }",
    "",
    "        private fun executeFetch(",
    "            id: String,",
    "            urlStr: String,",
    "            methodStr: String,",
    "            headersJson: String,",
    "            bodyBase64: String?,",
    "        ) {",
    "            var conn: HttpURLConnection? = null",
    "            try {",
    "                val url = URL(urlStr)",
    "                conn = (url.openConnection() as HttpURLConnection).apply {",
    "                    requestMethod = methodStr.uppercase()",
    "                    connectTimeout = 15_000",
    "                    readTimeout = 30_000",
    "                    instanceFollowRedirects = true",
    "                }",
    "                applyHeaders(conn, headersJson)",
    "                if (bodyBase64 != null) {",
    "                    val decoded = Base64.decode(bodyBase64, Base64.DEFAULT)",
    "                    conn.doOutput = true",
    "                    conn.setFixedLengthStreamingMode(decoded.size)",
    "                    conn.outputStream.use { it.write(decoded) }",
    "                }",
    "                inFlightFetches[id] = conn",
    "                val status = conn.responseCode",
    "                val stream = if (status in 200..299) conn.inputStream else conn.errorStream",
    "                val bodyB64 = if (stream != null) {",
    "                    Base64.encodeToString(stream.readBytes(), Base64.NO_WRAP)",
    "                } else " + JSON.stringify(""),
    "                val headerLines = conn.headerFields.flatMap { (k, v) ->",
    "                    if (k == null) emptyList() else v.map { k + " + JSON.stringify("\t") + " + it }",
    "                }.joinToString(" + JSON.stringify("\n") + ")",
    "                deliverResult(id, ok = true, status = status, headers = headerLines, bodyBase64 = bodyB64, error = " +
      JSON.stringify("") +
      ")",
    "            } catch (e: Throwable) {",
    "                deliverResult(id, ok = false, status = 0, headers = " +
      JSON.stringify("") +
      ", bodyBase64 = " +
      JSON.stringify("") +
      ", error = e.javaClass.simpleName + " +
      JSON.stringify(": ") +
      " + (e.message ?: " +
      JSON.stringify("") +
      "))",
    "            } finally {",
    "                inFlightFetches.remove(id)",
    "                conn?.disconnect()",
    "            }",
    "        }",
    "",
    "        private fun applyHeaders(conn: HttpURLConnection, headersJson: String) {",
    "            if (headersJson.isEmpty()) return",
    "            try {",
    "                val obj = JSONObject(headersJson)",
    "                val keys = obj.keys()",
    "                while (keys.hasNext()) {",
    "                    val key = keys.next()",
    "                    val lower = key.lowercase()",
    "                    if (lower != " +
      JSON.stringify("host") +
      " && lower != " +
      JSON.stringify("content-length") +
      " && lower != " +
      JSON.stringify("connection") +
      " &&",
    "                        lower != " +
      JSON.stringify("transfer-encoding") +
      " && lower != " +
      JSON.stringify("expect") +
      "",
    "                    ) {",
    "                        try { conn.setRequestProperty(key, obj.getString(key)) } catch (_: Throwable) {}",
    "                    }",
    "                }",
    "            } catch (_: Throwable) {}",
    "        }",
    "",
    "        private fun deliverResult(",
    "            id: String,",
    "            ok: Boolean,",
    "            status: Int,",
    "            headers: String,",
    "            bodyBase64: String,",
    "            error: String,",
    "        ) {",
    "            val webView = webViewRef?.get()",
    "            if (webView == null) return",
    "            val evalId = ++evalIdCounter",
    "            val js = (",
    "                " +
      JSON.stringify("(function(){try{var d={id:") +
      " + jsString(id) + " +
      JSON.stringify(",ok:") +
      " + (if (ok) " +
      JSON.stringify("true") +
      " else " +
      JSON.stringify("false") +
      ") + " +
      JSON.stringify(",status:") +
      " + status + " +
      JSON.stringify(",headers:") +
      " + jsString(headers) + " +
      JSON.stringify(",bodyBase64:") +
      " + jsString(bodyBase64) + " +
      JSON.stringify(",error:") +
      " + jsString(error) + " +
      JSON.stringify("};window.dispatchEvent(new CustomEvent('background-fetch-result',{detail:d}))}catch(e){}})()"),
    "            )",
    "            // evalScript must run on the main thread; deliverResult is",
    "            // called from fetchExecutor (background thread).",
    "            mainHandler.post { webView.evalScript(evalId, js) }",
    "        }",
    "",
    "        private fun jsString(s: String): String {",
    "            val sb = StringBuilder(s.length + 2)",
    "            sb.append(" + JSON.stringify('"') + ")",
    "            var i = 0",
    "            val n = s.length",
    "            while (i < n) {",
    "                val c = s[i]",
    "                val code = c.code",
    "                when (code) {",
    "                    34 -> sb.append(" + JSON.stringify('\\"') + ")",
    "                    92 -> sb.append(" + JSON.stringify("\\\\") + ")",
    "                    10 -> sb.append(" + JSON.stringify("\\n") + ")",
    "                    13 -> sb.append(" + JSON.stringify("\\r") + ")",
    "                    9 -> sb.append(" + JSON.stringify("\\t") + ")",
    "                    8 -> sb.append(" + JSON.stringify("\\b") + ")",
    "                    12 -> sb.append(" + JSON.stringify("\\f") + ")",
    "                    else -> if (code < 32) sb.append(" + JSON.stringify("\\u%04x") + ".format(code)) else sb.append(c)",
    "                }",
    "                i++",
    "            }",
    "            sb.append(" + JSON.stringify('"') + ")",
    "            return sb.toString()",
    "        }",
    "    }",
    "",
    "    override fun onBind(intent: Intent?): IBinder? = null",
    "",
    "    override fun onCreate() {",
    "        super.onCreate()",
    "        instance = this",
    "        ensureNotificationChannel()",
    "    }",
    "",
    "    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {",
    "        startForegroundCompat()",
    "        when (intent?.action) {",
    "            ACTION_REGISTER -> {",
    "                val id = intent.getStringExtra(EXTRA_ID) ?: return START_NOT_STICKY",
    "                val intervalMs = intent.getLongExtra(EXTRA_INTERVAL_MS, 60_000L)",
    "                scheduleTimer(id, intervalMs)",
    "            }",
    "            ACTION_CLEAR -> {",
    "                val id = intent.getStringExtra(EXTRA_ID) ?: return START_NOT_STICKY",
    "                cancelTimer(id)",
    "                if (timers.isEmpty() && inFlightFetches.isEmpty() && socketCount == 0) stopSelf()",
    "            }",
    "            ACTION_STOP_IF_EMPTY -> {",
    "                if (timers.isEmpty() && inFlightFetches.isEmpty() && socketCount == 0) stopSelf()",
    "            }",
    "            ACTION_SOCKET_OPENED -> {",
    "                socketCount++",
    "            }",
    "            ACTION_SOCKET_CLOSED -> {",
    "                if (socketCount > 0) socketCount--",
    "                if (timers.isEmpty() && inFlightFetches.isEmpty() && socketCount == 0) stopSelf()",
    "            }",
    "        }",
    "        return START_STICKY",
    "    }",
    "",
    "    private fun scheduleTimer(id: String, intervalMs: Long) {",
    "        timers[id]?.let { mainHandler.removeCallbacks(it) }",
    "        val runnable = object : Runnable {",
    "            override fun run() {",
    "                fireTick(id)",
    "                mainHandler.postDelayed(this, intervalMs)",
    "            }",
    "        }",
    "        timers[id] = runnable",
    "        mainHandler.postDelayed(runnable, intervalMs)",
    "    }",
    "",
    "    private fun cancelTimer(id: String) {",
    "        timers.remove(id)?.let { mainHandler.removeCallbacks(it) }",
    "    }",
    "",
    "    private fun fireTick(id: String) {",
    "        val webView = webViewRef?.get() ?: return",
    "        val evalId = ++evalIdCounter",
    "        val js = " +
      JSON.stringify("window.dispatchEvent(new CustomEvent('scheduler-tick', { detail: { id: '") +
      " + id + " +
      JSON.stringify("' } }))"),
    "        webView.evalScript(evalId, js)",
    "    }",
    "",
    "    private fun ensureNotificationChannel() {",
    "        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {",
    "            val mgr = getSystemService(NotificationManager::class.java)",
    "            if (mgr.getNotificationChannel(NOTIF_CHANNEL_ID) == null) {",
    "                val channel = NotificationChannel(",
    "                    NOTIF_CHANNEL_ID,",
    "                    " + JSON.stringify("Background sync") + ",",
    "                    NotificationManager.IMPORTANCE_LOW,",
    "                ).apply { setShowBadge(false) }",
    "                mgr.createNotificationChannel(channel)",
    "            }",
    "        }",
    "    }",
    "",
    "    private fun startForegroundCompat() {",
    "        val notif = NotificationCompat.Builder(this, NOTIF_CHANNEL_ID)",
    "            .setContentTitle(" + JSON.stringify(appName) + ")",
    "            .setContentText(" + JSON.stringify("Background sync active") + ")",
    "            .setSmallIcon(android.R.drawable.stat_notify_sync)",
    "            .setOngoing(true)",
    "            .setPriority(NotificationCompat.PRIORITY_LOW)",
    "            .build()",
    "        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {",
    "            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)",
    "        } else {",
    "            startForeground(NOTIF_ID, notif)",
    "        }",
    "    }",
    "",
    "    override fun onDestroy() {",
    "        timers.values.forEach { mainHandler.removeCallbacks(it) }",
    "        timers.clear()",
    "        inFlightFetches.values.forEach { try { it.disconnect() } catch (_: Throwable) {} }",
    "        inFlightFetches.clear()",
    "        webViewRef = null",
    "        instance = null",
    "        VisttaNetwork.shutdown()",
    "        super.onDestroy()",
    "    }",
    "}",
    "",
  ];
  // Suppress unused-binding warnings for the K* constants above; the
  // builder is defined here so future code can introduce Kotlin-side
  // constants without re-deriving fromCharCode sequences.
  void KNL;
  void KT;
  void KR;
  void KQ;
  void KBB;
  const content = lines.join("\n");
  await writeIfChanged(servicePath, content);
}

/**
 * Idempotently inserts/updates a marker-delimited block in `content`.
 * If the markers are absent, `insertFallback(content, generatedBlock)` is
 * invoked once to place the block; subsequent runs re-use the markers.
 */
function ensureBlock(content, marker, body, insertFallback) {
  const generated = body ? `${marker.begin}\n${body}\n${marker.end}` : `${marker.begin}\n${marker.end}`;
  const re = new RegExp(`${escapeRe(marker.begin)}[\\s\\S]*?${escapeRe(marker.end)}`);
  if (re.test(content)) return content.replace(re, generated);
  return insertFallback(content, generated);
}

// Same as ensureBlock but uses `//`-style line markers (suitable for Kotlin).
function ensureBlockLines(content, marker, body, insertFallback) {
  const generated = body ? `${marker.begin}\n${body}\n${marker.end}` : `${marker.begin}\n${marker.end}`;
  const re = new RegExp(`${escapeRe(marker.begin)}[\\s\\S]*?${escapeRe(marker.end)}`);
  if (re.test(content)) return content.replace(re, generated);
  return insertFallback(content, generated);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
