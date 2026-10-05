package org.vistta.directorysync

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.FileReader
import java.io.FileWriter
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.UUID

internal class SafDirectoryStore(private val resolver: ContentResolver, private val cacheDirectory: File) {
    companion object {
        const val MAX_PAGE_SIZE = 256
        const val MAX_CHUNK_SIZE = 1024 * 1024
        const val RECOVERY_DIRECTORY = ".vistta-sync-recovery"
    }

    private data class Document(
        val uri: Uri,
        val id: String,
        val name: String,
        val mimeType: String,
        val size: Long,
        val modified: Long,
        val flags: Int,
    ) {
        val isDirectory: Boolean get() = mimeType == DocumentsContract.Document.MIME_TYPE_DIR
    }

    private data class ScanTask(val document: Document, val path: String, val listDirectory: Boolean)
    private data class ScanSpool(
        val file: File,
        val reader: BufferedReader,
        val count: Int,
        var next: Int = 0,
    )

    private data class Target(val parent: Document, val name: String, val existing: Document?)

    private data class PendingWrite(
        val id: String,
        val parent: Document,
        val targetName: String,
        val expected: SafFingerprint?,
        val staged: Document,
        val manifest: Document,
        val output: FileOutputStream,
        val digest: MessageDigest = MessageDigest.getInstance("SHA-256"),
        var size: Long = 0,
        var recoverable: Boolean = false,
    )

    private val scans = ConcurrentHashMap<String, ScanSpool>()
    private val cancellations = ConcurrentHashMap<String, AtomicBoolean>()
    private val writes = ConcurrentHashMap<String, PendingWrite>()

    fun startScan(root: String, generation: String): JSONObject {
        require(generation.isNotEmpty()) { "Scan generation is required" }
        val cancelled = AtomicBoolean(false)
        check(cancellations.putIfAbsent(generation, cancelled) == null) { "Scan generation is already active" }
        val spoolFile = File.createTempFile("vistta-scan-", ".jsonl", cacheDirectory)
        return try {
            val first = BufferedWriter(FileWriter(spoolFile)).use { writer ->
                scanPass(root, cancelled) { entry ->
                    writer.write(entry.toString())
                    writer.newLine()
                }
            }
            val verified = scanPass(root, cancelled) {}
            check(first.first == verified.first && first.second.contentEquals(verified.second)) {
                "Directory changed during scan"
            }
            scans[generation] = ScanSpool(spoolFile, BufferedReader(FileReader(spoolFile)), first.first)
            JSONObject().put("generation", generation).put("count", first.first)
        } catch (error: Throwable) {
            spoolFile.delete()
            throw error
        } finally {
            cancellations.remove(generation)
        }
    }

    fun nextScanPage(generation: String, after: Int, limit: Int): JSONObject {
        require(limit in 1..MAX_PAGE_SIZE) { "Scan page size must be between 1 and $MAX_PAGE_SIZE" }
        val scan = scans[generation] ?: error("Scan generation is unavailable")
        require(after == scan.next) { "Scan page cursor is invalid" }
        val page = JSONArray()
        while (page.length() < limit && scan.next < scan.count) {
            val line = scan.reader.readLine() ?: error("Scan spool ended before its declared count")
            page.put(JSONObject(line))
            scan.next++
        }
        val complete = scan.next == scan.count
        if (complete) {
            scans.remove(generation)
            scan.reader.close()
            scan.file.delete()
        }
        return JSONObject()
            .put("generation", generation)
            .put("entries", page)
            .put("count", scan.next)
            .put("complete", complete)
    }

    fun cancel(operationId: String): Boolean {
        cancellations[operationId]?.let {
            it.set(true)
            return true
        }
        val scan = scans.remove(operationId) ?: return false
        scan.reader.close()
        scan.file.delete()
        return true
    }

    fun hashFile(root: String, relativePath: String, operationId: String): JSONObject {
        require(operationId.isNotEmpty()) { "Hash operation id is required" }
        val cancelled = AtomicBoolean(false)
        check(cancellations.putIfAbsent(operationId, cancelled) == null) { "Hash operation is already active" }
        return try {
            val document = resolve(root, relativePath)
            require(!document.isDirectory) { "File path is not a regular file" }
            val before = fingerprint(document)
            val digest = MessageDigest.getInstance("SHA-256")
            resolver.openInputStream(document.uri).use { input ->
                requireNotNull(input) { "File could not be opened" }
                val buffer = ByteArray(MAX_CHUNK_SIZE)
                while (true) {
                    checkCancelled(cancelled)
                    val count = input.read(buffer)
                    if (count < 0) break
                    check(count > 0) { "File read made no progress" }
                    digest.update(buffer, 0, count)
                }
            }
            check(fingerprint(queryDocument(document.uri)).similar(before)) { "File changed while hashing" }
            JSONObject()
                .put("sha256", digest.digest().joinToString("") { "%02x".format(it) })
                .put("fingerprint", before.toJson())
        } finally {
            cancellations.remove(operationId)
        }
    }

    fun readFileChunk(
        root: String,
        relativePath: String,
        offset: Long,
        limit: Int,
        expected: SafFingerprint,
    ): JSONObject {
        require(limit in 1..MAX_CHUNK_SIZE) { "Read size must be between 1 and $MAX_CHUNK_SIZE" }
        val document = resolve(root, relativePath)
        require(!document.isDirectory) { "File path is not a regular file" }
        val before = fingerprint(document)
        check(before.similar(expected) && offset in 0..before.size) { "File changed before read" }
        val length = minOf(limit.toLong(), before.size - offset).toInt()
        val data = ByteArray(length)
        resolver.openFileDescriptor(document.uri, "r").use { descriptor ->
            requireNotNull(descriptor) { "File could not be opened" }
            FileInputStream(descriptor.fileDescriptor).use { input ->
                input.channel.position(offset)
                var read = 0
                while (read < length) {
                    val count = input.read(data, read, length - read)
                    check(count > 0) { "File ended before its metadata size" }
                    read += count
                }
            }
        }
        check(fingerprint(queryDocument(document.uri)).similar(before)) { "File changed during read" }
        val nextOffset = offset + data.size
        return JSONObject()
            .put("data", Base64.encodeToString(data, Base64.NO_WRAP))
            .put("offset", offset)
            .put("nextOffset", nextOffset)
            .put("complete", nextOffset == before.size)
            .put("fingerprint", before.toJson())
    }

    fun beginWrite(root: String, relativePath: String, expected: SafFingerprint?): JSONObject {
        val target = resolveTarget(root, relativePath)
        assertTargetPrecondition(target.existing, expected)
        require(target.parent.flags and DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE != 0) {
            "Document provider cannot create files in the target directory"
        }
        val id = UUID.randomUUID().toString()
        val staged = createDocument(target.parent, "application/octet-stream", internalName(id, "new"))
        val manifestJson = JSONObject()
            .put("id", id)
            .put("target", target.name)
            .put("createdAt", System.currentTimeMillis())
            .put("expected", expected?.toJson() ?: JSONObject.NULL)
        val manifest = try {
            createDocument(target.parent, "application/json", internalName(id, "json")).also {
                writeDocument(it, manifestJson.toString().toByteArray())
            }
        } catch (error: Throwable) {
            deleteDocument(staged)
            throw error
        }
        val descriptor = resolver.openFileDescriptor(staged.uri, "wt")
            ?: run {
                deleteDocument(staged)
                deleteDocument(manifest)
                error("Staged file could not be opened")
            }
        writes[id] = PendingWrite(
            id,
            target.parent,
            target.name,
            expected,
            staged,
            manifest,
            FileOutputStream(descriptor.fileDescriptor),
        )
        return JSONObject().put("id", id)
    }

    fun writeChunk(id: String, data: String): JSONObject {
        val bytes = Base64.decode(data, Base64.DEFAULT)
        require(bytes.isNotEmpty() && bytes.size <= MAX_CHUNK_SIZE) {
            "Write size must be between 1 and $MAX_CHUNK_SIZE"
        }
        val write = writes[id] ?: error("Write operation is unavailable")
        write.output.write(bytes)
        write.digest.update(bytes)
        write.size = Math.addExact(write.size, bytes.size.toLong())
        return JSONObject().put("id", id).put("size", write.size)
    }

    fun commitWrite(id: String, sha256: String): JSONObject {
        val write = writes[id] ?: error("Write operation is unavailable")
        val actualHash = (write.digest.clone() as MessageDigest).digest().joinToString("") { "%02x".format(it) }
        require(sha256.matches(Regex("^[0-9a-fA-F]{64}$")) && actualHash.equals(sha256, true)) {
            "Staged write hash does not match"
        }
        val current = queryChildren(write.parent.uri).singleOrNull { it.name == write.targetName }
        assertTargetPrecondition(current, write.expected)
        write.output.flush()
        write.output.fd.sync()
        write.output.close()
        createMarker(write.parent, id, "prepared")
        write.recoverable = true

        var backupRetained = false
        if (current != null) {
            require(current.flags and DocumentsContract.Document.FLAG_SUPPORTS_RENAME != 0) {
                "Document provider cannot retain the old file"
            }
            renameDocument(current, internalName(id, "old"))
            createMarker(write.parent, id, "backup")
            backupRetained = true
        }
        renameDocument(write.staged, write.targetName)
        createMarker(write.parent, id, "committed")
        writes.remove(id)
        return JSONObject()
            .put("id", id)
            .put("sha256", actualHash)
            .put("size", write.size)
            .put("backupRetained", backupRetained)
    }

    fun abortWrite(id: String): Boolean {
        val write = writes[id] ?: return false
        if (write.recoverable) return false
        writes.remove(id)
        runCatching { write.output.close() }
        deleteDocument(write.staged)
        deleteDocument(write.manifest)
        return true
    }

    fun recoverRoot(root: String): JSONObject {
        val repaired = JSONArray()
        val discarded = JSONArray()
        val ambiguous = JSONArray()
        val pending = ArrayDeque<Document>()
        pending.add(queryDocument(treeDocumentUri(root)))
        while (pending.isNotEmpty()) {
            val directory = pending.removeLast()
            val children = queryChildren(directory.uri)
            children.filter { it.isDirectory }.forEach(pending::add)
            val manifests = children.filter { it.name.matches(Regex("^\\.vistta-[0-9a-fA-F-]{36}\\.json$")) }
            for (manifestDocument in manifests) {
                val manifest = try {
                    JSONObject(readDocument(manifestDocument).decodeToString())
                } catch (_: Throwable) {
                    ambiguous.put(manifestDocument.name)
                    continue
                }
                val id = manifest.optString("id")
                val targetName = manifest.optString("target")
                if (id.isEmpty() || targetName.isEmpty() || manifestDocument.name != internalName(id, "json")) {
                    ambiguous.put(manifestDocument.name)
                    continue
                }
                val currentChildren = queryChildren(directory.uri)
                val byName = currentChildren.associateBy { it.name }
                val target = byName[targetName]
                val staged = byName[internalName(id, "new")]
                val backup = byName[internalName(id, "old")]
                val prepared = byName[internalName(id, "prepared")]
                val backupMarker = byName[internalName(id, "backup")]
                val committed = byName[internalName(id, "committed")]

                when {
                    committed != null -> {
                        if (target == null) {
                            ambiguous.put(id)
                        } else if (System.currentTimeMillis() - manifest.optLong("createdAt") >= 30L * 24 * 60 * 60 * 1000) {
                            listOfNotNull(backup, prepared, backupMarker, committed, manifestDocument).forEach(::deleteDocument)
                            repaired.put(id)
                        }
                    }
                    backupMarker != null && target == null && staged != null -> {
                        renameDocument(staged, targetName)
                        createMarker(directory, id, "committed")
                        repaired.put(id)
                    }
                    backupMarker != null && target == null && backup != null -> {
                        renameDocument(backup, targetName)
                        listOfNotNull(prepared, backupMarker, manifestDocument).forEach(::deleteDocument)
                        repaired.put(id)
                    }
                    backupMarker != null -> ambiguous.put(id)
                    prepared != null || staged != null -> {
                        listOfNotNull(staged, prepared, manifestDocument).forEach(::deleteDocument)
                        discarded.put(id)
                    }
                    else -> ambiguous.put(id)
                }
            }
        }
        return JSONObject().put("repaired", repaired).put("discarded", discarded).put("ambiguous", ambiguous)
    }

    private fun scanPass(root: String, cancelled: AtomicBoolean, emit: (JSONObject) -> Unit): Pair<Int, ByteArray> {
        val rootDocument = queryDocument(treeDocumentUri(root))
        require(rootDocument.isDirectory) { "Sync root is not a directory" }
        val pending = ArrayDeque<ScanTask>()
        val digest = MessageDigest.getInstance("SHA-256")
        var count = 0
        pending.add(ScanTask(rootDocument, "", true))

        while (pending.isNotEmpty()) {
            checkCancelled(cancelled)
            val task = pending.removeLast()
            if (task.listDirectory) {
                val before = queryChildren(task.document.uri)
                val collisionKeys = mutableSetOf<String>()
                val selected = before.filterNot { child ->
                    (task.path.isEmpty() && child.name == RECOVERY_DIRECTORY) || isInternalName(child.name)
                }
                for (child in selected) {
                    validatePortableName(child.name)
                    check(collisionKeys.add(child.name.lowercase(Locale.ROOT))) {
                        "Directory contains a case-fold name collision: ${child.name}"
                    }
                    if (!child.isDirectory) require(child.size >= 0) { "File size metadata is invalid" }
                }
                check(listingDigest(before) == listingDigest(queryChildren(task.document.uri))) {
                    "Directory changed during scan"
                }
                for (child in selected.asReversed()) {
                    val path = if (task.path.isEmpty()) child.name else "${task.path}/${child.name}"
                    pending.add(ScanTask(child, path, false))
                }
                continue
            }

            val entry = JSONObject().apply {
                put("path", task.path)
                put("type", if (task.document.isDirectory) "folder" else "file")
                put("size", if (task.document.isDirectory) JSONObject.NULL else task.document.size)
                put("modified", formatModified(task.document.modified) ?: JSONObject.NULL)
                put("readonly", task.document.flags and DocumentsContract.Document.FLAG_SUPPORTS_WRITE == 0)
                put("identity", task.document.id)
            }
            val encoded = entry.toString().toByteArray()
            digest.update(encoded)
            digest.update(0.toByte())
            emit(entry)
            count++
            if (task.document.isDirectory) pending.add(ScanTask(task.document, task.path, true))
        }
        return count to digest.digest()
    }

    private fun resolveTarget(root: String, relativePath: String): Target {
        val parts = validateRelativePath(relativePath)
        var parent = queryDocument(treeDocumentUri(root))
        for (part in parts.dropLast(1)) {
            val matches = queryChildren(parent.uri).filter { it.name == part && it.isDirectory }
            check(matches.size == 1) { "Sync target parent is unavailable or ambiguous" }
            parent = matches.single()
        }
        val name = parts.last()
        val matches = queryChildren(parent.uri).filter { it.name == name }
        check(matches.size <= 1) { "Sync target is ambiguous" }
        val existing = matches.singleOrNull()
        require(existing == null || !existing.isDirectory) { "Sync target is not a regular file" }
        return Target(parent, name, existing)
    }

    private fun assertTargetPrecondition(document: Document?, expected: SafFingerprint?) {
        when {
            document == null && expected == null -> Unit
            document == null -> error("Sync target was removed")
            expected == null -> error("Sync target already exists")
            !fingerprint(document).similar(expected) -> error("Sync target changed")
        }
    }

    private fun createDocument(parent: Document, mimeType: String, name: String): Document {
        val uri = DocumentsContract.createDocument(resolver, parent.uri, mimeType, name)
            ?: error("Document provider refused to create $name")
        return queryDocument(uri)
    }

    private fun createMarker(parent: Document, id: String, state: String) {
        val marker = createDocument(parent, "application/octet-stream", internalName(id, state))
        writeDocument(marker, ByteArray(0))
    }

    private fun renameDocument(document: Document, name: String): Document {
        val uri = DocumentsContract.renameDocument(resolver, document.uri, name)
            ?: error("Document provider refused to rename ${document.name}")
        return queryDocument(uri)
    }

    private fun deleteDocument(document: Document) {
        check(DocumentsContract.deleteDocument(resolver, document.uri)) {
            "Document provider refused to delete ${document.name}"
        }
    }

    private fun writeDocument(document: Document, bytes: ByteArray) {
        resolver.openFileDescriptor(document.uri, "wt").use { descriptor ->
            requireNotNull(descriptor) { "Document could not be opened for writing" }
            FileOutputStream(descriptor.fileDescriptor).use { output ->
                output.write(bytes)
                output.flush()
                output.fd.sync()
            }
        }
    }

    private fun readDocument(document: Document): ByteArray {
        return resolver.openInputStream(document.uri).use { input ->
            requireNotNull(input) { "Document could not be opened for reading" }
            input.readBytes()
        }
    }

    private fun internalName(id: String, suffix: String) = ".vistta-$id.$suffix"

    private fun resolve(root: String, relativePath: String): Document {
        val parts = validateRelativePath(relativePath)
        var current = queryDocument(treeDocumentUri(root))
        for ((index, part) in parts.withIndex()) {
            require(current.isDirectory) { "Sync path contains a non-directory component" }
            val matches = queryChildren(current.uri).filter { it.name == part }
            check(matches.size == 1) { "Sync path is unavailable or ambiguous" }
            current = matches.single()
            if (index < parts.lastIndex) require(current.isDirectory) {
                "Sync path contains a non-directory component"
            }
        }
        return current
    }

    private fun treeDocumentUri(root: String): Uri {
        val treeUri = Uri.parse(root)
        require(treeUri.scheme == "content") { "A Storage Access Framework tree URI is required" }
        return DocumentsContract.buildDocumentUriUsingTree(treeUri, DocumentsContract.getTreeDocumentId(treeUri))
    }

    private fun queryDocument(uri: Uri): Document {
        val projection = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
            DocumentsContract.Document.COLUMN_FLAGS,
        )
        val cursor = resolver.query(uri, projection, null, null, null)
            ?: error("Document metadata is unavailable")
        cursor.use {
            check(it.moveToFirst()) { "Document is unavailable" }
            return documentFromCursor(uri, it)
        }
    }

    private fun queryChildren(directoryUri: Uri): List<Document> {
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(
            directoryUri,
            DocumentsContract.getDocumentId(directoryUri),
        )
        val projection = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
            DocumentsContract.Document.COLUMN_FLAGS,
        )
        val cursor = resolver.query(childrenUri, projection, null, null, null)
            ?: error("Directory listing is unavailable")
        return cursor.use {
            val output = mutableListOf<Document>()
            while (it.moveToNext()) {
                val id = it.getString(0)
                val uri = DocumentsContract.buildDocumentUriUsingTree(directoryUri, id)
                output += documentFromCursor(uri, it)
            }
            output.sortedBy { document -> document.name }
        }
    }

    private fun documentFromCursor(uri: Uri, cursor: android.database.Cursor) = Document(
        uri = uri,
        id = cursor.getString(0),
        name = cursor.getString(1) ?: error("Document name is unavailable"),
        mimeType = cursor.getString(2) ?: error("Document type is unavailable"),
        size = if (cursor.isNull(3)) 0 else cursor.getLong(3),
        modified = if (cursor.isNull(4)) 0 else cursor.getLong(4),
        flags = if (cursor.isNull(5)) 0 else cursor.getInt(5),
    )

    private fun fingerprint(document: Document): SafFingerprint {
        require(document.size >= 0) { "File size metadata is invalid" }
        require(document.modified > 0) { "File modification metadata is unavailable" }
        return SafFingerprint(document.size, formatModified(document.modified), document.id)
    }

    private fun listingDigest(children: List<Document>): String {
        val digest = MessageDigest.getInstance("SHA-256")
        for (child in children) {
            digest.update(child.id.toByteArray())
            digest.update(0.toByte())
            digest.update(child.name.toByteArray())
            digest.update(0.toByte())
            digest.update(child.mimeType.toByteArray())
            digest.update(0.toByte())
            digest.update(child.size.toString().toByteArray())
            digest.update(0.toByte())
            digest.update(child.modified.toString().toByteArray())
            digest.update(0.toByte())
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun validateRelativePath(path: String): List<String> {
        require(path.isNotEmpty() && !path.startsWith('/') && '\\' !in path && '\u0000' !in path) {
            "A root-relative file path is required"
        }
        return path.split('/').also { parts ->
            require(parts.isNotEmpty() && parts.none { it.isEmpty() || it == "." || it == ".." }) {
                "A root-relative file path is required"
            }
            parts.forEach(::validatePortableName)
        }
    }

    private fun validatePortableName(name: String) {
        val stem = name.substringBefore('.').lowercase(Locale.ROOT)
        val reserved = stem in setOf("con", "prn", "aux", "nul") ||
            (stem.length == 4 && (stem.startsWith("com") || stem.startsWith("lpt")) && stem[3] in '1'..'9')
        require(
            name.isNotEmpty() && name != "." && name != ".." &&
                name.codePointCount(0, name.length) <= 255 &&
                java.text.Normalizer.normalize(name, java.text.Normalizer.Form.NFC) == name &&
                name.none { it.code <= 31 || it in "<>:\"/\\|?*" } &&
                !name.endsWith('.') && !name.endsWith(' ') && !reserved,
        ) { "Directory contains an unsupported name: $name" }
    }

    private fun isInternalName(name: String) =
        name.matches(Regex("^\\.vistta-[0-9a-fA-F-]{36}\\.(new|old|json|prepared|backup|committed)$"))

    private fun checkCancelled(cancelled: AtomicBoolean) {
        check(!cancelled.get()) { "Operation was cancelled" }
    }

    private fun formatModified(value: Long): String? {
        if (value <= 0) return null
        return SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(Date(value))
    }
}

internal data class SafFingerprint(val size: Long, val modified: String?, val identity: String?) {
    fun similar(other: SafFingerprint) = size == other.size && modified == other.modified && identity == other.identity
    fun toJson() = JSONObject()
        .put("size", size)
        .put("modified", modified ?: JSONObject.NULL)
        .put("identity", identity ?: JSONObject.NULL)
}
