package com.pastepanda.app

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * RC 会话前台服务（方案 B 前台服务保活，2026-10-02）。
 *
 * 远程会话期间持一个前台服务：进程从「缓存态」升到「前台服务态」——
 * Cached Apps Freezer 不再冻结它、LMK 不再优先杀它，Rust 心跳线程和
 * QUIC 连接在切后台后照常活着。与会话同生命周期：进入会话视图
 * （Rust 插件 RcKeepalivePlugin.setKeepalive(true)）启动，退出即停。
 *
 * 进程级耦合的安全边界：前台服务与 App 同进程——进程被杀服务陪死，
 * 不存在「会话没了服务还挂着」的孤儿状态（START_NOT_STICKY 双保险：
 * 系统回收后也不复活）。
 *
 * 🔴 gen/ 不入库：`tauri android init` 后须照 docs/dev-运行手册.md 补回
 * 本文件、RcKeepalivePlugin.kt 与 Manifest 声明（CAMERA 同款纪律）。
 */
class RcSessionForegroundService : Service() {
    companion object {
        const val EXTRA_TITLE = "title"
        private const val CHANNEL_ID = "rc_session_keepalive"
        private const val NOTIFICATION_ID = 0x5243 // 'RC'
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: "远程协助进行中"
        startForegroundCompat(buildNotification(title))
        // NOT_STICKY：进程被系统回收时说明整个 App 已死，会话必然已收口，
        // 服务被复活只会挂一个无法消除的空通知。
        return START_NOT_STICKY
    }

    private fun buildNotification(title: String): android.app.Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = android.app.NotificationChannel(
                CHANNEL_ID,
                "远程协助会话",
                android.app.NotificationManager.IMPORTANCE_LOW,
            )
            getSystemService(android.app.NotificationManager::class.java)
                .createNotificationChannel(channel)
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            android.app.Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            android.app.Notification.Builder(this)
        }
        return builder
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("PastePanda 远程")
            .setContentText(title)
            .setOngoing(true)
            .build()
    }

    private fun startForegroundCompat(notification: android.app.Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14+：startForeground 必须显式给类型，与 Manifest 一致
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            @Suppress("DEPRECATION")
            startForeground(NOTIFICATION_ID, notification)
        }
    }
}
