//! Android 切网通知只刷新已有共享端点，不能为某个业务重新绑定同身份端点。

#[cfg(any(target_os = "android", test))]
async fn next_change(rx: &mut tokio::sync::watch::Receiver<()>) -> bool {
    if rx.changed().await.is_err() { return false; }
    // 切网的一组 available/lost/address 回调合并，避免并发刷新。
    loop {
        tokio::select! {
            result = rx.changed() => {
                if result.is_err() { return false; }
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(250)) => return true,
        }
    }
}

pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("irohnetwork")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin("com.pastepanda.app", "IrohNetworkPlugin")?;
                let (tx, mut rx) = tokio::sync::watch::channel(());
                let channel = tauri::ipc::Channel::<serde_json::Value>::new(move |_| {
                    let _ = tx.send(());
                    Ok(())
                });
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(error) = handle.run_mobile_plugin::<()>(
                        "startWatching", serde_json::json!({ "channel": channel }),
                    ) {
                        log::warn!("[IROH-NETWORK] Android 通知注册失败：{error}");
                    }
                });
                tauri::async_runtime::spawn(async move {
                    while next_change(&mut rx).await {
                        crate::rc::underlay::network_changed();
                        if let Some(ep) = super::SHARED.get() {
                            log::info!("[IROH-NETWORK] Android 网络改变，刷新共享端点");
                            ep.network_change().await;
                        }
                    }
                });
            }
            let _ = (app, api);
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn network_callback_batch_triggers_one_refresh() {
        let (tx, mut rx) = tokio::sync::watch::channel(());
        tx.send(()).unwrap();
        let updates = async {
            tokio::task::yield_now().await;
            tx.send(()).unwrap();
            tokio::task::yield_now().await;
            tx.send(()).unwrap();
        };
        let (refresh, ()) = tokio::join!(next_change(&mut rx), updates);
        assert!(refresh);
        assert!(tokio::time::timeout(Duration::from_millis(20), next_change(&mut rx)).await.is_err());
        drop(tx);
        assert!(!next_change(&mut rx).await);
    }

    #[tokio::test]
    async fn closed_callback_channel_does_not_refresh_or_spin() {
        let (tx, mut rx) = tokio::sync::watch::channel(());
        drop(tx);
        assert!(!next_change(&mut rx).await);
    }
}
