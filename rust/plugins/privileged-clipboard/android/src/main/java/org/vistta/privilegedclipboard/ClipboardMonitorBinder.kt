package org.vistta.privilegedclipboard

import android.os.Binder
import android.os.IBinder
import android.os.IInterface
import android.os.Parcel
import android.os.RemoteException

interface ClipboardMonitor : IInterface {
    @Throws(RemoteException::class)
    fun start(callback: ClipboardMonitorCallback, intervalMs: Long)
    @Throws(RemoteException::class)
    fun stop()
    @Throws(RemoteException::class)
    fun writeText(text: String): Boolean

    abstract class Stub : Binder(), ClipboardMonitor {
        init { attachInterface(this, DESCRIPTOR) }
        override fun asBinder(): IBinder = this
        override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean = when (code) {
            INTERFACE_TRANSACTION -> { reply?.writeString(DESCRIPTOR); true }
            TRANSACTION_START -> {
                data.enforceInterface(DESCRIPTOR)
                start(ClipboardMonitorCallback.Stub.asInterface(data.readStrongBinder()) ?: throw RemoteException("Callback required"), data.readLong())
                reply?.writeNoException(); true
            }
            TRANSACTION_STOP -> { data.enforceInterface(DESCRIPTOR); stop(); reply?.writeNoException(); true }
            TRANSACTION_WRITE -> { data.enforceInterface(DESCRIPTOR); val result = writeText(data.readString().orEmpty()); reply?.writeNoException(); reply?.writeInt(if (result) 1 else 0); true }
            else -> super.onTransact(code, data, reply, flags)
        }
        companion object {
            private const val DESCRIPTOR = "org.vistta.privilegedclipboard.ClipboardMonitor"
            private const val TRANSACTION_START = IBinder.FIRST_CALL_TRANSACTION
            private const val TRANSACTION_STOP = IBinder.FIRST_CALL_TRANSACTION + 1
            private const val TRANSACTION_WRITE = IBinder.FIRST_CALL_TRANSACTION + 2
            fun asInterface(binder: IBinder?): ClipboardMonitor? = binder?.let { Proxy(it) }
        }
        private class Proxy(private val remote: IBinder) : ClipboardMonitor {
            override fun asBinder() = remote
            override fun start(callback: ClipboardMonitorCallback, intervalMs: Long) = transact(TRANSACTION_START) { it.writeStrongBinder(callback.asBinder()); it.writeLong(intervalMs) }
            override fun stop() = transact(TRANSACTION_STOP) { }
            override fun writeText(text: String): Boolean {
                val data = Parcel.obtain(); val reply = Parcel.obtain()
                return try { data.writeInterfaceToken(DESCRIPTOR); data.writeString(text); remote.transact(TRANSACTION_WRITE, data, reply, 0); reply.readException(); reply.readInt() == 1 }
                finally { data.recycle(); reply.recycle() }
            }
            private fun transact(code: Int, write: (Parcel) -> Unit) {
                val data = Parcel.obtain(); val reply = Parcel.obtain()
                try { data.writeInterfaceToken(DESCRIPTOR); write(data); remote.transact(code, data, reply, 0); reply.readException() }
                finally { data.recycle(); reply.recycle() }
            }
        }
    }
}

interface ClipboardMonitorCallback : IInterface {
    @Throws(RemoteException::class)
    fun onClipboardChanged(text: String)
    abstract class Stub : Binder(), ClipboardMonitorCallback {
        init { attachInterface(this, DESCRIPTOR) }
        override fun asBinder(): IBinder = this
        override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
            if (code == INTERFACE_TRANSACTION) { reply?.writeString(DESCRIPTOR); return true }
            if (code == TRANSACTION_CHANGED) { data.enforceInterface(DESCRIPTOR); onClipboardChanged(data.readString().orEmpty()); return true }
            return super.onTransact(code, data, reply, flags)
        }
        companion object {
            private const val DESCRIPTOR = "org.vistta.privilegedclipboard.ClipboardMonitorCallback"
            private const val TRANSACTION_CHANGED = IBinder.FIRST_CALL_TRANSACTION
            fun asInterface(binder: IBinder?): ClipboardMonitorCallback? = binder?.let { Proxy(it) }
        }
        private class Proxy(private val remote: IBinder) : ClipboardMonitorCallback {
            override fun asBinder() = remote
            override fun onClipboardChanged(text: String) {
                val data = Parcel.obtain()
                try { data.writeInterfaceToken(DESCRIPTOR); data.writeString(text); remote.transact(TRANSACTION_CHANGED, data, null, IBinder.FLAG_ONEWAY) }
                finally { data.recycle() }
            }
        }
    }
}