package org.vistta.privilegedclipboard

import android.content.ComponentName
import android.content.Context
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.IBinder
import android.os.RemoteException
import android.util.Log
import rikka.shizuku.Shizuku

object ShizukuClipboard {
    private const val TAG = "VisttaPrivClipboard"
    private const val PERMISSION_REQUEST_CODE = 1042
    private var context: Context? = null
    private var monitor: ClipboardMonitor? = null
    private var monitoring = false
    private var intervalMs = 2000L
    private var listenersRegistered = false

    private fun args(): Shizuku.UserServiceArgs? = context?.let { appContext ->
        Shizuku.UserServiceArgs(ComponentName(appContext, ShizukuClipboardService::class.java))
            .processNameSuffix("vistta_clipboard").tag("vistta-privileged-clipboard").version(2).daemon(false)
    }
    private val callback = object : ClipboardMonitorCallback.Stub() { override fun onClipboardChanged(text: String) = PrivilegedClipboardBridge.onClipboardChanged(text) }
    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, service: IBinder) { monitor = ClipboardMonitor.Stub.asInterface(service); if (monitoring) startRemoteMonitor() }
        override fun onServiceDisconnected(name: ComponentName) { monitor = null }
    }

    fun attachContext(context: Context) {
        this.context = context.applicationContext
        if (listenersRegistered) return
        listenersRegistered = true
        Shizuku.addBinderReceivedListenerSticky { Log.i(TAG, "Shizuku binder available"); if (monitoring) startMonitor(intervalMs) }
        Shizuku.addBinderDeadListener { Log.w(TAG, "Shizuku binder died"); monitor = null }
        Shizuku.addRequestPermissionResultListener { requestCode, result ->
            if (requestCode == PERMISSION_REQUEST_CODE) {
                if (result == PackageManager.PERMISSION_GRANTED) { Log.i(TAG, "Shizuku permission granted"); if (monitoring) startMonitor(intervalMs) }
                else Log.w(TAG, "Shizuku permission denied")
            }
        }
    }
    fun isAvailable(): Boolean = try { !Shizuku.isPreV11() && Shizuku.pingBinder() } catch (_: Throwable) { false }
    fun isAuthorized(): Boolean = isAvailable() && Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
    fun requestPermission(): Boolean = try { if (!isAvailable() || Shizuku.shouldShowRequestPermissionRationale()) false else if (isAuthorized()) true else { Shizuku.requestPermission(PERMISSION_REQUEST_CODE); false } } catch (_: Throwable) { false }
    fun startMonitor(intervalMs: Long): Boolean {
        this.intervalMs = maxOf(1000L, intervalMs); monitoring = true
        if (!isAvailable()) { Log.i(TAG, "Shizuku is unavailable; using standard clipboard fallback"); return false }
        if (!isAuthorized()) { Log.i(TAG, "Requesting Shizuku permission"); requestPermission(); return false }
        if (monitor != null) { startRemoteMonitor(); return true }
        return try { Shizuku.bindUserService(args() ?: return false, connection); true } catch (error: Throwable) { Log.e(TAG, "Unable to bind Shizuku clipboard service", error); monitoring = false; false }
    }
    fun stopMonitor() {
        monitoring = false
        try { monitor?.stop() } catch (_: RemoteException) { }
        monitor = null
        args()?.let { try { Shizuku.unbindUserService(it, connection, true) } catch (_: Throwable) { } }
    }
    private fun startRemoteMonitor() {
        try { monitor?.start(callback, intervalMs); Log.i(TAG, "Shizuku clipboard monitor started"); PrivilegedClipboardBridge.onMonitorStarted() }
        catch (error: RemoteException) { Log.e(TAG, "Unable to start Shizuku clipboard monitor", error); monitor = null }
    }
}