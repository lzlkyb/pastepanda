use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
// ❗ `AppHandle::config()` 是固有方法，不需要引 `Manager`（引了反而是 unused 警告）。
use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;

// ─── 慢源看门狗（纯逻辑，便于单测） ─────────────────────
//
// 背景（2026-09-16 实测）：Gitee 发行版附件走 foruda.gitee.com，稳定约 70KB/s；
// ghproxy 同文件约 1.9MB/s。插件的 endpoints 只对 **manifest** failover，
// 对 exe 下载不做——manifest 通了就锁死这条源，慢到天荒地老也不换。
// 看门狗负责在 **下载阶段** 主动中止过慢的源，让外层 for 循环轮到下一组。

/// 下载均速下限（字节/秒）。低于此值视为慢源。
/// 取 100KB/s：实测 Gitee 附件 47–73KB/s 会触发切换；ghproxy ~1.9MB/s 远超；
/// 家用宽带只要不是极慢线路，正常下载都会远高于此。
pub const MIN_DOWNLOAD_SPEED_BPS: u64 = 100 * 1024;

/// 宽限期（秒）：连接建立 + TLS + 首包延迟都算在这段里，期间不判慢。
pub const SPEED_GRACE_SECS: f64 = 8.0;

/// 看门狗采样间隔。
const SPEED_POLL_SECS: u64 = 1;

/// 是否判定当前下载过慢。
///
/// - 宽限期内一律 `false`（避免把「还没开始吐数据」误杀成慢源）。
/// - 过了宽限期后用 `downloaded / max(elapsed, grace)` 算均速，
///   分母至少按宽限期计，避免刚过线时分母过小导致误杀。
pub fn is_download_too_slow(elapsed_secs: f64, downloaded_bytes: u64) -> bool {
    if elapsed_secs < SPEED_GRACE_SECS {
        return false;
    }
    let elapsed = elapsed_secs.max(SPEED_GRACE_SECS);
    let bps = downloaded_bytes as f64 / elapsed;
    bps < MIN_DOWNLOAD_SPEED_BPS as f64
}

/// 下载阶段的失败分类：慢源要 **立刻换源**，普通错误才走同源重试。
enum DownloadOutcome {
    /// 下载+验签成功，包在内存里，尚未 install。
    Downloaded(Vec<u8>),
    /// download + install 都成功（macOS/Linux 会走到；Windows 上 install 直接退出进程，到不了）。
    Success,
    /// 均速过慢，已中止。携带触发时的均速（B/s），仅用于日志。
    TooSlow {
        avg_bps: u64,
    },
    Failed(String),
}

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

/// 下载并安装，外层竞速看门狗：均速过慢就丢弃下载 future，让调用方切下一源。
///
/// ❗ 过慢 **不走** 同源重试——对慢源重试只是再花一遍时间确认它很慢。
/// 普通错误（404 / 签名失败 / 瞬时网络）仍由调用方决定是否重试。
///
/// # 为什么必须拆成 `download` → emit ready → `install`
///
/// 插件的 `download_and_install` 在 Windows 上 **不会返回**：`install_inner`
/// 里 `ShellExecuteW` 之后直接 `std::process::exit(0)`（2.10.1 实证）。
/// 所以 ready 不能等 `download_and_install` 的返回值——那条路在 Windows 是死的。
///
/// 同时 ready 也不能塞回 `on_download_finish`：那个回调在 **签名验证之前**
/// 就跑（插件 `download` 末尾），验签失败时前端会假显示「可重启」。
///
/// 正确顺序：download（内含验签）成功 → emit ready → install（Windows 上退出进程）。
///
/// # `enable_watchdog` 为什么存在
///
/// 最后一源必须关掉看门狗。若用户带宽 < 100KB/s 且三条源都慢，
/// 看门狗会把三次下载全部掐断 → **彻底无法更新**。
/// 慢，好过断。前面的源用来「换更快的」，最后一源用来「保证能下完」。
async fn download_with_speed_guard(
    update: &tauri_plugin_updater::Update,
    app: &tauri::AppHandle,
    enable_watchdog: bool,
) -> DownloadOutcome {
    let app_progress = app.clone();
    let app_ready = app.clone();
    let u_dl = update.clone();
    let u_install = update.clone();
    let acc = Arc::new(AtomicU64::new(0));
    let acc_watch = acc.clone();
    // download 流结束（含验签）后置位，让看门狗立刻退出，
    // 避免在 install 阶段用「不再增长的字节数 / 继续走的时钟」
    // 把均速算塌、误杀一个已经下完的包。
    let download_settled = Arc::new(AtomicBool::new(false));
    let settled_watch = download_settled.clone();
    let started = Instant::now();

    let download_fut = async move {
        // 只 download + 验签，不 install——install 在 ready 之后单独调。
        let result = u_dl
            .download(
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
                    let _ = app_progress.emit(
                        "update:progress",
                        serde_json::json!({
                            "downloaded": downloaded,
                            "total": total,
                        }),
                    );
                },
                || {},
            )
            .await;
        // 无论成败，下载+验签阶段都算结束，看门狗不应再按「字节不再涨」判慢。
        download_settled.store(true, Ordering::Relaxed);
        result
    };

    let watchdog_fut = async move {
        if !enable_watchdog {
            // 最后一源：不判慢，把裁决权完全交给 download_fut。
            std::future::pending::<()>().await;
        }
        loop {
            tokio::time::sleep(Duration::from_secs(SPEED_POLL_SECS)).await;
            if settled_watch.load(Ordering::Relaxed) {
                // 下载流已结束：挂起自己。❗ 不能 return Success——下载可能是 Err。
                std::future::pending::<()>().await;
            }
            let elapsed = started.elapsed().as_secs_f64();
            let downloaded = acc_watch.load(Ordering::Relaxed);
            if is_download_too_slow(elapsed, downloaded) {
                let avg_bps = (downloaded as f64 / elapsed.max(SPEED_GRACE_SECS)) as u64;
                return DownloadOutcome::TooSlow { avg_bps };
            }
        }
    };

    // biased：同拍就绪时优先看 download_fut，避免「刚下完就被判慢」误杀。
    let outcome = tokio::select! {
        biased;
        r = download_fut => match r {
            Ok(bytes) => DownloadOutcome::Downloaded(bytes),
            Err(e) => DownloadOutcome::Failed(e.to_string()),
        },
        outcome = watchdog_fut => outcome,
    };

    // 只有验签通过的完整包才走到这里。
    let DownloadOutcome::Downloaded(bytes) = outcome else {
        return outcome;
    };

    // ready 必须在验签之后、install 之前：Windows 上 install 会直接退出进程，
    // 这是前端能收到的最后一个事件。
    let _ = app_ready.emit("update:ready", ());

    match u_install.install(bytes) {
        Ok(()) => DownloadOutcome::Success,
        Err(e) => DownloadOutcome::Failed(e.to_string()),
    }
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
        log::info!(
            "[Update] 尝试更新源 {}/{}: {}",
            i + 1,
            groups.len(),
            source_label
        );

        let updater = match build_updater(&app, group) {
            Ok(u) => u,
            Err(e) => {
                last_error = e;
                continue;
            }
        };

        match retry_with_backoff(2, &format!("检查更新({})", source_label), || {
            updater.check()
        })
        .await
        {
            Ok(Some(update)) => {
                log::info!(
                    "[Update] 发现新版本 v{} (源: {})",
                    update.version,
                    source_label
                );
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
            log::info!(
                "[Update] 下载尝试源 {}/{}: {}",
                i + 1,
                groups.len(),
                source_label
            );

            let updater = match build_updater(&app, group) {
                Ok(u) => u,
                Err(e) => {
                    last_error = e;
                    continue;
                }
            };

            // 检查更新（带重试，最多 2 次）
            let update =
                match retry_with_backoff(2, &format!("检查更新({})", source_label), || {
                    updater.check()
                })
                .await
                {
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

            // 下载并安装：普通错误同源重试；**过慢立刻切源、不重试**（重试慢源只是再慢一遍）。
            // 最后一源关掉看门狗：三条源都慢时，慢也要下完，否则用户彻底无法更新。
            let is_last_source = i + 1 == groups.len();
            let enable_watchdog = !is_last_source;
            let mut last_dl_err = String::new();
            let mut switched = false;
            for attempt in 0..=2 {
                if attempt > 0 {
                    let delay = 1u64 << (attempt - 1);
                    log::warn!(
                        "[Update] 下载安装({}) 第 {} 次重试，{} 秒后: {}",
                        source_label,
                        attempt,
                        delay,
                        last_dl_err
                    );
                    tokio::time::sleep(Duration::from_secs(delay)).await;
                }

                match download_with_speed_guard(&update, &app, enable_watchdog).await {
                    DownloadOutcome::Success => return,
                    // Downloaded 不应逃出 download_with_speed_guard（内部已 install）。
                    // 真出现了就当失败去切源/报错，绝不能静默 return 假装装好了。
                    DownloadOutcome::Downloaded(_) => {
                        last_error = "内部状态异常：下载完成但未安装".to_string();
                        last_dl_err = last_error.clone();
                    }
                    DownloadOutcome::TooSlow { avg_bps } => {
                        log::warn!(
                            "[Update] 源 {} 下载过慢（约 {} KB/s，阈值 {} KB/s），切换下一源",
                            source_label,
                            avg_bps / 1024,
                            MIN_DOWNLOAD_SPEED_BPS / 1024
                        );
                        let _ = app.emit(
                            "update:source_slow",
                            serde_json::json!({
                                "source": source_label,
                                "avg_bps": avg_bps,
                                "threshold_bps": MIN_DOWNLOAD_SPEED_BPS,
                            }),
                        );
                        last_error =
                            format!("源 {} 下载过慢（约 {} KB/s）", source_label, avg_bps / 1024);
                        switched = true;
                        break;
                    }
                    DownloadOutcome::Failed(e) => {
                        last_dl_err = e;
                        last_error = last_dl_err.clone();
                    }
                }
            }
            if !switched {
                log::warn!("[Update] 源 {} 下载失败: {}", source_label, last_error);
            }
            continue;
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

#[cfg(test)]
mod tests {
    // 测试名有意用中文（守卫/回归钉的业务语义直接写在名字里）。
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn 宽限期内不判慢_即使零字节() {
        assert!(!is_download_too_slow(0.0, 0));
        assert!(!is_download_too_slow(7.9, 0));
        assert!(!is_download_too_slow(SPEED_GRACE_SECS - 0.01, 0));
    }

    #[test]
    fn 宽限期后零字节算慢() {
        assert!(is_download_too_slow(8.0, 0));
        assert!(is_download_too_slow(30.0, 0));
    }

    #[test]
    fn 实测_Gitee档约70KBps_应判慢() {
        // 12 秒下了约 70KB/s → 840KB；均速 70KB/s < 100KB/s
        let bytes = 70 * 1024 * 12;
        assert!(is_download_too_slow(12.0, bytes));
    }

    #[test]
    fn 实测_ghproxy档约1点9MBps_不应判慢() {
        // 12 秒约 1.9MB/s → 远超阈值
        let bytes = (1.9 * 1024.0 * 1024.0 * 12.0) as u64;
        assert!(!is_download_too_slow(12.0, bytes));
    }

    #[test]
    fn 恰好阈值不算慢() {
        let bytes = MIN_DOWNLOAD_SPEED_BPS * 8;
        assert!(!is_download_too_slow(8.0, bytes));
    }

    #[test]
    fn 刚过宽限期时分母至少按宽限期计_避免误杀() {
        // 8.1s 下了 800KB ≈ 98KB/s，接近阈值；分母 max(8.1, 8)=8.1
        // 若误用极短 elapsed（如把 0.1s 当分母）会把 800KB/0.1s 算成超快而漏判，
        // 这里验证正确语义：仍按真实 elapsed 判慢
        let bytes = 800 * 1024;
        assert!(is_download_too_slow(8.1, bytes));
        // 同样字节若 elapsed 更长更慢，必然判慢
        assert!(is_download_too_slow(10.0, bytes));
    }
}
