import fs from "@vistta/fs";
import { writeIfChanged } from "../utils/index.js";

const PERMS = { begin: "<!-- vistta:permissions:begin -->", end: "<!-- vistta:permissions:end -->" };
const SERVICE = { begin: "<!-- vistta:service:begin -->", end: "<!-- vistta:service:end -->" };
const ACTIVITY = { begin: "// vistta:activity:begin", end: "// vistta:activity:end" };
const ACTIVITY_IMPORTS = { begin: "// vistta:activity-imports:begin", end: "// vistta:activity-imports:end" };

/**
 * Tauri's generated BuildTask.kt invokes `npm run -- tauri ...` which fails when
 * the consumer's package.json has no `tauri` script. We rewrite it to call
 * `npx tauri ...` directly. The replacement is idempotent and tolerant of
 * whitespace; if Tauri changes the format dramatically the patch silently no-ops
 * (build will still work — npm-via-npm-script is the upstream default).
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
  // Use loose patterns so spacing/quoting drift in upstream doesn't break us.
  content = content.replace(/val\s+executable\s*=\s*"""npm"""\s*;?/g, 'val executable = """npx""";');
  content = content.replace(/val\s+args\s*=\s*listOf\(\s*"run"\s*,\s*"--"\s*,\s*"tauri"/g, 'val args = listOf("tauri"');
  await writeIfChanged(buildTaskPath, content);
}

export async function patchAndroidManifest(targetDir, config) {
  const manifestPath = fs.resolve(targetDir, "gen", "android", "app", "src", "main", "AndroidManifest.xml");
  if (!fs.existsSync(manifestPath)) return;
  let content = String(await fs.readFile(manifestPath, "utf8"));

  // Permissions block — generated between markers so re-runs are idempotent and
  // toggling app.background cleanly adds/removes the relevant entries.
  const perms = ["android.permission.POST_NOTIFICATIONS", "android.permission.VIBRATE", "android.permission.WAKE_LOCK"];
  if (config?.app?.background) {
    perms.push("android.permission.FOREGROUND_SERVICE", "android.permission.FOREGROUND_SERVICE_DATA_SYNC");
  }
  const permsBlock = perms.map((p) => `    <uses-permission android:name="${p}" />`).join("\n");

  content = ensureBlock(
    content,
    PERMS,
    permsBlock,
    // Insert after the upstream INTERNET permission if present, otherwise before <application>.
    (c, generated) => {
      if (/<uses-permission android:name="android\.permission\.INTERNET"\s*\/>/.test(c)) {
        return c.replace(/(<uses-permission android:name="android\.permission\.INTERNET"\s*\/>)/, `$1\n${generated}`);
      }
      return c.replace(/(<application\b)/, `${generated}\n    $1`);
    },
  );

  // Service block — empty when background disabled, removing the registration entirely.
  const serviceBlock = config?.app?.background
    ? `        <service\n            android:name=".VisttaForegroundService"\n            android:enabled="true"\n            android:exported="false"\n            android:foregroundServiceType="dataSync" />`
    : "";
  content = ensureBlock(content, SERVICE, serviceBlock, (c, generated) =>
    c.replace(/(<\/application>)/, `${generated}\n    $1`),
  );

  await writeIfChanged(manifestPath, content);
}

export async function generateForegroundService(targetDir, config) {
  const appId = config?.app?.id || "org.vistta.app";
  const appName = config?.app?.name || "Vistta App";
  const packagePath = appId.replace(/\./g, "/");
  const serviceDir = fs.resolve(targetDir, "gen", "android", "app", "src", "main", "java", packagePath, "kotlin");
  await fs.mkdir(serviceDir, { recursive: true });

  const serviceFile = fs.resolve(serviceDir, "VisttaForegroundService.kt");
  const content = `package ${appId}

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

class VisttaForegroundService : Service() {
    companion object {
        const val CHANNEL_ID = "vistta_background"
        const val NOTIFICATION_ID = 1
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification()
        startForeground(NOTIFICATION_ID, notification)
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                ${JSON.stringify(appName)},
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Keeps the app running for real-time notifications"
                setShowBadge(false)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                action = "ALREADY_STARTED"
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            },
            PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(${JSON.stringify(appName)})
            .setContentText("Running in background")
            .setSmallIcon(R.drawable.ic_stat_notification)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setSilent(true)
            .build()
    }
}
`;
  await writeIfChanged(serviceFile, content);
}

/**
 * Patches MainActivity.kt to (a) create a default notification channel suitable
 * for Tauri's notification plugin, and (b) start the foreground service when
 * background mode is enabled. Both injections live between markers so
 * `removeForegroundService` can cleanly remove them when background is disabled.
 */
export async function patchMainActivity(targetDir, config) {
  const appId = config?.app?.id || "org.vistta.app";
  const appName = config?.app?.name || "Vistta App";
  const packagePath = appId.replace(/\./g, "/");
  const activityPath = fs.resolve(targetDir, "gen", "android", "app", "src", "main", "java", packagePath, "MainActivity.kt");
  if (!fs.existsSync(activityPath)) return;

  let content = String(await fs.readFile(activityPath, "utf8"));
  const background = !!config?.app?.background;

  // Strip any legacy standalone injections that an older version of this patch
  // wrote outside marker blocks. Without this, re-running the patch on an
  // existing gen/android tree accumulates duplicate `import android.content.Intent`
  // and duplicate startForegroundService(...) calls, breaking the Kotlin build.
  content = stripOutsideMarkers(content, ACTIVITY_IMPORTS, /^[ \t]*import\s+android\.content\.Intent\s*\r?\n/gm);
  content = stripOutsideMarkers(
    content,
    ACTIVITY,
    /^[ \t]*if \(intent\?\.action != "ALREADY_STARTED"\) \{\r?\n[ \t]*startForegroundService\(Intent\(this, VisttaForegroundService::class\.java\)\)\r?\n[ \t]*\}\r?\n/gm,
  );

  const imports = [
    "import android.app.NotificationChannel",
    "import android.app.NotificationManager",
    "import android.content.Context",
    "import android.os.Build",
    ...(background ? ["import android.content.Intent"] : []),
  ].join("\n");

  const body = [
    // Always create the default notification channel so tauri-plugin-notification
    // posts on a managed channel rather than the system default.
    `    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {`,
    `      val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager`,
    `      if (mgr.getNotificationChannel("default") == null) {`,
    `        mgr.createNotificationChannel(NotificationChannel("default", ${JSON.stringify(appName)}, NotificationManager.IMPORTANCE_DEFAULT))`,
    `      }`,
    `    }`,
    ...(background
      ? [
          `    if (intent?.action != "ALREADY_STARTED") {`,
          `      startForegroundService(Intent(this, VisttaForegroundService::class.java))`,
          `    }`,
        ]
      : []),
  ].join("\n");

  content = ensureBlockLines(content, ACTIVITY_IMPORTS, imports, (c, generated) =>
    // Inject after the first existing `import` line.
    c.replace(/(import\s+[^\n]+\n)/, `$1${generated}\n`),
  );
  content = ensureBlockLines(content, ACTIVITY, body, (c, generated) =>
    c.replace(/(super\.onCreate\(savedInstanceState\)\s*\n)/, `$1${generated}\n`),
  );

  await writeIfChanged(activityPath, content);
}

/**
 * Removes the foreground-service file AND the corresponding MainActivity injection.
 * Switching background mode off without this leaves MainActivity referencing a
 * deleted Kotlin class, breaking the build.
 */
export async function removeForegroundService(targetDir, config) {
  const appId = config?.app?.id || "org.vistta.app";
  const packagePath = appId.replace(/\./g, "/");
  const serviceFile = fs.resolve(
    targetDir,
    "gen",
    "android",
    "app",
    "src",
    "main",
    "java",
    packagePath,
    "kotlin",
    "VisttaForegroundService.kt",
  );
  if (fs.existsSync(serviceFile)) await fs.unlink(serviceFile);
  // MainActivity is re-patched (with background=false) by patchMainActivity on the
  // next build, but only when called. Calling it explicitly here keeps the file
  // consistent regardless of caller order.
  await patchMainActivity(targetDir, { ...config, app: { ...(config?.app || {}), background: false } });
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
