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
        private const val ACTION_BACKGROUND_EVENTS_ON = "vistta.BACKGROUND_EVENTS_ON"
        private const val ACTION_BACKGROUND_EVENTS_OFF = "vistta.BACKGROUND_EVENTS_OFF"
        private const val ACTION_CLIPBOARD_START = "vistta.CLIPBOARD_START"
        private const val ACTION_CLIPBOARD_STOP = "vistta.CLIPBOARD_STOP"
        const val EXTRA_ID = "id"
        const val EXTRA_INTERVAL_MS = "intervalMs"

        @Volatile
        private var webViewRef: WeakReference<WebView>? = null

        @Volatile
        private var instance: VisttaService? = null

        // True while any socket listener is registered with `mobile: { background: true }`.
        @Volatile
        private var backgroundEvents: Boolean = false

        // The service could not start (app already backgrounded); retried on the next resume.
        @Volatile
        private var pendingStart: Boolean = false

        // Number of active clipboard poll loops. Keeps the foreground
        // service alive so the native poll (which reads the clipboard via
        // the accessibility service) continues when the app is
        // backgrounded. Without this, Android may kill the process when
        // no timers/sockets are active, stopping the poll.
        @Volatile
        private var clipboardCount: Int = 0

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

        fun setBackgroundEvents(context: Context, active: Boolean) {
            if (active == backgroundEvents) return
            backgroundEvents = active
            if (active) {
                startBackgroundEvents(context)
            } else {
                pendingStart = false
                val intent = Intent(context, VisttaService::class.java).setAction(ACTION_BACKGROUND_EVENTS_OFF)
                try { context.startService(intent) } catch (_: Throwable) {}
            }
        }

        fun resumePendingStart(context: Context) {
            if (pendingStart && backgroundEvents) startBackgroundEvents(context)
        }

        private fun startBackgroundEvents(context: Context) {
            val intent = Intent(context, VisttaService::class.java).setAction(ACTION_BACKGROUND_EVENTS_ON)
            pendingStart = try {
                context.startForegroundService(intent)
                false
            } catch (_: Throwable) {
                // Android 12+ forbids foreground-service starts from the background.
                true
            }
        }

        fun clipboardStart(context: Context) {
            val intent = Intent(context, VisttaService::class.java).setAction(ACTION_CLIPBOARD_START)
            try {
                context.startForegroundService(intent)
            } catch (_: Throwable) {
                // No permission / already running; best-effort.
            }
        }

        fun clipboardStop(context: Context) {
            val intent = Intent(context, VisttaService::class.java).setAction(ACTION_CLIPBOARD_STOP)
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
        // System restarted the service with a null intent after the
        // process was killed by the LMK. On Android 14+ we cannot call
        // startForeground() from a background restart — it throws
        // ForegroundServiceStartNotAllowedException. Keep the service
        // alive (START_STICKY) but non-foreground; it is promoted again
        // when JS registers timers or background listeners.
        if (intent == null) {
            return START_STICKY
        }
        // Only promote to foreground for actions started via
        // startForegroundService() (REGISTER, BACKGROUND_EVENTS_ON). The other
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
                stopIfIdle()
            }
            ACTION_STOP_IF_EMPTY -> stopIfIdle()
            ACTION_BACKGROUND_EVENTS_ON -> startForegroundCompat()
            ACTION_BACKGROUND_EVENTS_OFF -> stopIfIdle()
            ACTION_CLIPBOARD_START -> {
                startForegroundCompat()
                clipboardCount++
            }
            ACTION_CLIPBOARD_STOP -> {
                if (clipboardCount > 0) clipboardCount--
                stopIfIdle()
            }
        }
        return START_STICKY
    }

    private fun stopIfIdle() {
        if (timers.isEmpty() && !backgroundEvents && clipboardCount == 0) stopSelf()
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
        super.onDestroy()
    }
}