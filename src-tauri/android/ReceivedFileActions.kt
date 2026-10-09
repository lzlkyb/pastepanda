package com.pastepanda.app

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.webkit.MimeTypeMap
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import app.tauri.annotation.InvokeArg
import app.tauri.plugin.Invoke
import java.io.File
import java.util.Locale
import java.util.concurrent.Executors

@InvokeArg class ReceivedFileArgs { var path: String = ""; var action: String = "" }

/** FileProvider grants one validated cached file; SAF export needs no broad storage permission. */
class ReceivedFileActions(private val activity: Activity) {
    private val io = Executors.newSingleThreadExecutor()
    private fun source(path: String): File {
        val root = File(activity.cacheDir, "received-file-out").canonicalFile
        val file = File(path).canonicalFile
        require(file.parentFile?.parentFile == root && file.isFile)
        return file
    }
    private fun mime(file: File) = MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase(Locale.ROOT)) ?: "application/octet-stream"

    fun start(invoke: Invoke, plugin: KnowledgeSharePlugin) {
        try {
            val args = invoke.parseArgs(ReceivedFileArgs::class.java)
            val file = source(args.path)
            if (args.action == "export") {
                val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE); type = mime(file)
                    putExtra(Intent.EXTRA_TITLE, file.name)
                }
                plugin.chooseExport(invoke, intent); return
            }
            require(args.action == "open" || args.action == "share")
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
            val intent = Intent(if (args.action == "open") Intent.ACTION_VIEW else Intent.ACTION_SEND).apply {
                type = mime(file)
                if (args.action == "open") setDataAndType(uri, mime(file)) else putExtra(Intent.EXTRA_STREAM, uri)
                clipData = ClipData.newRawUri(file.name, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.startActivity(if (args.action == "share") Intent.createChooser(intent, "分享文件") else intent)
            // Opening a chooser does not prove delivery to another application.
            invoke.resolveObject(mapOf("status" to "opened"))
        } catch (_: ActivityNotFoundException) { invoke.reject("没有可打开此文件的应用，请使用分享或导出") }
        catch (_: SecurityException) { invoke.reject("文件访问被拒绝，请重试或重新接收") }
        catch (_: Exception) { invoke.reject("文件操作未能启动，文件可能已失效，请重新接收") }
    }
    fun exportResult(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            invoke.resolveObject(mapOf("status" to "cancelled")); return
        }
        // Copy on the worker; large received files must never stall the activity UI.
        io.execute {
            try {
                val file = source(invoke.parseArgs(ReceivedFileArgs::class.java).path)
                activity.contentResolver.openOutputStream(uri, "w").use { output ->
                    requireNotNull(output)
                    file.inputStream().use { input -> input.copyTo(output) }
                }
                invoke.resolveObject(mapOf("status" to "exported"))
                file.delete(); file.parentFile?.delete()
            } catch (_: SecurityException) { invoke.reject("未获准保存到所选位置，请重新选择；原文件仍保留") }
            catch (_: Exception) { invoke.reject("导出未完成，请检查目标位置空间后重试；原文件仍保留") }
        }
    }
}
