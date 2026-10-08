package com.pastepanda.app

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg class KnowledgeAckArgs { var id: String = "" }
@InvokeArg class KnowledgeOutgoingArgs {
    var title: String = ""
    var text: String = ""
    var imagePaths: List<String> = emptyList()
}

@TauriPlugin
class KnowledgeSharePlugin(private val activity: Activity) : Plugin(activity) {
    private val store by lazy { KnowledgeShareStore.get(activity.applicationContext) }
    private fun changed() { activity.runOnUiThread { triggerObject("incoming", mapOf("changed" to true)) } }

    override fun load(webView: WebView) {
        // ACTION_SEND cold start occurs before JS listeners exist; the durable inbox is queried on foreground.
        store.receive(activity.intent, ::changed)
    }
    override fun onNewIntent(intent: Intent) { store.receive(intent, ::changed) }

    @Command fun listPending(invoke: Invoke) {
        try { invoke.resolveObject(store.snapshot()) }
        catch (_: Exception) { invoke.reject("待收集内容读取失败，已有草稿未受影响") }
    }
    @Command fun acknowledge(invoke: Invoke) {
        try { store.ack(invoke.parseArgs(KnowledgeAckArgs::class.java).id); invoke.resolve() }
        catch (_: Exception) { invoke.reject("待收集内容清理失败，请重试") }
    }
    @Command fun pickImages(invoke: Invoke) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            type = "image/*"; addCategory(Intent.CATEGORY_OPENABLE)
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        try { startActivityForResult(invoke, intent, "imageSelection") }
        catch (_: Exception) { invoke.reject("无法打开系统图片选择器") }
    }
    @ActivityCallback fun imageSelection(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK || result.data == null) {
            invoke.resolveObject(mapOf("status" to "cancelled")); return
        }
        val data = result.data!!; val clips = data.clipData
        val uris = (listOfNotNull(data.data) + (0 until (clips?.itemCount ?: 0)).mapNotNull { clips?.getItemAt(it)?.uri }).distinct()
        store.collect("", "", uris) { id ->
            changed(); invoke.resolveObject(mapOf("status" to "collected", "incomingId" to id))
        }
    }
    @Command fun share(invoke: Invoke) {
        val args = invoke.parseArgs(KnowledgeOutgoingArgs::class.java)
        try {
            require(args.text.length <= 200_000 && args.imagePaths.size <= 8)
            val root = File(activity.cacheDir, "knowledge-share-out").apply { mkdirs() }.canonicalFile
            val uris = args.imagePaths.map { path ->
                val file = File(path).canonicalFile
                require(file.parentFile == root && file.isFile && file.length() <= 10 * 1024 * 1024)
                FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
            }
            val intent = Intent(if (uris.size > 1) Intent.ACTION_SEND_MULTIPLE else Intent.ACTION_SEND).apply {
                type = if (uris.isEmpty()) "text/plain" else "image/*"
                putExtra(Intent.EXTRA_SUBJECT, args.title); putExtra(Intent.EXTRA_TEXT, args.text)
                if (uris.size == 1) putExtra(Intent.EXTRA_STREAM, uris[0])
                if (uris.size > 1) putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(uris))
                if (uris.isNotEmpty()) {
                    clipData = ClipData.newRawUri("知识库图片", uris[0]).apply { uris.drop(1).forEach { addItem(ClipData.Item(it)) } }
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
            }
            activity.startActivity(Intent.createChooser(intent, "分享笔记"))
            // The chooser cannot prove delivery to another app; never report sharing succeeded.
            invoke.resolveObject(mapOf("status" to "opened"))
        } catch (_: Exception) { invoke.reject("系统分享面板打开失败，请重试") }
    }
}
