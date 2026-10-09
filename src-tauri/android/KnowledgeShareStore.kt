package com.pastepanda.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/** The inbox is independent of the note/draft database. Only explicit confirmation consumes it. */
class KnowledgeShareStore(private val context: Context) {
    companion object {
        @Volatile private var shared: KnowledgeShareStore? = null
        @Synchronized fun get(context: Context): KnowledgeShareStore = shared ?: KnowledgeShareStore(context.applicationContext).also { shared = it }
    }
    private val directory = File(context.filesDir, "knowledge-inbox").apply { mkdirs() }
    private val index = AtomicFile(File(directory, "inbox.json"))
    private val pending = AtomicInteger(0)
    val processing: Boolean get() = pending.get() > 0
    private val executor = Executors.newSingleThreadExecutor()
    @Volatile private var lastFailure = ""
    @Volatile private var openRequestId = ""

    @Synchronized private fun load(): JSONObject = try {
        index.openRead().use { JSONObject(it.readBytes().toString(Charsets.UTF_8)) }
    } catch (_: java.io.FileNotFoundException) {
        JSONObject().put("items", JSONArray())
    }

    @Synchronized private fun save(state: JSONObject) {
        val stream = index.startWrite()
        try { stream.write(state.toString().toByteArray()); index.finishWrite(stream) }
        catch (error: Exception) { index.failWrite(stream); throw error }
    }

    @Synchronized fun snapshot(): Map<String, Any> {
        val items = load().getJSONArray("items")
        return mapOf("items" to (0 until items.length()).map { offset ->
            val row = items.getJSONObject(offset)
            val images = row.getJSONArray("images")
            mapOf("id" to row.getString("id"), "title" to row.getString("title"),
                "text" to row.getString("text"), "status" to row.getString("status"),
                "message" to row.getString("message"), "created_at" to row.getLong("created_at"),
                "images" to (0 until images.length()).map { images.getString(it) })
        }, "processing" to processing, "staging_dir" to directory.absolutePath, "openRequestId" to openRequestId,
            "notice" to lastFailure.ifEmpty { load().optString("notice") })
    }

    @Synchronized fun ack(id: String) {
        val state = load(); val rows = state.getJSONArray("items"); val next = JSONArray()
        for (i in 0 until rows.length()) if (rows.getJSONObject(i).getString("id") != id) next.put(rows.get(i))
        state.put("items", next).put("notice", ""); save(state); lastFailure = ""
        // Remove only files no longer referenced by any pending item. Saved notes use Rust's separate images root.
        // Cleanup runs behind any copying job; otherwise ack could delete its completed but not-yet-enqueued file.
        executor.execute { synchronized(this) {
            val current = load().getJSONArray("items"); val pendingPaths = mutableSetOf<String>()
            for (i in 0 until current.length()) {
                val paths = current.getJSONObject(i).getJSONArray("images")
                for (j in 0 until paths.length()) pendingPaths.add(paths.getString(j))
            }
            directory.listFiles()?.filter { it.name.endsWith(".image") && it.absolutePath !in pendingPaths }?.forEach { it.delete() }
        } }
    }

    @Suppress("DEPRECATION")
    fun receive(intent: Intent, complete: () -> Unit) {
        if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return
        // A picker/list/ack is background state, not a request to replace the user's page.
        openRequestId = UUID.randomUUID().toString()
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString().orEmpty()
        val title = intent.getStringExtra(Intent.EXTRA_SUBJECT).orEmpty()
        val uris = if (intent.action == Intent.ACTION_SEND_MULTIPLE)
            intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
        else listOfNotNull(intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
        val clips = intent.clipData
        val selected = (uris + (0 until (clips?.itemCount ?: 0)).mapNotNull { clips?.getItemAt(it)?.uri }).distinct()
        collect(title, text, selected) { complete() }
    }

    fun collect(title: String, text: String, uris: List<Uri>, complete: (String?) -> Unit) {
        pending.incrementAndGet()
        executor.execute {
            var received: String? = null
            try {
                require(text.length <= 200_000 && title.length <= 500) { "分享内容太长，请分段收集" }
                require(uris.size <= 8) { "一次最多收集8张图片，请分批选择" }
                require(text.isNotBlank() || uris.isNotEmpty()) { "没有可收集内容，请重新分享文字、链接或图片" }
                val paths = mutableListOf<String>(); val failures = mutableListOf<String>()
                for (uri in uris) try { paths.add(copy(uri).absolutePath) }
                catch (error: Exception) { failures.add(error.message ?: "图片读取失败，请重新分享") }
                val status = if (failures.isEmpty()) "ready" else if (text.isNotBlank() || paths.isNotEmpty()) "partial" else "error"
                val message = if (failures.isNotEmpty()) failures.distinct().joinToString("；") else "已收集，请确认后保存到手机"
                received = enqueue(title, text, paths, status, message)
            } catch (error: Exception) {
                try { received = enqueue("", "", emptyList(), "error", error.message ?: "收集失败，请重新分享") }
                catch (_: Exception) { lastFailure = "待收集内容保存失败，请检查手机存储空间后重新分享" }
            }
            finally { pending.decrementAndGet(); complete(received) }
        }
    }

    private fun copy(uri: Uri): File {
        require(uri.scheme == "content") { "图片来源不支持，请从相册重新分享" }
        val temporary = File.createTempFile("incoming-", ".tmp", directory)
        try {
            val digest = MessageDigest.getInstance("MD5"); var count = 0L
            val used = directory.listFiles()?.filter { it.name.endsWith(".image") }?.sumOf { it.length() } ?: 0L
            val source = context.contentResolver.openInputStream(uri) ?: error("图片已失效，请重新分享")
            source.use { input -> temporary.outputStream().use { output ->
                val buffer = ByteArray(32 * 1024)
                while (true) { val read = input.read(buffer); if (read < 0) break
                    count += read; require(count <= 10 * 1024 * 1024) { "图片超过10MB，请缩小后分享" }
                    require(used + count <= 80 * 1024 * 1024) { "待收集图片占用空间已满，请先保存或清理待处理内容" }
                    digest.update(buffer, 0, read); output.write(buffer, 0, read)
                }
            } }
            require(count > 0) { "图片为空，请重新选择" }
            val name = digest.digest().joinToString("") { "%02x".format(it) } + ".image"
            val target = File(directory, name)
            if (!target.exists()) check(temporary.renameTo(target)) { "图片保存失败，请重试" }
            return target
        } catch (_: SecurityException) { error("图片授权已失效，请从原应用重新分享") }
        catch (_: java.io.IOException) { error("图片已失效或读取失败，请从原应用重新分享") }
        finally { temporary.delete() }
    }

    @Synchronized private fun enqueue(title: String, text: String, paths: List<String>, status: String, message: String): String? {
        val state = load(); val rows = state.getJSONArray("items")
        val fingerprint = MessageDigest.getInstance("SHA-256").digest((title + "\u0000" + text + "\u0000" + paths.joinToString("\u0000") + status + message).toByteArray()).joinToString("") { "%02x".format(it) }
        val duplicate = (0 until rows.length()).firstOrNull { rows.getJSONObject(it).optString("fingerprint") == fingerprint }
        if (duplicate != null) {
            state.put("notice", "相同内容刚才已收集，没有重复添加"); save(state); return rows.getJSONObject(duplicate).getString("id")
        }
        // Never drop unconfirmed items to make room for newer content.
        if (rows.length() >= 20) {
            state.put("notice", "已有20条待处理内容，本次尚未收集；请先处理后从原应用重新分享"); save(state); return null
        }
        val id = UUID.randomUUID().toString()
        rows.put(JSONObject().put("id", id).put("title", title).put("text", text)
            .put("images", JSONArray(paths)).put("status", status).put("message", message).put("created_at", System.currentTimeMillis()).put("fingerprint", fingerprint))
        state.put("notice", ""); save(state); lastFailure = ""; return id
    }
}
