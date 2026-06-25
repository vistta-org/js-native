// Foreground service that holds the process + webview alive so that
// setBackgroundInterval callbacks continue to fire when the user
// backgrounds the app, locks the device, or switches to another app.
//
// Started by JS via the VisttaScheduler JavascriptInterface when the first
// timer is registered. Stops itself when the last timer is cleared.
//
// Ticks are delivered by evalScript into the webview, which fires a
// 'scheduler-tick' CustomEvent on window. The runtime's scheduler.js
// listener dispatches to the right callback.

package org.vistta.runtime

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
import android.webkit.WebView
import androidx.core.app.NotificationCompat
import java.lang.ref.WeakReference
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

class VisttaService : Service() {

    companion object {
        private const val NOTIF_CHANNEL_ID = "vistta_scheduler"
        private const val NOTIF_ID = 1001
        private const val ACTION_REGISTER = "vistta.REGISTER_TIMER"
        private const val ACTION_CLEAR = "vistta.CLEAR_TIMER"
        private const val ACTION_STOP_IF_EMPTY = "vistta.STOP_IF_EMPTY"
        private const val ACTION_SOCKET_OPENED = "vistta.SOCKET_OPENED"
        private const val ACTION_SOCKET_CLOSED = "vistta.SOCKET_CLOSED"
        const val EXTRA_ID = "id"
        const val EXTRA_INTERVAL_MS = "intervalMs"

        @Volatile
        private var webViewRef: WeakReference<WebView>? = null

        @Volatile
        private var instance: VisttaService? = null

        // Number of currently-open background sockets. Used by the
        // service's stopSelf check so the foreground service (and the
        // specialUse priority it grants) stay alive as long as any socket
        // is open, even when no timers are registered.
        @Volatile
        private var socketCount: Int = 0

        private val mainHandler = Handler(Looper.getMainLooper())
        private val timers = mutableMapOf<String, Runnable>()

        fun attachWebView(webView: WebView) {
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

        fun socketOpened(context: Context) {
            val intent = Intent(context, VisttaService::class.java).setAction(ACTION_SOCKET_OPENED)
            try {
                context.startForegroundService(intent)
            } catch (_: Throwable) {
                // No permission / already running; best-effort.
            }
        }

        fun socketClosed(context: Context) {
            val intent = Intent(context, VisttaService::class.java).setAction(ACTION_SOCKET_CLOSED)
            try { context.startService(intent) } catch (_: Throwable) {}
        }

        private fun fireTick(id: String) {
            val webView = webViewRef?.get() ?: return
            val js = "window.dispatchEvent(new CustomEvent('scheduler-tick', { detail: { id: '" + id + "' } }))"
            webView.evaluateJavascript(js, null)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        ensureNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // System restarted the service with a null intent (START_STICKY).
        // The specialUse time budget may have been exhausted or the OS
        // revoked foreground eligibility, so promoting to foreground again
        // would throw ForegroundServiceStartNotAllowedException.
        // Stop immediately instead of entering a crash loop.
        if (intent == null) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        // Only promote to foreground for actions started via
        // startForegroundService() (REGISTER, SOCKET_OPENED). The other
        // actions are started via startService() on an already-running
        // service and must not call startForeground() — doing so after
        // the OS has revoked foreground eligibility crashes the process.
        when (intent.action) {
            ACTION_REGISTER -> {
                startForegroundCompat()
                val id = intent.getStringExtra(EXTRA_ID) ?: return START_NOT_STICKY
                val intervalMs = intent.getLongExtra(EXTRA_INTERVAL_MS, 60_000L)
                scheduleTimer(id, intervalMs)
            }
            ACTION_CLEAR -> {
                val id = intent.getStringExtra(EXTRA_ID) ?: return START_NOT_STICKY
                cancelTimer(id)
                if (timers.isEmpty() && socketCount == 0) stopSelf()
            }
            ACTION_STOP_IF_EMPTY -> {
                if (timers.isEmpty() && socketCount == 0) stopSelf()
            }
            ACTION_SOCKET_OPENED -> {
                startForegroundCompat()
                socketCount++
            }
            ACTION_SOCKET_CLOSED -> {
                if (socketCount > 0) socketCount--
                if (timers.isEmpty() && socketCount == 0) stopSelf()
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
        val appName = applicationContext.applicationInfo.loadLabel(packageManager).toString()
        val notif = NotificationCompat.Builder(this, NOTIF_CHANNEL_ID)
            .setContentTitle(appName)
            .setContentText("Background sync active")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    override fun onDestroy() {
        timers.values.forEach { mainHandler.removeCallbacks(it) }
        timers.clear()
        webViewRef = null
        instance = null
        VisttaNetwork.shutdown()
        super.onDestroy()
    }
}