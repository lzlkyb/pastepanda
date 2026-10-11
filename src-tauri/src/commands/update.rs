use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, Instant};
// ❗ `AppHandle::config()` 是固有方法，不需要引 `Manager`（引了反而是 unused 警告）。
use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;

fn update_available_for_platform(is_macos:bool,artifacts_enabled:bool)->bool { !is_macos || artifacts_enabled }
fn require_update_available(app:&tauri::AppHandle)->Result<(),String>{
    let enabled=!matches!(app.config().bundle.create_updater_artifacts,tauri::utils::config::Updater::Bool(false));
    if update_available_for_platform(cfg!(target_os="macos"),enabled){Ok(())}
    else{Err("此 Mac 版本暂未提供自动更新，请使用后续正式安装包".into())}
}

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
pub(crate) async fn retry_with_backoff<F, Fut, T, E>(
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

/// manifest 检查的单次请求上限（秒）。
///
/// 取 15s 的依据（2026-10-10 实测）：三条源**健康**时响应 0.5–2.5s，而 ghproxy 被限流时
/// 单次要挂 60s 才吐一个非 2xx。不设上限时「3 条源 ×3 次尝试」最坏要 4 分半，
/// 期间界面只有转圈——用户看到的是「更新失败」，实际是卡在一条死源上重试。
///
/// ❗ 只作用于 manifest 检查，不会影响 exe 下载：插件构造 `Update` 时把下载侧的
///   timeout 写死为 `None`（tauri-plugin-updater 2.10.1 `updater.rs:553`），
///   慢下载由上面的看门狗负责。别把这个值当成「下载超时」去调小。
pub const MANIFEST_CHECK_TIMEOUT_SECS: u64 = 15;

/// 本次进程内「上一次真正取到 manifest 的源」。
static LAST_GOOD_SOURCE: OnceLock<RwLock<Option<String>>> = OnceLock::new();

fn last_good_slot() -> &'static RwLock<Option<String>> {
    LAST_GOOD_SOURCE.get_or_init(|| RwLock::new(None))
}

/// 记下成功的源。写失败不影响任何逻辑（最坏就是下次仍从配置的第一条试起）。
pub(crate) fn record_good_source(url: &str) {
    if let Ok(mut slot) = last_good_slot().write() {
        *slot = Some(url.to_string());
    }
}

pub(crate) fn last_good_source() -> Option<String> {
    last_good_slot().read().ok().and_then(|v| v.clone())
}

/// 把满足 `pred` 的那一项提到最前，返回是否发生了移动（第 0 项命中也算没移动）。
///
/// 存在的理由：**「检查更新」和「下载更新」是两条独立的多源 failover**，后者不记得
/// 前者刚才是从哪条源拿到 manifest 的。2026-10-10 14:24 就是这样出的事——
/// 14:24:05 从 ghproxy 查到了 v7.2.11，用户 14:25 点「更新」，`start_update`
/// 又从第 1 条 Gitee 重头跑，撞上 Gitee 通道 404 + ghproxy 限流 + GitHub 直连被墙，
/// 一个「本来能更新」的会话被重放成了「所有源均失败」。
pub fn move_matching_to_front<T>(items: &mut Vec<T>, pred: impl Fn(&T) -> bool) -> bool {
    let Some(idx) = items.iter().position(pred) else {
        return false;
    };
    if idx == 0 {
        return false;
    }
    let item = items.remove(idx);
    items.insert(0, item);
    true
}

/// 源的短名，只用于失败文案——三条完整 URL 塞进 toast 是读不出东西的。
pub fn source_name(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let host = rest.split('/').next().unwrap_or("").to_lowercase();
    if host.contains("gitee.com") {
        "Gitee".to_string()
    } else if host.contains("ghproxy") {
        "ghproxy".to_string()
    } else if host == "github.com" {
        "GitHub".to_string()
    } else {
        host
    }
}

/// 截断到 `max` 个字符（按字符不按字节，避免切进中文中间）。
fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let kept: String = s.chars().take(max).collect();
    format!("{kept}…")
}

/// 汇总每条源的失败原因。
///
/// 旧写法只带**最后一条**源的错误，而三条源的失败原因往往各不相同
/// （Gitee 是 404、ghproxy 是限流、GitHub 是被墙）。用户报上来的「error sending
/// request for url(...github...)」因此完全指不到真正坏掉的那条通道。
pub fn format_source_failures(attempts: &[(String, String)]) -> String {
    if attempts.is_empty() {
        return "没有可用的更新源".to_string();
    }
    let parts: Vec<String> = attempts
        .iter()
        .map(|(url, err)| format!("{}→{}", source_name(url), clip(err, 120)))
        .collect();
    format!("所有更新源均失败: {}", parts.join(" | "))
}

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
    let mut groups: Vec<Vec<String>> = configured.into_iter().map(|u| vec![u]).collect();
    // 先试上次成功的那条源（详见 `move_matching_to_front`）。
    if let Some(last_good) = last_good_source() {
        let hit = |g: &Vec<String>| g.first().map(String::as_str) == Some(last_good.as_str());
        if move_matching_to_front(&mut groups, hit) {
            log::info!("[Update] 优先复用上次成功的更新源: {}", last_good);
        }
    }
    groups
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
    // 🔴 mobile 守卫（2026-09-30 真机实证）：UpdaterState 只在 desktop 分支 manage
    //    （见 lib.rs 的 #[cfg(desktop)] 注册），而 app.updater_builder() 内部
    //    `state::<UpdaterState>()` 未注册即 panic——且 panic 在线程里，IPC 调用方
    //    只看到连接断。任何入口在 mobile 下调到这里都应得到错误而不是进程 panic。
    if !cfg!(desktop) {
        return Err("自动更新仅桌面端支持".to_string());
    }
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
        .timeout(Duration::from_secs(MANIFEST_CHECK_TIMEOUT_SECS))
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
///
/// 🔴 Android 分派（方案甲，2026-10-03）：插件路径在移动端不可用
/// （见 `build_updater` 的 mobile 守卫），改走 `update_android` 的
/// apk-update.json 直检；**返回 shape 与事件名与桌面完全一致**，
/// 前端与其余调用点不分派、不感知。
#[tauri::command]
pub async fn check_update(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    require_update_available(&app)?;
    #[cfg(target_os = "android")]
    {
        return super::update_android::check_apk_update(&app).await;
    }
    #[cfg(not(target_os = "android"))]
    {
        let groups = candidate_endpoint_groups(&app);

        let mut attempts: Vec<(String, String)> = Vec::new();

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
                    attempts.push((source_label.to_string(), e));
                    continue;
                }
            };

            match retry_with_backoff(2, &format!("检查更新({})", source_label), || {
                updater.check()
            })
            .await
            {
                Ok(Some(update)) => {
                    record_good_source(source_label);
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
                    // 拿到 manifest 只是版本不比当前新——这条源同样是活的，照样记下来。
                    record_good_source(source_label);
                    log::info!("[Update] 已是最新版本 (源: {})", source_label);
                    return Ok(None);
                }
                Err(e) => {
                    let err = e.to_string();
                    log::warn!("[Update] 源 {} 失败: {}", source_label, err);
                    attempts.push((source_label.to_string(), err));
                    continue;
                }
            }
        }

        Err(format_source_failures(&attempts))
    }
}

// ─── start_update 命令 ─────────────────────────────────

/// 后台执行更新检查+下载安装，通过 Tauri event 推送状态到前端。
/// 支持多源 failover：按优先级尝试 Gitee → ghproxy → GitHub。
/// Android 分派到 `update_android::spawn_apk_update`（同事件契约，见 check_update 注释）。
#[tauri::command]
pub fn start_update(app: tauri::AppHandle) {
    if let Err(message)=require_update_available(&app){let _=app.emit("update:error",serde_json::json!({"message":message}));return;}
    #[cfg(target_os = "android")]
    {
        super::update_android::spawn_apk_update(app);
        return;
    }
    #[cfg(not(target_os = "android"))]
    {
        spawn_desktop_update(app);
    }
}

#[cfg(not(target_os = "android"))]
fn spawn_desktop_update(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let _ = app.emit("update:checking", ());

        let groups = candidate_endpoint_groups(&app);
        let mut attempts: Vec<(String, String)> = Vec::new();

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
                    attempts.push((source_label.to_string(), e));
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
                    Ok(Some(u)) => {
                        record_good_source(source_label);
                        u
                    }
                    Ok(None) => {
                        record_good_source(source_label);
                        let _ = app.emit("update:uptodate", ());
                        return;
                    }
                    Err(e) => {
                        let err = e.to_string();
                        log::warn!("[Update] 源 {} 检查失败: {}", source_label, err);
                        attempts.push((source_label.to_string(), err));
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
                        last_dl_err = "内部状态异常：下载完成但未安装".to_string();
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
                        last_dl_err = format!("下载过慢（约 {} KB/s）", avg_bps / 1024);
                        switched = true;
                        break;
                    }
                    DownloadOutcome::Failed(e) => {
                        last_dl_err = e;
                    }
                }
            }
            if !switched {
                log::warn!("[Update] 源 {} 下载失败: {}", source_label, last_dl_err);
            }
            attempts.push((source_label.to_string(), last_dl_err));
            continue;
        }

        // 所有源均失败
        let _ = app.emit(
            "update:error",
            serde_json::json!({
                "message": format_source_failures(&attempts)
            }),
        );
    });
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]
    #[test]fn mac_updates_require_explicitly_enabled_release_artifacts(){
        assert!(!super::update_available_for_platform(true,false));assert!(super::update_available_for_platform(true,true));assert!(super::update_available_for_platform(false,false));
    }
    // 测试名有意用中文（守卫/回归钉的业务语义直接写在名字里）。

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

    // ===== 源位记忆 / 失败汇总（2026-10-10「三条源全灭」事故的回归用例） =====

    /// 与 tauri.conf.json 的 `plugins.updater.endpoints` 同构的三条源。
    fn three_groups() -> Vec<Vec<String>> {
        [
            "https://gitee.com/lzul/pastepanda/raw/releases/latest/updater-gitee.json",
            "https://ghproxy.net/https://github.com/lzlkyb/pastepanda/releases/latest/download/updater-ghproxy.json",
            "https://github.com/lzlkyb/pastepanda/releases/latest/download/updater.json",
        ]
        .iter()
        .map(|u| vec![u.to_string()])
        .collect()
    }

    /// 取源码里某个 `fn` 的函数体文本（按行切，LF/CRLF 检出都能用）。
    /// 只测纯函数的话，把**调用点**删掉照样全绿——下面几条守卫钉的就是调用点。
    fn fn_body(sig_prefix: &str) -> String {
        let src = include_str!("update.rs");
        let lines: Vec<&str> = src.lines().collect();
        let start = lines
            .iter()
            .position(|l| l.trim_start().starts_with(sig_prefix))
            .unwrap_or_else(|| panic!("找不到 {sig_prefix}"));
        let rest = &lines[start + 1..];
        let end = rest
            .iter()
            .position(|l| l.trim_end() == "}")
            .expect("函数结尾的顶格花括号");
        lines[start..start + 1 + end].join("\n")
    }

    #[test]
    fn 上次成功的源会被提到首位且不多不少() {
        let ghproxy = "https://ghproxy.net/https://github.com/lzlkyb/pastepanda/releases/latest/download/updater-ghproxy.json";
        let mut groups = three_groups();
        let moved = move_matching_to_front(&mut groups, |g| {
            g.first().map(String::as_str) == Some(ghproxy)
        });
        assert!(moved, "第 2 条源命中时必须真的换位");
        assert_eq!(groups.len(), 3, "轮转不许丢源");
        assert!(groups[0][0].starts_with("https://ghproxy.net/"));
        // 其余两源保持原有相对顺序：Gitee 仍排在 GitHub 前面
        assert!(groups[1][0].contains("gitee.com"));
        assert!(groups[2][0].starts_with("https://github.com"));
    }

    #[test]
    fn 命中的源本来就在首位则不算移动() {
        let mut groups = three_groups();
        let moved = move_matching_to_front(&mut groups, |g| g[0].contains("gitee.com"));
        assert!(!moved);
        assert!(groups[0][0].contains("gitee.com"));
    }

    #[test]
    fn 没记到成功源时顺序原样不动() {
        let mut groups = three_groups();
        let snapshot = groups.clone();
        let moved = move_matching_to_front(&mut groups, |_| false);
        assert!(!moved, "没有任何命中却动了顺序 = 配置顺序被静默改写");
        assert_eq!(groups, snapshot);
    }

    #[test]
    fn 失败文案要带上每条源各自的原因() {
        let attempts = vec![
            ("https://gitee.com/lzul/pastepanda/raw/releases/latest/updater-gitee.json".to_string(), "Could not fetch a valid release JSON from the remote".to_string()),
            ("https://ghproxy.net/https://github.com/lzlkyb/pastepanda/releases/latest/download/updater-ghproxy.json".to_string(), "error sending request".to_string()),
            ("https://github.com/lzlkyb/pastepanda/releases/latest/download/updater.json".to_string(), "timeout".to_string()),
        ];
        let msg = format_source_failures(&attempts);
        // 三条都要出现，且各带自己的原因——只报最后一条是这次事故查不回来的原因之一。
        assert!(msg.contains("Gitee→") && msg.contains("ghproxy→") && msg.contains("GitHub→"));
        assert!(msg.contains("release JSON"), "第 1 条源的原因被吞了: {msg}");
        assert!(msg.contains("timeout"), "最后一条源的原因丢了: {msg}");
    }

    #[test]
    fn 一条源都没试过不许说所有源失败() {
        assert_eq!(format_source_failures(&[]), "没有可用的更新源");
    }

    #[test]
    fn 源短名按主机映射_未知主机退回域名() {
        assert_eq!(source_name("https://gitee.com/x/raw/a.json"), "Gitee");
        assert_eq!(source_name("https://ghproxy.net/https://github.com/x"), "ghproxy");
        assert_eq!(source_name("https://github.com/x/y"), "GitHub");
        assert_eq!(source_name("https://mirror.example.com/a.json"), "mirror.example.com");
    }

    #[test]
    fn 超长原因会截断且不会切进中文中间() {
        let long = "错".repeat(200);
        let clipped = clip(&long, 10);
        assert_eq!(clipped.chars().count(), 11, "10 个字符 + 省略号");
        assert!(clipped.ends_with('…'));
        assert_eq!(clip("短", 10), "短");
    }

    #[test]
    fn build_updater必须给manifest检查设超时() {
        // 静态守卫：超时是「一条死源吃掉 4 分半」的直接原因，删掉这行不会有别的测试变红，
        // 除非把源码本身钉住（AppHandle 不在单测里可得）。
        let body = fn_body("fn build_updater(");
        assert!(
            body.contains(".timeout(Duration::from_secs(MANIFEST_CHECK_TIMEOUT_SECS))"),
            "manifest 检查回到了「无超时」：{body}"
        );
        assert!(
            MANIFEST_CHECK_TIMEOUT_SECS > 0 && MANIFEST_CHECK_TIMEOUT_SECS < 30,
            "超时档要显著小于实测的 60s 挂死，又得容得下 2.5s 的健康响应"
        );
    }

    #[test]
    fn 端点顺序要按上次成功的源轮转() {
        let body = fn_body("fn candidate_endpoint_groups(");
        assert!(
            body.contains("last_good_source()") && body.contains("move_matching_to_front(&mut groups"),
            "candidate_endpoint_groups 不再复用上次成功的源：下载阶段会重放整条 failover（2026-10-10 事故）"
        );
    }

    #[test]
    fn 两条检查路径都必须记下成功的源() {
        for sig in ["pub async fn check_update(", "fn spawn_desktop_update("] {
            let body = fn_body(sig);
            assert!(
                body.contains("record_good_source(source_label)"),
                "{sig} 没记下成功的源，下一轮又会从配置第 1 条重放"
            );
        }
    }

    #[test]
    fn 源全灭的文案只由汇总函数产出() {
        // 调用点自己拼一次 = 退回「只报最后一条源」，事故就查不回来了。
        // 只数生产代码里的非注释行——本条断言自己的文案不该被算进来。
        let production = || {
            include_str!("update.rs")
                .split("#[cfg(test)]")
                .next()
                .unwrap_or("")
                .lines()
                .filter(|l| !l.trim_start().starts_with("//"))
        };
        assert_eq!(
            production().filter(|l| l.contains("所有更新源均失败")).count(),
            1,
            "这句只允许出现在 format_source_failures 的返回值里一次"
        );
        for sig in [
            "pub async fn check_update(",
            "fn spawn_desktop_update(",
        ] {
            assert!(
                fn_body(sig).contains("format_source_failures(&attempts)"),
                "{sig} 没走汇总，失败原因又会只剩最后一条源"
            );
        }
        let apk = include_str!("update_android.rs");
        let apk_lines = || {
            apk.split("#[cfg(test)]")
                .next()
                .unwrap_or("")
                .lines()
                .filter(|l| !l.trim_start().starts_with("//"))
        };
        assert_eq!(
            apk_lines().filter(|l| l.contains("所有更新源均失败")).count(),
            0,
            "apk 路径要共用桌面的汇总，别各写一份"
        );
    }
}
