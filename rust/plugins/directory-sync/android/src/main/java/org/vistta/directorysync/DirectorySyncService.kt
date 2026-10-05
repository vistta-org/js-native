package org.vistta.directorysync

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.content.ContextCompat
import java.util.concurrent.ConcurrentHashMap

class DirectorySyncService : Service() {
    companion object {
        private const val ACTION_ACQUIRE = "org.vistta.directorysync.ACQUIRE"
        private const val ACTION_RELEASE = "org.vistta.directorysync.RELEASE"
        private const val EXTRA_ID = "id"
        private const val CHANNEL_ID = "directory-sync"
        private const val NOTIFICATION_ID = 0x5644
        private val leases = ConcurrentHashMap.newKeySet<String>()

        fun acquire(context: Context, id: String) {
            val intent = Intent(context, DirectorySyncService::class.java)
                .setAction(ACTION_ACQUIRE)
                .putExtra(EXTRA_ID, id)
            ContextCompat.startForegroundService(context, intent)
        }

        fun release(context: Context, id: String) {
            val intent = Intent(context, DirectorySyncService::class.java)
                .setAction(ACTION_RELEASE)
                .putExtra(EXTRA_ID, id)
            context.startService(intent)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val id = intent?.getStringExtra(EXTRA_ID)
        when (intent?.action) {
            ACTION_ACQUIRE -> if (!id.isNullOrEmpty()) {
                leases.add(id)
                enterForeground()
            }
            ACTION_RELEASE -> if (!id.isNullOrEmpty()) {
                leases.remove(id)
                stopIfIdle(startId)
            }
            else -> stopIfIdle(startId)
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        leases.clear()
        super.onDestroy()
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        leases.clear()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf(startId)
    }

    private fun enterForeground() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Directory sync", NotificationManager.IMPORTANCE_LOW),
            )
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val notification = builder
            .setSmallIcon(applicationInfo.icon.takeIf { it != 0 } ?: android.R.drawable.stat_sys_upload)
            .setContentTitle(applicationInfo.loadLabel(packageManager))
            .setContentText("Synchronizing files")
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun stopIfIdle(startId: Int) {
        if (leases.isNotEmpty()) return
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf(startId)
    }
}
