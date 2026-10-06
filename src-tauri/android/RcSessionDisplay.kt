package com.pastepanda.app

import android.app.Activity
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/** UI-thread only. A session owns display state; an old session's cleanup cannot reset its successor. */
class RcSessionDisplay(private val activity: Activity) {
    private var sessionId: String? = null
    private var originalOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    private var originalBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_DEFAULT

    fun set(owner: String, on: Boolean, orientation: String) {
        require(owner.isNotBlank()) { "会话标识不能为空" }
        val requestedOrientation = when (orientation) {
            "system" -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            "portrait" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
            "landscape" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            else -> throw IllegalArgumentException("不支持的屏幕方向")
        }
        if (!on) {
            if (sessionId != owner) return
            sessionId = null
            val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
            controller.systemBarsBehavior = originalBarsBehavior
            controller.show(WindowInsetsCompat.Type.systemBars())
            activity.requestedOrientation = originalOrientation
            return
        }
        if (sessionId == null) {
            originalOrientation = activity.requestedOrientation
            originalBarsBehavior = WindowCompat.getInsetsController(activity.window, activity.window.decorView).systemBarsBehavior
        }
        sessionId = owner
        if (activity.requestedOrientation != requestedOrientation) {
            activity.requestedOrientation = requestedOrientation
        }
        reapply()
    }

    fun reapply() {
        if (sessionId == null) return
        val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        // IME resizes WebView, but does not change device orientation. Never use frontend viewport height here.
        if (activity.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE) {
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            controller.systemBarsBehavior = originalBarsBehavior
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
    }
}
