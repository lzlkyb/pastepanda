use tauri::Emitter;

// ===== 自动更新（后台线程，不阻塞 UI） =====

/// 指数退避重试辅助函数
async fn retry_with_backoff<F, Fut, T, E>(
    max_retries: u32,
    operation_name: &str,
    f: F,
) -> Result<T, E>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
    E: std::fmt::Display,
{
    let mut attempt = 0u32;
    loop {
        match f().await {
            Ok(val) => return Ok(val),
            Err(e) => {
                attempt += 1;
                if attempt > max_retries {
                    return Err(e);
                }
                // 指数退避：1s, 2s, 4s, 8s, ...
                let delay_secs = 1u64 << (attempt - 1);
                log::warn!(
                    "[Update] {} 失败（第 {}/{} 次），{} 秒后重试: {}",
                    operation_name,
                    attempt,
                    max_retries,
                    delay_secs,
                    e
                );
                tokio::time::sleep(std::time::Duration::from_secs(delay_secs)).await;
            }
        }
    }
}

/// 后台执行更新检查+下载安装，通过 Tauri event 推送状态到前端
/// 内置指数退避重试：检查更新最多重试 3 次，下载安装最多重试 2 次
#[tauri::command]
pub fn start_update(app: tauri::AppHandle) {
    use tauri_plugin_updater::UpdaterExt;

    tauri::async_runtime::spawn(async move {
        // → 通知前端：检查中
        let _ = app.emit("update:checking", ());

        // 使用 UpdaterExt trait 的方法检查更新
        let updater = match app.updater() {
            Ok(u) => u,
            Err(e) => {
                let _ = app.emit(
                    "update:error",
                    serde_json::json!({
                        "message": format!("更新插件初始化失败: {}", e)
                    }),
                );
                return;
            }
        };

        // 检查更新（带重试，最多 3 次，指数退避 1s/2s/4s）
        let check_result = match retry_with_backoff(3, "检查更新", || updater.check()).await {
            Ok(r) => r,
            Err(e) => {
                let _ = app.emit(
                    "update:error",
                    serde_json::json!({
                        "message": format!("检查更新失败（已重试 3 次）: {}", e)
                    }),
                );
                return;
            }
        };

        let update = match check_result {
            Some(u) => u,
            None => {
                // 已是最新版本
                let _ = app.emit("update:uptodate", ());
                return;
            }
        };

        // → 通知前端：发现新版本
        let _ = app.emit(
            "update:available",
            serde_json::json!({
                "version": update.version,
                "body": update.body,
            }),
        );

        // → 通知前端：开始下载
        let _ = app.emit("update:downloading", ());

        // 下载并安装（带重试，最多 2 次，指数退避 1s/2s）
        let app_progress = app.clone();
        let app_ready = app.clone();
        let result = retry_with_backoff(2, "下载安装", || {
            let u = update.clone();
            let ap = app_progress.clone();
            let ar = app_ready.clone();
            async move {
                u.download_and_install(
                    move |downloaded, total| {
                        let _ = ap.emit(
                            "update:progress",
                            serde_json::json!({
                                "downloaded": downloaded,
                                "total": total,
                            }),
                        );
                    },
                    move || {
                        let _ = ar.emit("update:ready", ());
                    },
                )
                .await
            }
        })
        .await;

        if let Err(e) = result {
            let _ = app.emit(
                "update:error",
                serde_json::json!({
                    "message": format!("下载安装失败（已重试 2 次）: {}", e)
                }),
            );
        }
    });
}
