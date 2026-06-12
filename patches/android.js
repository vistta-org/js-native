import fs from "@vistta/fs";
import { devSuffix, writeIfChanged } from "../utils/index.js";

const PERMS = { begin: "<!-- vistta:permissions:begin -->", end: "<!-- vistta:permissions:end -->" };
const SERVICE = { begin: "<!-- vistta:service:begin -->", end: "<!-- vistta:service:end -->" };
const STRINGS = { begin: "<!-- vistta:strings:begin -->", end: "<!-- vistta:strings:end -->" };
const ACTIVITY = { begin: "// vistta:activity:begin", end: "// vistta:activity:end" };
const ACTIVITY_IMPORTS = { begin: "// vistta:activity-imports:begin", end: "// vistta:activity-imports:end" };
const ACTIVITY_MEMBERS = { begin: "// vistta:activity-members:begin", end: "// vistta:activity-members:end" };
const ACTIVITY_TICK = { begin: "// vistta:activity-tick:begin", end: "// vistta:activity-tick:end" };
const SIGNING_IMPORTS = { begin: "// vistta:signing-imports:begin", end: "// vistta:signing-imports:end" };
const SIGNING_CONFIGS = { begin: "// vistta:signing-configs:begin", end: "// vistta:signing-configs:end" };
const SIGNING_REFERENCE = { begin: "// vistta:signing-reference:begin", end: "// vistta:signing-reference:end" };

/**
 * Tauri's generated BuildTask.kt invokes `npm run -- tauri ...` which fails when
 * the consumer's package.json has no `tauri` script. We rewrite it to call the
 * `tauri` CLI binary directly (resolved from node_modules/.bin, which is on the
 * PATH Gradle passes to the task — `npx` is NOT, as its install dir is absent
 * from that PATH). The replacement is idempotent: it also rewrites a previously
 * patched `npx tauri ...` form. If Tauri changes the format dramatically the
 * patch silently no-ops.
 */
export async function patchBuildTask(targetDir, config) {
  const appId = config?.app?.id || "org.vistta.app";
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
  content = content.replace(/val\s+executable\s*=\s*"""(?:npm|npx)"""\s*;?/g, 'val executable = """tauri""";');
  content = content.replace(/val\s+args\s*=\s*listOf\(\s*"run"\s*,\s*"--"\s*,\s*"tauri"\s*,\s*/g, "val args = listOf(");
  content = content.replace(/val\s+args\s*=\s*listOf\(\s*"tauri"\s*,\s*/g, "val args = listOf(");
  await writeIfChanged(buildTaskPath, content);
}

const DEBUG_SUFFIX_MARKER = "// vistta:debug-suffix:begin";

/**
 * In development, append `.debug` to the debug buildType's `applicationId` so
 * the resulting APK installs side-by-side with the release build (different
 * applicationIds, different gradle auto-generated debug keystore, so they
 * coexist). The release `applicationId` is untouched. The `namespace` and
 * package source paths are unchanged — the suffix is purely an
 * `applicationId` override. It is applied from a separate trailing
 * `android { }` block because Tauri strips `applicationIdSuffix` from inside
 * its own managed `buildTypes` block on every `android build`.
 */
export async function patchApplicationIdSuffix(targetDir) {
  const gradlePath = fs.resolve(targetDir, "gen", "android", "app", "build.gradle.kts");
  if (!fs.existsSync(gradlePath)) return;
  let content = String(await fs.readFile(gradlePath, "utf8"));
  const marker = { begin: DEBUG_SUFFIX_MARKER, end: "// vistta:debug-suffix:end" };
  const existing = new RegExp(`\\n*${escapeRe(marker.begin)}[\\s\\S]*?${escapeRe(marker.end)}`);
  content = content.replace(existing, "");
  const body = [
    "android {",
    "    buildTypes {",
    '        getByName("debug") {',
    '            applicationIdSuffix = ".debug"',
    "        }",
    "    }",
    "}",
  ].join("\n");
  content = `${content.trimEnd()}\n\n${marker.begin}\n${body}\n${marker.end}\n`;
  await writeIfChanged(gradlePath, content);
}

export async function patchAndroidManifest(targetDir, config) {
  const manifestPath = fs.resolve(targetDir, "gen", "android", "app", "src", "main", "AndroidManifest.xml");
  if (!fs.existsSync(manifestPath)) return;
  let content = String(await fs.readFile(manifestPath, "utf8"));
  const background = !!config?.app?.background;

  const perms = ["android.permission.POST_NOTIFICATIONS", "android.permission.VIBRATE"];
  if (background) {
    perms.push(
      "android.permission.FOREGROUND_SERVICE",
      "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
      "android.permission.WAKE_LOCK",
    );
  }
  const permsBlock = perms.map((p) => `    <uses-permission android:name="${p}" />`).join("\n");

  content = ensureBlock(content, PERMS, permsBlock, (c, generated) => {
    if (/<uses-permission android:name="android\.permission\.INTERNET"\s*\/>/.test(c)) {
      return c.replace(/(<uses-permission android:name="android\.permission\.INTERNET"\s*\/>)/, `$1\n${generated}`);
    }
    return c.replace(/(<application\b)/, `${generated}\n    $1`);
  });

  if (background) {
    const serviceBlock = [
      `        <service`,
      `            android:name=".VisttaForegroundService"`,
      `            android:enabled="true"`,
      `            android:exported="false"`,
      `            android:foregroundServiceType="dataSync"`,
      `            android:stopWithTask="false" />`,
      `        <receiver`,
      `            android:name=".VisttaAlarmReceiver"`,
      `            android:enabled="true"`,
      `            android:exported="false" />`,
    ].join("\n");
    content = ensureBlock(content, SERVICE, serviceBlock, (c, generated) =>
      c.replace(/(\s*<\/application>)/, `\n${generated}$1`),
    );
  } else {
    const re = new RegExp(`\\n?[ \\t]*${escapeRe(SERVICE.begin)}[\\s\\S]*?${escapeRe(SERVICE.end)}`);
    content = content.replace(re, "");
  }

  await writeIfChanged(manifestPath, content);
}

/**
 * Tauri generates `res/values/strings.xml` once on `tauri android init` and
 * never touches it again — so the launcher label (`@string/app_name`) and the
 * in-app title (`@string/main_activity_title`) keep whatever was baked in at
 * init time, even when `productName` in `tauri.conf.json` is later updated.
 *
 * That breaks the ` [DEV]` tag: `mergeConfig` correctly writes
 * `"Vistta Connect [DEV]"` to the JSON, but the Android launcher still shows
 * `"Vistta Connect"` because it reads from the (stale) `strings.xml`. This
 * patch brings the two back in sync by rewriting the two strings to match
 * the runtime's source of truth (`config.app.name` + the shared `devSuffix`).
 *
 * Idempotent. Toggling between dev and release switches the suffix in
 * both directions on the next build — no marker-stripping gymnastics
 * because the runtime is the authoritative source for these two values.
 *
 * A `<!-- vistta:strings:begin/end -->` marker pair is inserted on first
 * run so consumers can see what's runtime-owned and so localisation files
 * (e.g. `res/values-pt/strings.xml`) are skipped — this patch only touches
 * the default-locale file the manifest's `android:label` references.
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
      // Entry missing — add one inside the marker block (or create the block).
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
  const appId = config?.app?.id || "org.vistta.app";
  const appName = config?.app?.name || "Vistta App";
  const background = !!config?.app?.background;
  const packagePath = appId.replace(/\./g, "/");
  const activityPath = fs.resolve(targetDir, "gen", "android", "app", "src", "main", "java", packagePath, "MainActivity.kt");
  if (!fs.existsSync(activityPath)) return;

  let content = String(await fs.readFile(activityPath, "utf8"));

  const importLines = [
    "import android.app.NotificationChannel",
    "import android.app.NotificationManager",
    "import android.content.Context",
    "import android.os.Build",
  ];
  if (background) {
    importLines.push("import android.content.Intent", "import android.webkit.WebView");
  }
  const imports = importLines.join("\n");

  const bodyLines = [
    `    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {`,
    `      val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager`,
    `      if (mgr.getNotificationChannel("default") == null) {`,
    `        mgr.createNotificationChannel(NotificationChannel("default", ${JSON.stringify(appName)}, NotificationManager.IMPORTANCE_DEFAULT))`,
    `      }`,
    `    }`,
  ];
  if (background) {
    bodyLines.push(
      `    val visttaService = Intent(this, VisttaForegroundService::class.java)`,
      `    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {`,
      `      startForegroundService(visttaService)`,
      `    } else {`,
      `      startService(visttaService)`,
      `    }`,
    );
  }
  const body = bodyLines.join("\n");

  const members = background
    ? [
        `  private var visttaWebView: WebView? = null`,
        ``,
        `  override fun onWebViewCreate(webView: WebView) {`,
        `    super.onWebViewCreate(webView)`,
        `    visttaWebView = webView`,
        `    VisttaWebViewRegistry.set(webView)`,
        `  }`,
        ``,
        `  override fun onDestroy() {`,
        `    VisttaWebViewRegistry.clear()`,
        `    super.onDestroy()`,
        `  }`,
        ``,
        `  override fun onPause() {`,
        `    super.onPause()`,
        `    visttaWebView?.onResume()`,
        `  }`,
      ].join("\n")
    : "";

  content = ensureBlockLines(content, ACTIVITY_IMPORTS, imports, (c, generated) =>
    c.replace(/(import\s+[^\n]+\n)/, `$1${generated}\n`),
  );
  content = ensureBlockLines(content, ACTIVITY, body, (c, generated) =>
    c.replace(/(super\.onCreate\(savedInstanceState\)\s*\n)/, `$1${generated}\n`),
  );
  if (background || new RegExp(escapeRe(ACTIVITY_MEMBERS.begin)).test(content)) {
    content = ensureBlockLines(content, ACTIVITY_MEMBERS, members, (c, generated) => {
      const idx = c.lastIndexOf("}");
      if (idx === -1) return `${c}\n${generated}\n`;
      return `${c.slice(0, idx)}${generated}\n${c.slice(idx)}`;
    });
  }

  // No-op tick body (kept as a hook in case future alarm-side code wants to
  // verify the activity is alive). Idempotent: the marker is created only when
  // background is on.
  if (background) {
    content = ensureBlockLines(content, ACTIVITY_TICK, "", (c, generated) =>
      c.replace(/(super\.onCreate\(savedInstanceState\)\s*\n)/, `$1${generated}\n`),
    );
  } else {
    const re = new RegExp(`\\n?${escapeRe(ACTIVITY_TICK.begin)}[\\s\\S]*?${escapeRe(ACTIVITY_TICK.end)}`);
    content = content.replace(re, "");
  }

  await writeIfChanged(activityPath, content);
}

/**
 * Generates (or removes) `VisttaForegroundService.kt`. The service keeps the
 * app's process resident while backgrounded by running as a foreground service
 * and holding a partial wake lock. It posts a minimal-importance ongoing
 * notification (mandatory for foreground services). Only emitted when
 * `app.background` is set; otherwise a previously-generated file is deleted.
 */
export async function patchForegroundService(targetDir, config) {
  const appId = config?.app?.id || "org.vistta.app";
  const appName = config?.app?.name || "Vistta App";
  const background = !!config?.app?.background;
  const packagePath = appId.replace(/\./g, "/");
  const servicePath = fs.resolve(
    targetDir,
    "gen",
    "android",
    "app",
    "src",
    "main",
    "java",
    packagePath,
    "VisttaForegroundService.kt",
  );

  if (!background) {
    if (fs.existsSync(servicePath)) await fs.rm(servicePath);
    return;
  }

  const content = `// Generated by @vistta/js-runtime. Do not edit by hand.
package ${appId}

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat

class VisttaForegroundService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        scheduleTickAlarm(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
                val channel = NotificationChannel(CHANNEL_ID, "Background", NotificationManager.IMPORTANCE_MIN)
                channel.setShowBadge(false)
                mgr.createNotificationChannel(channel)
            }
        }
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(${JSON.stringify(appName)})
            .setContentText("Running in background")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()
        startForeground(NOTIFICATION_ID, notification)

        if (wakeLock == null) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "vistta::background")
            wakeLock?.acquire()
        }
        scheduleTickAlarm(this)
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }

    companion object {
        private const val CHANNEL_ID = "vistta_background"
        private const val NOTIFICATION_ID = 1
        internal const val TICK_INTERVAL_MS = 60L * 1000L

        internal fun scheduleTickAlarm(context: Context) {
            val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val pi = PendingIntent.getBroadcast(
                context,
                0,
                Intent(context, VisttaAlarmReceiver::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val triggerAt = SystemClock.elapsedRealtime() + TICK_INTERVAL_MS
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi)
                } else {
                    am.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi)
                }
                Log.d("VisttaBg", "tick alarm scheduled in \${TICK_INTERVAL_MS}ms")
            } catch (se: SecurityException) {
                Log.w("VisttaBg", "tick alarm scheduling denied: \${se.message}")
            }
        }
    }
}
`;
  await writeIfChanged(servicePath, content);
}

/**
 * Writes the shared `VisttaWebViewRegistry.kt` so the alarm receiver can
 * reach the WebView across activity lifecycles. The registry holds a single
 * weak reference that the activity sets in `onWebViewCreate` and clears in
 * `onDestroy`. Without it the alarm fires into a black hole because the
 * receiver is constructed in a separate Android object lifecycle from the
 * activity. The file is generated alongside the service when background is
 * on; otherwise it's deleted.
 */
export async function patchAlarmReceiver(targetDir, config) {
  const appId = config?.app?.id || "org.vistta.app";
  const background = !!config?.app?.background;
  const packagePath = appId.replace(/\./g, "/");
  const dir = fs.resolve(targetDir, "gen", "android", "app", "src", "main", "java", packagePath);
  const registryPath = fs.resolve(dir, "VisttaWebViewRegistry.kt");
  const receiverPath = fs.resolve(dir, "VisttaAlarmReceiver.kt");

  if (!background) {
    if (fs.existsSync(registryPath)) await fs.rm(registryPath);
    if (fs.existsSync(receiverPath)) await fs.rm(receiverPath);
    return;
  }

  const registry = `// Generated by @vistta/js-runtime. Do not edit by hand.
package ${appId}

import android.webkit.WebView
import java.lang.ref.WeakReference

object VisttaWebViewRegistry {
    private var ref: WeakReference<WebView>? = null

    fun set(webView: WebView) {
        ref = WeakReference(webView)
    }

    fun clear() {
        ref = null
    }

    fun get(): WebView? = ref?.get()
}
`;
  await writeIfChanged(registryPath, registry);

  const receiver = `// Generated by @vistta/js-runtime. Do not edit by hand.
package ${appId}

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebView

class VisttaAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val webView = VisttaWebViewRegistry.get()
        if (webView == null) {
            Log.d("VisttaBg", "tick fired but no WebView registered; skipping")
            VisttaForegroundService.scheduleTickAlarm(context)
            return
        }
        val main = Handler(Looper.getMainLooper())
        main.post {
            try {
                webView.resumeTimers()
                webView.evaluateJavascript("1", null)
            } catch (t: Throwable) {
                Log.w("VisttaBg", "tick evaluateJavascript failed: \${t.message}")
            }
        }
        VisttaForegroundService.scheduleTickAlarm(context)
    }
}
`;
  await writeIfChanged(receiverPath, receiver);
}

/**
 * Wires the auto-generated keystore into Gradle so the `release` buildType
 * produces a signed APK. Follows the Tauri 2 Android signing guide:
 * https://v2.tauri.app/distribute/sign/android/
 *
 * Two artefacts are written:
 *   1. `<buildDir>/gen/android/keystore.properties` — plain-text credential
 *      file referenced by the gradle config below.
 *   2. `<buildDir>/gen/android/app/build.gradle.kts` — three idempotent
 *      marker-delimited injections:
 *        a. extra imports (`java.util.Properties`, `java.io.FileInputStream`)
 *        b. a `signingConfigs { create("release") { ... } }` block before
 *           `buildTypes`, reading credentials from `keystore.properties`
 *        c. a `signingConfig = signingConfigs.getByName("release")` line
 *           inside `getByName("release") { ... }`
 *
 * `credentials` is the object stashed on `config.__androidKeystore` by
 * `ensureAndroidKeystore()` in index.js. If it's missing the patch is a
 * no-op (build will produce an unsigned APK, matching the original
 * behaviour).
 */
export async function patchAndroidSigning(targetDir, config) {
  const credentials = config?.__androidKeystore;
  if (!credentials) return;
  const { keystorePath, alias, storePassword } = credentials;
  const keystoreRel = fs.relative(fs.resolve(targetDir, "gen", "android", "app"), keystorePath);
  const propsPath = fs.resolve(targetDir, "gen", "android", "keystore.properties");
  const propsContent =
    [
      `# Auto-generated by @vistta/js-runtime. Do not edit by hand.`,
      `# Re-running a build reuses the same keystore (see .credentials beside it).`,
      `password=${storePassword}`,
      `keyAlias=${alias}`,
      `storeFile=${keystoreRel.replace(/\\/g, "/")}`,
    ].join("\n") + "\n";
  await fs.mkdir(fs.dirname(propsPath), { recursive: true });
  await fs.writeFile(propsPath, propsContent);

  const gradlePath = fs.resolve(targetDir, "gen", "android", "app", "build.gradle.kts");
  if (!fs.existsSync(gradlePath)) return;
  let content = String(await fs.readFile(gradlePath, "utf8"));

  content = stripOutsideMarkers(content, SIGNING_IMPORTS, /^[ \t]*import\s+java\.util\.Properties\s*\r?\n/gm);
  content = stripOutsideMarkers(content, SIGNING_IMPORTS, /^[ \t]*import\s+java\.io\.FileInputStream\s*\r?\n/gm);
  const hasProps = /^\s*import\s+java\.util\.Properties\s*$/m.test(content);
  const hasFIS = /^\s*import\s+java\.io\.FileInputStream\s*$/m.test(content);
  const linesToAdd = [];
  if (!hasProps) linesToAdd.push("import java.util.Properties");
  if (!hasFIS) linesToAdd.push("import java.io.FileInputStream");
  if (linesToAdd.length) {
    const imports = linesToAdd.join("\n");
    content = ensureBlockLines(content, SIGNING_IMPORTS, imports, (c, generated) => {
      const matches = [...c.matchAll(/^import\s+[^\n]+\n/gm)];
      const last = matches[matches.length - 1];
      if (!last) return `${generated}\n${c}`;
      const insertAt = last.index + last[0].length;
      return c.slice(0, insertAt) + `\n${generated}` + c.slice(insertAt);
    });
  } else if (!new RegExp(escapeRe(SIGNING_IMPORTS.begin)).test(content)) {
    const presentImports = [];
    if (hasProps) presentImports.push("import java.util.Properties");
    if (hasFIS) presentImports.push("import java.io.FileInputStream");
    content = ensureBlockLines(content, SIGNING_IMPORTS, presentImports.join("\n"), (c, generated) => {
      const matches = [...c.matchAll(/^import\s+[^\n]+\n/gm)];
      const last = matches[matches.length - 1];
      if (!last) return `${generated}\n${c}`;
      const insertAt = last.index + last[0].length;
      return c.slice(0, insertAt) + `\n${generated}` + c.slice(insertAt);
    });
  }

  const signingConfigsBlock = `signingConfigs {
    create("release") {
        val keystorePropertiesFile = rootProject.file("keystore.properties")
        val keystoreProperties = Properties()
        if (keystorePropertiesFile.exists()) {
            keystoreProperties.load(FileInputStream(keystorePropertiesFile))
        }
        keyAlias = keystoreProperties["keyAlias"] as String
        keyPassword = keystoreProperties["password"] as String
        storeFile = file(keystoreProperties["storeFile"] as String)
        storePassword = keystoreProperties["password"] as String
    }
}`;
  content = ensureBlockLines(content, SIGNING_CONFIGS, signingConfigsBlock, (c, generated) =>
    c.replace(/(\n\s*buildTypes\s*\{)/, `\n${generated}\n$1`),
  );

  const indent = "        ";
  const signingRef = `${indent}signingConfig = signingConfigs.getByName("release")`;
  content = ensureBlockLines(content, SIGNING_REFERENCE, signingRef, (c, generated) => {
    // Place inside `getByName("release") { ... }` — first line after the opening brace.
    return c.replace(/(getByName\("release"\)\s*\{\s*\n)/, `$1${generated}\n`);
  });

  await writeIfChanged(gradlePath, content);
}

/**
 * Idempotently inserts/updates a marker-delimited block in `content`.
 * If the markers are absent, `insertFallback(content, generatedBlock)` is invoked
 * once to place the block; subsequent runs re-use the markers.
 */
function ensureBlock(content, marker, body, insertFallback) {
  const generated = body ? `${marker.begin}\n${body}\n${marker.end}` : `${marker.begin}\n${marker.end}`;
  const re = new RegExp(`${escapeRe(marker.begin)}[\\s\\S]*?${escapeRe(marker.end)}`);
  if (re.test(content)) return content.replace(re, generated);
  return insertFallback(content, generated);
}

// Same as ensureBlock but uses `//`-style line markers (suitable for Kotlin/JS).
function ensureBlockLines(content, marker, body, insertFallback) {
  const generated = body ? `${marker.begin}\n${body}\n${marker.end}` : `${marker.begin}\n${marker.end}`;
  const re = new RegExp(`${escapeRe(marker.begin)}[\\s\\S]*?${escapeRe(marker.end)}`);
  if (re.test(content)) return content.replace(re, generated);
  return insertFallback(content, generated);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Removes every match of `pattern` from `content` that lies OUTSIDE the marker
 * block delimited by `marker.begin` / `marker.end`. Lines inside the marker
 * block are preserved verbatim (they're owned by `ensureBlockLines`).
 */
function stripOutsideMarkers(content, marker, pattern) {
  const re = new RegExp(`${escapeRe(marker.begin)}[\\s\\S]*?${escapeRe(marker.end)}`);
  const match = re.exec(content);
  if (!match) return content.replace(pattern, "");
  const before = content.slice(0, match.index).replace(pattern, "");
  const after = content.slice(match.index + match[0].length).replace(pattern, "");
  return before + match[0] + after;
}
