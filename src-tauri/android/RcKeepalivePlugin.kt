package com.pastepanda.app

import android.app.Activity
import android.content.Context
import android.net.wifi.WifiManager
import android.view.WindowManager
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class KeepaliveArgs {
    var on: Boolean = false
    var title: String = ""
}

/**
 * RC 保活的 Tauri 移动插件（方案 B，2026-10-02）——Rust 侧
 * `rc::keepalive` 经 `register_android_plugin` 装载本类，
 * 会话开始/结束调 `setKeepalive` 启停 [RcSessionForegroundService]。
 *
 * 持 WifiLock：前台服务只保进程不死，不保 WiFi 不打盹——深睡时
 * 适配器休眠会断推流。流媒体应用的常规动作。
 *
 * 源码在 src-tauri/android 入库；android:* 构建脚本自动复制到 gen/。
 */
// 🔴 基类 Plugin 的 activity 是 private val，子类摸不到——必须自带一份构造属性
// （与 plugins-workspace 官方插件同一写法），否则 Kotlin 编译报
// "Cannot access 'activity': it is invisible (private in a supertype)"。
// release 的 R8 仅为带 TauriPlugin 注解的类保留反射命令。
@TauriPlugin
class RcKeepalivePlugin(private val activity: Activity) : Plugin(activity) {
    private var wifiLock: WifiManager.WifiLock? = null

    @Command
    fun setKeepalive(invoke: Invoke) {
        val args = invoke.parseArgs(KeepaliveArgs::class.java)
        val ctx: Context = activity
        // 前台服务/WifiLock 不会阻止屏幕超时；只在观看窗口可见时保持亮屏。
        // Android 允许手动锁屏和后台熄屏，退出会话后恢复系统超时策略。
        activity.runOnUiThread {
            if (args.on) {
                activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
        try {
            if (args.on) {
                val intent = android.content.Intent(ctx, RcSessionForegroundService::class.java)
                intent.putExtra(RcSessionForegroundService.EXTRA_TITLE, args.title)
                // startForegroundService：即便调用发生在前台，用它也更稳
                // （要求服务端确实调 startForeground，我们做了）
                ctx.startForegroundService(intent)
                acquireWifiLock(ctx)
            } else {
                releaseWifiLock()
                ctx.stopService(android.content.Intent(ctx, RcSessionForegroundService::class.java))
            }
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.message ?: "setKeepalive failed")
        }
    }

    private fun acquireWifiLock(ctx: Context) {
        if (wifiLock?.isHeld == true) return
        val wm = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            ?: return
        val mode = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            WifiManager.WIFI_MODE_FULL_LOW_LATENCY
        } else {
            @Suppress("DEPRECATION")
            WifiManager.WIFI_MODE_FULL_HIGH_PERF
        }
        val lock = wm.createWifiLock(mode, "pastepanda:rc-session")
        lock.setReferenceCounted(false)
        lock.acquire()
        wifiLock = lock
    }

    private fun releaseWifiLock() {
        wifiLock?.let { if (it.isHeld) it.release() }
        wifiLock = null
    }
}
