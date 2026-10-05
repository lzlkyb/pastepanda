package com.pastepanda.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class InstallApkArgs {
    var path: String = ""
}

/**
 * Android 应用内自更新的原生出口（方案甲，2026-10-03）。
 *
 * Rust 侧 `commands::update_android` 下载并 sha256 校验完 APK 后，经
 * `run_mobile_plugin("installApk")` 走到这里：FileProvider 把
 * `cache/updates/` 下的 apk 转成 content:// URI（file:// 在 API 24+ 会触发
 * FileUriExposedException），再 ACTION_VIEW 交系统安装器。
 *
 * 覆盖安装的签名一致性由系统校验——构建脚本已改用长期 keystore
 * （见 scripts/android-build.mjs），换 key 等于全新安装，旧用户升级会失败。
 *
 * 与 RcKeepalivePlugin 同一装载机制：Rust `register_android_plugin` 按类名反射，
 * 源码在 src-tauri/android 入库，prepare-android.mjs 构建前复制到 gen/。
 */
@TauriPlugin
class ApkInstallerPlugin(private val activity: Activity) : Plugin(activity) {

    /** API 26 以下没有「安装未知应用」按应用授权概念，系统在安装时走全局未知来源提示。 */
    private fun canInstall(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            activity.packageManager.canRequestPackageInstalls()

    @Command
    fun installApk(invoke: Invoke) {
        val args = invoke.parseArgs(InstallApkArgs::class.java)
        if (!canInstall()) {
            invoke.resolveObject(mapOf("status" to "needPermission"))
            return
        }
        val file = File(args.path)
        if (!file.exists()) {
            invoke.reject("APK 文件不存在：${args.path}")
            return
        }
        try {
            val uri = FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.fileprovider",
                file,
            )
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(
                    Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK,
                )
            }
            activity.startActivity(intent)
            invoke.resolveObject(mapOf("status" to "launched"))
        } catch (e: Exception) {
            invoke.reject(e.message ?: "installApk failed")
        }
    }

    @Command
    fun installStatus(invoke: Invoke) {
        invoke.resolveObject(mapOf("allowed" to canInstall()))
    }

    @Command
    fun openInstallSettings(invoke: Invoke) {
        try {
            val intent = Intent(
                android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.fromParts("package", activity.packageName, null),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.startActivity(intent)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.message ?: "openInstallSettings failed")
        }
    }
}
