import fs from "@vistta/fs";
import { devSuffix, resolveAppId, writeIfChanged } from "../utils/index.js";

const STRINGS = { begin: "<!-- vistta:strings:begin -->", end: "<!-- vistta:strings:end -->" };
const ACTIVITY = { begin: "// vistta:activity:begin", end: "// vistta:activity:end" };
const ACTIVITY_IMPORTS = { begin: "// vistta:activity-imports:begin", end: "// vistta:activity-imports:end" };
const ACTIVITY_WEBVIEW = { begin: "// vistta:webview:begin", end: "// vistta:webview:end" };
const ACTIVITY_WEBVIEW_BRIDGE = { begin: "// vistta:webview-bridge:begin", end: "// vistta:webview-bridge:end" };
const SERVICE = { begin: "<!-- vistta:service:begin -->", end: "<!-- vistta:service:end -->" };
const SERVICE_PERMS = { begin: "<!-- vistta:service-perms:begin -->", end: "<!-- vistta:service-perms:end -->" };

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

  const perms = ["android.permission.POST_NOTIFICATIONS", "android.permission.VIBRATE"];
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
    `    }`,
  ].join("\n");

  const webviewBody = [
    `  override fun onWebViewCreate(webView: android.webkit.WebView) {`,
    `    super.onWebViewCreate(webView)`,
    `    val rw = webView as RustWebView`,
    `    VisttaService.attachWebView(rw)`,
    `    rw.addJavascriptInterface(visttaSchedulerBridge, "VisttaScheduler")`,
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
  const content = `// Generated by @vistta/js-runtime. Do not edit by hand.
package ${appId}

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import java.lang.ref.WeakReference

/**
 * Foreground service that holds the process + webview alive so that
 * setBackgroundInterval callbacks continue to fire when the user
 * backgrounds the app, locks the device, or switches to another app.
 *
 * Started by JS via @vistta/js-runtime/scheduler when the first timer
 * is registered. Stops itself when the last timer is cleared.
 *
 * Ticks are delivered by [evalScript] into the webview, which fires a
 * 'scheduler-tick' CustomEvent on window. The runtime's scheduler.js
 * listener dispatches to the right callback.
 */
class VisttaService : Service() {
    companion object {
        private const val NOTIF_CHANNEL_ID = "vistta_scheduler"
        private const val NOTIF_ID = 1001
        private const val ACTION_REGISTER = "vistta.REGISTER_TIMER"
        private const val ACTION_CLEAR = "vistta.CLEAR_TIMER"
        private const val ACTION_STOP_IF_EMPTY = "vistta.STOP_IF_EMPTY"
        const val EXTRA_ID = "id"
        const val EXTRA_INTERVAL_MS = "intervalMs"

        @Volatile
        private var webViewRef: WeakReference<RustWebView>? = null

        @Volatile
        private var instance: VisttaService? = null

        private val mainHandler = Handler(Looper.getMainLooper())
        private val timers = mutableMapOf<String, Runnable>()
        private var evalIdCounter = 0

        fun attachWebView(webView: RustWebView) {
            webViewRef = WeakReference(webView)
        }

        fun registerTimer(context: Context, id: String, intervalMs: Long) {
            val intent = Intent(context, VisttaService::class.java).setAction(ACTION_REGISTER)
                .putExtra(EXTRA_ID, id)
                .putExtra(EXTRA_INTERVAL_MS, intervalMs)
            context.startForegroundService(intent)
        }

        fun clearTimer(context: Context, id: String) {
            val intent = Intent(context, VisttaService::class.java).setAction(ACTION_CLEAR)
                .putExtra(EXTRA_ID, id)
            context.startService(intent)
        }

        fun stopIfEmpty(context: Context) {
            val intent = Intent(context, VisttaService::class.java).setAction(ACTION_STOP_IF_EMPTY)
            context.startService(intent)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        ensureNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundCompat()
        when (intent?.action) {
            ACTION_REGISTER -> {
                val id = intent.getStringExtra(EXTRA_ID) ?: return START_NOT_STICKY
                val intervalMs = intent.getLongExtra(EXTRA_INTERVAL_MS, 60_000L)
                scheduleTimer(id, intervalMs)
            }
            ACTION_CLEAR -> {
                val id = intent.getStringExtra(EXTRA_ID) ?: return START_NOT_STICKY
                cancelTimer(id)
                if (timers.isEmpty()) stopSelf()
            }
            ACTION_STOP_IF_EMPTY -> {
                if (timers.isEmpty()) stopSelf()
            }
        }
        return START_STICKY
    }

    private fun scheduleTimer(id: String, intervalMs: Long) {
        timers[id]?.let { mainHandler.removeCallbacks(it) }
        val runnable = object : Runnable {
            override fun run() {
                fireTick(id)
                mainHandler.postDelayed(this, intervalMs)
            }
        }
        timers[id] = runnable
        mainHandler.postDelayed(runnable, intervalMs)
    }

    private fun cancelTimer(id: String) {
        timers.remove(id)?.let { mainHandler.removeCallbacks(it) }
    }

    private fun fireTick(id: String) {
        val webView = webViewRef?.get() ?: return
        val evalId = ++evalIdCounter
        // The id is a base-36 monotonically increasing counter generated
        // in the JS scheduler wrapper. By construction it contains only
        // [0-9a-z] and is safe to embed in the JS string literal below
        // without escaping. If a future caller passes an arbitrary id
        // (e.g. a user-supplied timer name), it MUST be validated or
        // escaped first.
        val js = "window.dispatchEvent(new CustomEvent('scheduler-tick', { detail: { id: '" + id + "' } }))"
        webView.evalScript(evalId, js)
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = getSystemService(NotificationManager::class.java)
            if (mgr.getNotificationChannel(NOTIF_CHANNEL_ID) == null) {
                val channel = NotificationChannel(
                    NOTIF_CHANNEL_ID,
                    "Background sync",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply { setShowBadge(false) }
                mgr.createNotificationChannel(channel)
            }
        }
    }

    private fun startForegroundCompat() {
        val notif = NotificationCompat.Builder(this, NOTIF_CHANNEL_ID)
            .setContentTitle(${JSON.stringify(appName)})
            .setContentText("Background sync active")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    override fun onDestroy() {
        timers.values.forEach { mainHandler.removeCallbacks(it) }
        timers.clear()
        webViewRef = null
        instance = null
        super.onDestroy()
    }
}
`;
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
