use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
// ❗ `AppHandle::config()` 是固有方法，不需要引 `Manager`（引了反而是 unused 警告）。
use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;

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

// ─── 多源更新端点 ──────────────────────────────────────

/// Gitee 镜像仓库。**只在读不到 tauri.conf.json 的 endpoints 时当兜底用**，
/// 正常路径下三层地址全部取自配置（见 `candidate_endpoint_groups`）。
const GITEE_MANIFEST_URL: &str =
    "https://gitee.com/lzul/pastepanda/raw/releases/latest/updater-gitee.json";

/// 解析环境变量覆盖的更新端点
/// `PASTEPANDA_UPDATE_ENDPOINT` 逗号分隔的 URL 列表，优先级最高
fn resolve_env_endpoints() -> Option<Vec<String>> {
    std::env::var("PASTEPANDA_UPDATE_ENDPOINT")
        .ok()
        .map(|val| {
            val.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|v: &Vec<String>| !v.is_empty())
}

/// 读 tauri.conf.json 的 `plugins.updater.endpoints`。读不到就返回空。
fn configured_endpoints(app: &tauri::AppHandle) -> Vec<String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("endpoints"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// 候选更新端点组（按优先级排列）。**每组只放一个 URL。**
///
/// # 🔴 「每组一个」是事故修法，不是风格问题
///
/// tauri-plugin-updater 的 endpoints 列表是「**取到第一个能解析的 manifest 就 break**」
/// （2.10.1 `updater.rs:412-501` 实证），它只对 **manifest** 做 failover，
/// 对后续的 **exe 下载不做**。
///
/// 旧写法的第二组是 `None`（= 用 tauri.conf.json 那三条），而那三条的
/// **第一条又是 Gitee**。于是 2026-09-06 v7.1.1 出事时：
///   组 1 取到 Gitee manifest → exe 404 → 下载失败
///   组 2 再跑一遍 → 仍停在同一个 Gitee manifest → 同一个 404
/// ghproxy 与 GitHub 直连**一次都没轮到**——名义上的兜底实际是把组 1 重放了一遍，
/// 故障从「降级到慢线路」变成了「全线瘫痪」。
/// 拆成一组一个之后，每条 endpoint 才真正各自获得一次「manifest + exe」的完整机会。
///
/// 顺序取自 tauri.conf.json 的 `plugins.updater.endpoints`（Gitee → ghproxy → GitHub），
/// **不在这里再抄一份**：抄一份就会漂移，而漂移的表现是「配置改了但没生效」。
///
/// ❗ 三条 endpoint 必须各自 manifest 与 exe 同主机（CI 为此生成了
///   updater-gitee.json / updater-ghproxy.json / updater.json 三份）。
///   若两条 endpoint 指向同一份 manifest，多出来的那层只代理了 3KB 的 JSON，
///   里面 20MB 的 exe 还是走原主机——那种兜底不兜底。
fn candidate_endpoint_groups(app: &tauri::AppHandle) -> Vec<Vec<String>> {
    // 环境变量覆盖（开发/测试用）优先级最高
    if let Some(eps) = resolve_env_endpoints() {
        log::info!("[Update] 使用环境变量端点: {:?}", eps);
        return vec![eps];
    }

    let configured = configured_endpoints(app);
    if configured.is_empty() {
        // 配置读不到时宁可只剩一层，也不能一层都没有（那就是彻底不能更新了）
        log::warn!("[Update] tauri.conf.json 里没读到 updater.endpoints，退回内置 Gitee 源");
        return vec![vec![GITEE_MANIFEST_URL.to_string()]];
    }
    log::info!("[Update] 共 {} 层兜底：{:?}", configured.len(), configured);
    configured.into_iter().map(|u| vec![u]).collect()
}

/// 构建 Updater 实例。
///
/// ❗ 端点**总是显式传入**，不再有「传 None 就用 tauri.conf.json 默认列表」这条路——
///   那条路会把三条 endpoint 一起交给插件，而插件取到第一个 manifest 就停，
///   等于把我们自己的分层 failover 短路掉（见 `candidate_endpoint_groups`）。
/// 对齐 cc-bridge 的 builder 模式：endpoints() 返回 Result，需 map_err 后 ?。
fn build_updater(
    app: &tauri::AppHandle,
    endpoints: &[String],
) -> Result<tauri_plugin_updater::Updater, String> {
    let parsed: Vec<url::Url> = endpoints
        .iter()
        .filter_map(|u| url::Url::parse(u).ok())
        .collect();
    if parsed.is_empty() {
        return Err("所有自定义端点 URL 均无效".to_string());
    }
    app.updater_builder()
        .endpoints(parsed)
        .map_err(|e| format!("更新源配置无效（需 https）: {e}"))?
        .build()
        .map_err(|e| format!("Updater 初始化失败: {e}"))
}

// ─── check_update 命令 ─────────────────────────────────

/// 仅检查更新（不下载），支持多源 failover。
/// 前端通过此命令统一走 Rust 多源路径，避免 JS 插件单源检查。
#[tauri::command]
pub async fn check_update(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let groups = candidate_endpoint_groups(&app);

    let mut last_error = String::new();

    for (i, group) in groups.iter().enumerate() {
        let source_label = group.first().map(|s| s.as_str()).unwrap_or("custom");
        log::info!("[Update] 尝试更新源 {}/{}: {}", i + 1, groups.len(), source_label);

        let updater = match build_updater(&app, group) {
            Ok(u) => u,
            Err(e) => {
                last_error = e;
                continue;
            }
        };

        match retry_with_backoff(2, &format!("检查更新({})", source_label), || updater.check()).await {
            Ok(Some(update)) => {
                log::info!("[Update] 发现新版本 v{} (源: {})", update.version, source_label);
                return Ok(Some(serde_json::json!({
                    "version": update.version,
                    "body": update.body,
                })));
            }
            Ok(None) => {
                log::info!("[Update] 已是最新版本 (源: {})", source_label);
                return Ok(None);
            }
            Err(e) => {
                last_error = e.to_string();
                log::warn!("[Update] 源 {} 失败: {}", source_label, last_error);
                continue;
            }
        }
    }

    Err(format!("所有更新源均失败: {}", last_error))
}

// ─── start_update 命令 ─────────────────────────────────

/// 后台执行更新检查+下载安装，通过 Tauri event 推送状态到前端。
/// 支持多源 failover：按优先级尝试 Gitee → ghproxy → GitHub。
#[tauri::command]
pub fn start_update(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let _ = app.emit("update:checking", ());

        let groups = candidate_endpoint_groups(&app);
        let mut last_error = String::new();

        for (i, group) in groups.iter().enumerate() {
            let source_label = group.first().map(|s| s.as_str()).unwrap_or("custom");
            log::info!("[Update] 下载尝试源 {}/{}: {}", i + 1, groups.len(), source_label);

            let updater = match build_updater(&app, group) {
                Ok(u) => u,
                Err(e) => {
                    last_error = e;
                    continue;
                }
            };

            // 检查更新（带重试，最多 2 次）
            let update = match retry_with_backoff(2, &format!("检查更新({})", source_label), || updater.check()).await {
                Ok(Some(u)) => u,
                Ok(None) => {
                    let _ = app.emit("update:uptodate", ());
                    return;
                }
                Err(e) => {
                    last_error = e.to_string();
                    log::warn!("[Update] 源 {} 检查失败: {}", source_label, last_error);
                    continue;
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

            // 下载并安装（带重试，最多 2 次）
            let app_progress = app.clone();
            let app_ready = app.clone();
            let result = retry_with_backoff(2, &format!("下载安装({})", source_label), || {
                let u = update.clone();
                let ap = app_progress.clone();
                let ar = app_ready.clone();
                // 累加器建在闭包内部：重试时每次尝试重新从 0 开始，与重新下载的事实一致；
                // 建在外面会让第二次尝试从上次的字节数接着涨，直接超过 100%。
                let acc = Arc::new(AtomicU64::new(0));
                async move {
                    u.download_and_install(
                        // ⚠ 第一个参数是 **本次 chunk 的字节数**，不是累计下载量。
                        // 插件内部就是 `on_chunk(chunk.len(), content_length)`
                        // （tauri-plugin-updater 2.10.1 的 updater.rs）。
                        // 原实现直接当累计值发给前端，而前端算 downloaded/total，
                        // 于是 8KB/7.6MB ≈ 0 —— 进度条全程停在 0%、速率是两个 chunk 相减的
                        // 噪声（常为负）、“已下载 MB”也只是最后一个 chunk 的大小。
                        // 在这里累加，前端三处显示同时恢复，且 downloaded 字段名终于名副其实。
                        move |chunk_len, total| {
                            let downloaded =
                                acc.fetch_add(chunk_len as u64, Ordering::Relaxed) + chunk_len as u64;
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

            match result {
                Ok(()) => return, // 下载成功，已 emit update:ready
                Err(e) => {
                    last_error = e.to_string();
                    log::warn!("[Update] 源 {} 下载失败: {}", source_label, last_error);
                    continue;
                }
            }
        }

        // 所有源均失败
        let _ = app.emit(
            "update:error",
            serde_json::json!({
                "message": format!("所有更新源均失败: {}", last_error)
            }),
        );
    });
}
