package org.vistta.privilegedclipboard

import android.content.ClipData
import android.content.Context
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Parcel
import android.os.RemoteException
import android.util.Log

class ShizukuClipboardService(private val context: Context) : ClipboardMonitor.Stub() {
    private companion object {
        const val TAG = "VisttaPrivClipboard"
        const val CLIPBOARD_DESCRIPTOR = "android.content.IClipboard"
        const val GET_PRIMARY_CLIP_TRANSACTION = IBinder.FIRST_CALL_TRANSACTION + 3
        const val SHELL_PACKAGE = "com.android.shell"
    }
    private val handler = Handler(Looper.getMainLooper())
    private var callback: ClipboardMonitorCallback? = null
    private var poll: Runnable? = null
    private var lastText: String? = null

    override fun start(callback: ClipboardMonitorCallback, intervalMs: Long) {
        stop(); this.callback = callback
        val interval = maxOf(1000L, intervalMs)
        val runnable = object : Runnable {
            override fun run() {
                val text = readClipboard()
                if (!text.isNullOrEmpty() && text != lastText) {
                    lastText = text
                    try { this@ShizukuClipboardService.callback?.onClipboardChanged(text) } catch (_: RemoteException) { stop() }
                }
                handler.postDelayed(this, interval)
            }
        }
        poll = runnable; handler.post(runnable)
    }

    override fun stop() { poll?.let(handler::removeCallbacks); poll = null; callback = null; lastText = null }

    private fun readClipboard(): String? {
        return try {
        val clipboard = Class.forName("android.os.ServiceManager").getMethod("getService", String::class.java).invoke(null, "clipboard") as? IBinder ?: return null
        val request = Parcel.obtain(); val response = Parcel.obtain()
        try {
            request.writeInterfaceToken(CLIPBOARD_DESCRIPTOR)
            request.writeString(SHELL_PACKAGE); request.writeString(null); request.writeInt(0); request.writeInt(0)
            clipboard.transact(GET_PRIMARY_CLIP_TRANSACTION, request, response, 0)
            response.readException()
            response.readTypedObject(ClipData.CREATOR)?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()
        } finally { request.recycle(); response.recycle() }
        } catch (error: Throwable) { Log.w(TAG, "Unable to read clipboard from Shizuku user service", error); null }
    }
}