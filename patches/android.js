import fs from "@vistta/fs";

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
  content = content.replace(/val executable = """npm""";/g, 'val executable = """npx""";');
  content = content.replace(/val args = listOf\("run", "--", "tauri"/g, 'val args = listOf("tauri"');
  await fs.writeFile(buildTaskPath, content);
}

export async function patchAndroidManifest(targetDir, config) {
  const manifestPath = fs.resolve(targetDir, "gen", "android", "app", "src", "main", "AndroidManifest.xml");
  if (!fs.existsSync(manifestPath)) return;
  let content = String(await fs.readFile(manifestPath, "utf8"));

  const permissions = [];
  if (!content.includes("POST_NOTIFICATIONS")) {
    permissions.push(`    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />`);
  }
  if (config?.app?.background) {
    if (!content.includes("FOREGROUND_SERVICE")) {
      permissions.push(`    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />`);
    }
    if (!content.includes("FOREGROUND_SERVICE_DATA_SYNC")) {
      permissions.push(`    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />`);
    }
  }
  if (permissions.length > 0) {
    content = content.replace(
      /<uses-permission android:name="android.permission.INTERNET" \/>/,
      `<uses-permission android:name="android.permission.INTERNET" />\n${permissions.join("\n")}`,
    );
  }

  if (config?.app?.background && !content.includes("VisttaForegroundService")) {
    content = content.replace(
      /<\/application>/,
      `    <service\n          android:name=".VisttaForegroundService"\n          android:enabled="true"\n          android:exported="false"\n          android:foregroundServiceType="dataSync" />\n    </application>`,
    );
  }

  await fs.writeFile(manifestPath, content);
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
                "${appName}",
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
            .setContentTitle("${appName}")
            .setContentText("Running in background")
            .setSmallIcon(android.R.drawable.ic_menu_info_details)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setSilent(true)
            .build()
    }
}
`;
  await fs.writeFile(serviceFile, content);
}

export async function patchMainActivity(targetDir, config) {
  const appId = config?.app?.id || "org.vistta.app";
  const packagePath = appId.replace(/\./g, "/");
  const activityPath = fs.resolve(
    targetDir,
    "gen",
    "android",
    "app",
    "src",
    "main",
    "java",
    packagePath,
    "kotlin",
    "MainActivity.kt",
  );
  if (!fs.existsSync(activityPath)) return;

  let content = String(await fs.readFile(activityPath, "utf8"));
  if (content.includes("VisttaForegroundService")) return;

  content = content.replace("import android.os.Bundle", "import android.os.Bundle\nimport android.content.Intent");
  content = content.replace(
    "super.onCreate(savedInstanceState)",
    `super.onCreate(savedInstanceState)\n    if (intent?.action != \"ALREADY_STARTED\") {\n      startForegroundService(Intent(this, VisttaForegroundService::class.java))\n    }`,
  );

  await fs.writeFile(activityPath, content);
}

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
}
