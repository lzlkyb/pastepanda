package com.pastepanda.app

import android.app.Activity
import android.os.Build
import android.provider.Settings
import android.view.HapticFeedbackConstants
import android.view.ViewTreeObserver
import android.webkit.WebView
import androidx.activity.BackEventCompat
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import org.json.JSONObject

@InvokeArg
class MobileInteractionArgs { var enabled: Boolean = false }

@InvokeArg
class MobileHapticArgs { var kind: String = "" }

/** The frontend owns navigation. Native back previews never pop history or disconnect RC. */
@TauriPlugin
class MobileInteractionPlugin(private val activity: Activity) : Plugin(activity) {
    private var webView: WebView? = null
    private var requested = false
    private var paused = false
    private var gestureActive = false
    private var edge = "left"
    private var callback: OnBackPressedCallback? = null
    private var layoutObserver: ViewTreeObserver? = null
    private val layoutListener = ViewTreeObserver.OnGlobalLayoutListener { refreshEnabled() }

    override fun load(webView: WebView) {
        activity.runOnUiThread {
            detach()
            this.webView = webView
            val owner = activity as? AppCompatActivity ?: return@runOnUiThread
            // Register after Tauri's AppPlugin; only this enabled callback receives a commit.
            val back = object : OnBackPressedCallback(false) {
                override fun handleOnBackStarted(backEvent: BackEventCompat) {
                    edge = if (backEvent.swipeEdge == BackEventCompat.EDGE_RIGHT) "right" else "left"
                    gestureActive = true
                    emit("start", 0f)
                }
                override fun handleOnBackProgressed(backEvent: BackEventCompat) {
                    if (gestureActive) emit("progress", backEvent.progress.coerceIn(0f, 1f))
                }
                override fun handleOnBackCancelled() {
                    cancelGesture()
                    refreshEnabled()
                }
                override fun handleOnBackPressed() {
                    if (!eligible()) { cancelGesture(); return }
                    // Hardware/older Android back has no start callback. It shares the same commit path.
                    if (!gestureActive) { edge = "left"; emit("start", 0f) }
                    gestureActive = false
                    emit("commit", 1f)
                    refreshEnabled()
                }
            }
            callback = back
            owner.onBackPressedDispatcher.addCallback(owner, back)
            val observer = activity.window.decorView.viewTreeObserver
            layoutObserver = observer
            observer.addOnGlobalLayoutListener(layoutListener)
            refreshEnabled()
        }
    }

    @Command
    fun setEnabled(invoke: Invoke) {
        val args = invoke.parseArgs(MobileInteractionArgs::class.java)
        activity.runOnUiThread {
            requested = args.enabled
            refreshEnabled()
            invoke.resolve()
        }
    }

    private fun refreshEnabled() {
        val enabled = eligible()
        if (!enabled) cancelGesture()
        callback?.isEnabled = enabled
    }

    private fun eligible(): Boolean {
        val decor = activity.window.decorView
        val imeVisible = ViewCompat.getRootWindowInsets(decor)?.isVisible(WindowInsetsCompat.Type.ime()) == true
        // Leave IME dismissal and root/activity back with the platform/Tauri callback.
        return requested && !paused && webView != null && !imeVisible
    }

    private fun cancelGesture() {
        if (!gestureActive) return
        gestureActive = false
        emit("cancel", 0f)
    }

    private fun emit(phase: String, progress: Float) {
        val detail = JSONObject().put("phase", phase).put("progress", progress).put("edge", edge)
        webView?.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('mobile-native-back',{detail:$detail}));", null
        )
    }

    @Command
    fun haptic(invoke: Invoke) {
        val args = invoke.parseArgs(MobileHapticArgs::class.java)
        if (args.kind !in setOf("ready", "confirm", "reject")) {
            invoke.reject("不支持的触感类型")
            return
        }
        activity.runOnUiThread {
            val view = webView
            val systemEnabled = Settings.System.getInt(activity.contentResolver, Settings.System.HAPTIC_FEEDBACK_ENABLED, 1) != 0
            if (systemEnabled && view?.hasWindowFocus() == true && view.isHapticFeedbackEnabled) {
                val feedback = when (args.kind) {
                    "ready" -> if (Build.VERSION.SDK_INT >= 34) HapticFeedbackConstants.GESTURE_START else HapticFeedbackConstants.CLOCK_TICK
                    "confirm" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
                    else -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
                }
                // No IGNORE_* flags or raw vibrator: device and user feedback preferences win.
                view.performHapticFeedback(feedback)
            }
            invoke.resolve()
        }
    }

    override fun onPause() {
        activity.runOnUiThread { paused = true; refreshEnabled() }
    }

    override fun onResume() { activity.runOnUiThread { paused = false; refreshEnabled() } }

    override fun onDestroy(activity: AppCompatActivity) { detach() }

    private fun detach() {
        cancelGesture()
        callback?.remove()
        callback = null
        layoutObserver?.let { if (it.isAlive) it.removeOnGlobalLayoutListener(layoutListener) }
        layoutObserver = null
        webView = null
    }
}
