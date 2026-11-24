package org.vistta.directorysync

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.concurrent.Executors
import java.util.UUID

@InvokeArg
class RootArgs {
    lateinit var root: String
}

@InvokeArg
class StartScanArgs {
    lateinit var root: String
    lateinit var generation: String
}

@InvokeArg
class ScanPageArgs {
    lateinit var generation: String
    var after: Int = 0
    var limit: Int = 0
}

@InvokeArg
class OperationArgs {
    lateinit var operationId: String
}

@InvokeArg
class FileOperationArgs {
    lateinit var root: String
    lateinit var relativePath: String
    lateinit var operationId: String
}

class FingerprintArgs {
    var size: Long = 0
    var modified: String? = null
    var identity: String? = null

    internal fun value() = SafFingerprint(size, modified, identity)
}

@InvokeArg
class ReadChunkArgs {
    lateinit var root: String
    lateinit var relativePath: String
    var offset: Long = 0
    var limit: Int = 0
    lateinit var expected: FingerprintArgs
}

@InvokeArg
class BeginWriteArgs {
    lateinit var root: String
    lateinit var relativePath: String
    var expected: FingerprintArgs? = null
}

@InvokeArg
class WriteChunkArgs {
    lateinit var id: String
    lateinit var data: String
}

@InvokeArg
class CommitWriteArgs {
    lateinit var id: String
    lateinit var sha256: String
}

@InvokeArg
class WriteIdArgs {
    lateinit var id: String
}

@TauriPlugin
class DirectorySyncPlugin(private val activity: Activity) : Plugin(activity) {
    private val executor = Executors.newCachedThreadPool()
    private val store = SafDirectoryStore(activity.contentResolver, activity.cacheDir)

    @Command
    fun selectRoot(invoke: Invoke) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
            )
        }
        startActivityForResult(invoke, intent, "onRootSelected")
    }

    @ActivityCallback
    fun onRootSelected(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            invoke.resolve(JSObject().apply { put("cancelled", true) })
            return
        }
        val flags = result.data!!.flags and
            (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        try {
            activity.contentResolver.takePersistableUriPermission(uri, flags)
            invoke.resolve(probe(uri))
        } catch (error: Throwable) {
            invoke.reject(error.message ?: "Directory access could not be persisted")
        }
    }

    @Command
    fun probeRoot(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(RootArgs::class.java)
            invoke.resolve(probe(Uri.parse(args.root)))
        } catch (error: Throwable) {
            invoke.reject(error.message ?: "Directory access is unavailable")
        }
    }

    @Command
    fun startScan(invoke: Invoke) {
        val args = invoke.parseArgs(StartScanArgs::class.java)
        run(invoke, args.generation) { store.startScan(args.root, args.generation) }
    }

    @Command
    fun nextScanPage(invoke: Invoke) = run(invoke) {
        val args = invoke.parseArgs(ScanPageArgs::class.java)
        store.nextScanPage(args.generation, args.after, args.limit)
    }

    @Command
    fun cancelOperation(invoke: Invoke) = run(invoke) {
        val args = invoke.parseArgs(OperationArgs::class.java)
        JSObject().apply { put("cancelled", store.cancel(args.operationId)) }
    }

    @Command
    fun beginLease(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(OperationArgs::class.java)
            require(args.operationId.isNotEmpty()) { "Operation id is required" }
            DirectorySyncService.acquire(activity, args.operationId)
            invoke.resolve(JSObject().apply { put("active", true) })
        } catch (error: Throwable) {
            invoke.reject(error.message ?: "Directory sync lease could not start")
        }
    }

    @Command
    fun endLease(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(OperationArgs::class.java)
            require(args.operationId.isNotEmpty()) { "Operation id is required" }
            DirectorySyncService.release(activity, args.operationId)
            invoke.resolve(JSObject().apply { put("active", false) })
        } catch (error: Throwable) {
            invoke.reject(error.message ?: "Directory sync lease could not stop")
        }
    }

    @Command
    fun hashFile(invoke: Invoke) {
        val args = invoke.parseArgs(FileOperationArgs::class.java)
        run(invoke, args.operationId) { store.hashFile(args.root, args.relativePath, args.operationId) }
    }

    @Command
    fun readFileChunk(invoke: Invoke) = run(invoke) {
        val args = invoke.parseArgs(ReadChunkArgs::class.java)
        store.readFileChunk(args.root, args.relativePath, args.offset, args.limit, args.expected.value())
    }

    @Command
    fun beginWrite(invoke: Invoke) = run(invoke) {
        val args = invoke.parseArgs(BeginWriteArgs::class.java)
        store.beginWrite(args.root, args.relativePath, args.expected?.value()).also { result ->
            DirectorySyncService.acquire(activity, result.getString("id"))
        }
    }

    @Command
    fun writeChunk(invoke: Invoke) = run(invoke) {
        val args = invoke.parseArgs(WriteChunkArgs::class.java)
        store.writeChunk(args.id, args.data)
    }

    @Command
    fun commitWrite(invoke: Invoke) {
        val args = invoke.parseArgs(CommitWriteArgs::class.java)
        run(invoke, args.id) { store.commitWrite(args.id, args.sha256) }
    }

    @Command
    fun abortWrite(invoke: Invoke) {
        val args = invoke.parseArgs(WriteIdArgs::class.java)
        run(invoke, args.id) {
            JSObject().apply { put("aborted", store.abortWrite(args.id)) }
        }
    }

    @Command
    fun recoverRoot(invoke: Invoke) {
        val args = invoke.parseArgs(RootArgs::class.java)
        run(invoke, UUID.randomUUID().toString()) { store.recoverRoot(args.root) }
    }

    private fun run(
        invoke: Invoke,
        leaseId: String? = null,
        operation: () -> org.json.JSONObject,
    ) {
        executor.execute {
            try {
                if (leaseId != null) DirectorySyncService.acquire(activity, leaseId)
                invoke.resolve(JSObject(operation().toString()))
            } catch (error: Throwable) {
                // Android 12+ refuses the dataSync lease while the app has no foreground service.
                if (error.javaClass.name == "android.app.ForegroundServiceStartNotAllowedException") {
                    invoke.reject("Background execution is unavailable", "background-unavailable")
                } else {
                    invoke.reject(error.message ?: "Directory operation failed")
                }
            } finally {
                if (leaseId != null) runCatching { DirectorySyncService.release(activity, leaseId) }
            }
        }
    }

    private fun probe(treeUri: Uri): JSObject {
        require(treeUri.scheme == "content") { "A Storage Access Framework tree URI is required" }
        val permission = activity.contentResolver.persistedUriPermissions.firstOrNull { it.uri == treeUri }
            ?: throw IllegalStateException("No persisted directory grant exists for this root")
        require(permission.isReadPermission) { "The directory grant is not readable" }

        val documentUri = DocumentsContract.buildDocumentUriUsingTree(
            treeUri,
            DocumentsContract.getTreeDocumentId(treeUri),
        )
        val projection = arrayOf(
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_FLAGS,
        )
        val cursor = activity.contentResolver.query(documentUri, projection, null, null, null)
            ?: throw IllegalStateException("Directory metadata is unavailable")
        val flags: Int
        cursor.use {
            require(it.moveToFirst()) { "Selected directory is unavailable" }
            require(
                it.getString(0) == DocumentsContract.Document.MIME_TYPE_DIR,
            ) { "Selected document is not a directory" }
            flags = it.getInt(1)
        }
        val writable = permission.isWritePermission &&
            flags and DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE != 0
        val recoverable = writable &&
            flags and DocumentsContract.Document.FLAG_SUPPORTS_RENAME != 0 &&
            flags and DocumentsContract.Document.FLAG_SUPPORTS_DELETE != 0
        return JSObject().apply {
            put("root", treeUri.toString())
            put("directoryMetadata", true)
            put("scopedSelection", true)
            put("persistedGrant", true)
            put("streamingRead", true)
            put("streamingWrite", writable)
            put("hashing", true)
            put("recoverableReplacement", recoverable)
            put("atomicReplacement", false)
            put("durableReplacement", false)
            put("sourceRevalidation", true)
            put("cancellation", true)
            put("foregroundLifecycle", true)
            put("watch", false)
            put("stableIdentity", false)
            put("supported", recoverable)
        }
    }
}
