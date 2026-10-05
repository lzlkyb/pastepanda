package com.pastepanda.app

import android.app.Activity
import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class NetworkWatchArgs {
    lateinit var channel: Channel
}

/** Android 不向 iroh 原生网络监测暴露切网事件，必须通过共享端点主动刷新。 */
@TauriPlugin
class IrohNetworkPlugin(private val activity: Activity) : Plugin(activity) {
    private val manager = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private var callback: ConnectivityManager.NetworkCallback? = null

    @Command
    fun startWatching(invoke: Invoke) {
        if (callback != null) {
            invoke.resolve()
            return
        }
        val channel = invoke.parseArgs(NetworkWatchArgs::class.java).channel
        val observer = object : ConnectivityManager.NetworkCallback() {
            private var lastLinks = ""

            private fun changed(reason: String, network: Network) {
                val event = JSObject()
                event.put("reason", reason)
                event.put("network", network.toString())
                channel.send(event)
            }

            override fun onAvailable(network: Network) = changed("available", network)
            override fun onLost(network: Network) = changed("lost", network)
            override fun onLinkPropertiesChanged(network: Network, properties: LinkProperties) {
                // DNS/MTU 回调不必重复触发公网探测，网络和本机地址改变才刷新。
                val links = network.toString() + properties.linkAddresses.map { it.toString() }.sorted().joinToString()
                if (links != lastLinks) {
                    lastLinks = links
                    changed("addresses", network)
                }
            }
        }
        try {
            manager.registerDefaultNetworkCallback(observer)
            callback = observer
            invoke.resolve()
        } catch (error: Exception) {
            invoke.reject(error.message ?: "network watcher failed")
        }
    }

    override fun onDestroy(activity: AppCompatActivity) {
        callback?.let { manager.unregisterNetworkCallback(it) }
        callback = null
        super.onDestroy(activity)
    }
}
