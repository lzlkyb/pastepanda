//! Android 应用内自更新（方案甲，2026-10-03）。
//!
//! # 为什么不走 tauri-plugin-updater
//!
//! 该插件（本地钉版 2.10.1）的 install 是桌面「替换主程序」事务模型，
//! `UpdaterState` 只在 desktop 注册，移动端调 `updater_builder()` 直接 panic
//! （update.rs 的 mobile 守卫有真机实证）。Android 的更新只有一条路：
//! **下载 APK → FileProvider content:// → 拉起系统安装器**，签名一致性由
//! 系统在安装时校验（新旧 APK 同签名才允许覆盖安装）。
//!
//! # 契约（收口点，规则 11.1）
//!
//! - 命令名沿用 `check_update` / `start_update`（update.rs 里 cfg 分派到这里），
//!   返回 shape `{version, body}` 与事件名 `update:checking/available/downloading/
//!   progress/ready/uptodate/error/source_slow` 全部与桌面一致——前端零分支。
//!   新增的只有 `update:needPermission`（授予「安装未知应用」权限引导）与两个
//!   辅助命令 `apk_install_status` / `apk_open_install_settings`。
//! - manifest 是多源的（Gitee raw → ghproxy → GitHub 直连，每组一个 URL，
//!   failover 语义对齐 `candidate_endpoint_groups` 的 v7.1.1 事故修法）；
//!   每条 manifest 的 `url` 字段指向**同主机**的 APK 资产，慢源看门狗复用
//!   `is_download_too_slow`：manifest 通了不代表二进制通道健康。
//! - 完整性：https + manifest `sha256`（下载后强校验，不匹配视该源失败）；
//!   最终防线是 Android 安装器校验 APK 签名。
//!
//! # 重复 start_update 的语义
//!
//! 「授予权限后回来再点安装」会重新走 start_update：目标文件已存在且 sha256
//! 匹配时**跳过下载**直接拉起安装器——不重复吃一遍流量。
//!
//! # cfg 布局
//!
//! 流程实现（网络/下载/安装桥）整体 `cfg(target_os = "android")`——桌面构建
//! 一行都不编（对齐 rc::keepalive 的先例）。三个**纯函数**例外，双端编译：
//! 桌面 `cargo test` 要能覆盖它们（Android 构建不跑单测）。

use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::Runtime;

#[cfg(target_os = "android")]
use std::time::Duration;
#[cfg(target_os = "android")]
use serde::Deserialize;
#[cfg(target_os = "android")]
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(target_os = "android")]
use std::sync::Arc;
#[cfg(target_os = "android")]
use std::time::Instant;
#[cfg(target_os = "android")]
use tauri::{Emitter, Manager};

#[cfg(target_os = "android")]
use super::update::{
    format_source_failures, is_download_too_slow, last_good_source, move_matching_to_front,
    record_good_source, retry_with_backoff, MANIFEST_CHECK_TIMEOUT_SECS, SPEED_GRACE_SECS,
};

/// Gitee 镜像上的 apk manifest（只在读不到 tauri.conf.json 的 apkEndpoints 时兜底）。
#[cfg(target_os = "android")]
const GITEE_APK_MANIFEST_URL: &str =
    "https://gitee.com/lzul/pastepanda/raw/releases/latest/apk-update-gitee.json";

#[cfg(target_os = "android")]
#[derive(Deserialize)]
pub struct ApkManifest {
    pub version: String,
    /// 与 manifest 同主机的 APK 绝对地址（publish-apk.mjs 按源生成）。
    pub url: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
}

/// 已装载的 Kotlin `ApkInstallerPlugin` 句柄（仅 Android 存在）。
#[cfg(target_os = "android")]
pub struct ApkInstaller<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct InstallReply {
    status: String,
}

#[cfg(target_os = "android")]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallArgs {
    path: String,
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("apkinstaller")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api
                    .register_android_plugin("com.pastepanda.app", "ApkInstallerPlugin")
                    .map_err(|e| e.to_string())?;
                app.manage(ApkInstaller(handle));
            }
            let _ = (app, api);
            Ok(())
        })
        .build()
}

// ─── 纯函数（双端编译：桌面 cargo test 覆盖，Android 运行时消费）────

/// 点分数字版本比较：candidate 严格新于 current 才 true。
/// 解析不出的段按 0；任何一侧完全解析失败（非数字开头）→ false（宁可不更）。
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn is_newer(current: &str, candidate: &str) -> bool {
    fn parts(v: &str) -> Option<Vec<u64>> {
        let core = v.split(['-', '+']).next().unwrap_or(v);
        // 空串≠「版本号 0」：解析失败按宁可不更处理（反例已被单测抓到）。
        if core.is_empty() {
            return None;
        }
        let mut out = Vec::new();
        for seg in core.split('.') {
            let digits: String = seg.chars().take_while(|c| c.is_ascii_digit()).collect();
            if digits.is_empty() {
                return if seg.is_empty() { Some(out) } else { None };
            }
            out.push(digits.parse::<u64>().ok()?);
        }
        Some(out)
    }
    let (Some(a), Some(b)) = (parts(current.trim()), parts(candidate.trim())) else {
        return false;
    };
    let len = a.len().max(b.len());
    for i in 0..len {
        let x = *a.get(i).unwrap_or(&0);
        let y = *b.get(i).unwrap_or(&0);
        if y != x {
            return y > x;
        }
    }
    false
}

/// 从下载 URL 取本地文件名：只留 `[A-Za-z0-9._-]`，防 URL 路径穿越/分隔符注入。
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn apk_file_name(url: &str) -> String {
    let tail = url
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("update.apk");
    let clean: String = tail
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .collect();
    let trimmed = clean.trim_matches('.'); // 隐藏文件名/纯点在部分 ROM 上会出问题
    if trimmed.len() < 5 || !trimmed.ends_with(".apk") {
        format!("{trimmed}.apk")
    } else {
        trimmed.to_string()
    }
}

/// sha256 十六进制摘要校验（大小写不敏感）。期望值缺失/空白（老 manifest 无 sha256）→ 放行。
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn sha256_matches(bytes: &[u8], expected: Option<&str>) -> bool {
    let Some(want) = expected.map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()) else {
        return true;
    };
    use sha2::Digest;
    let got = sha2::Sha256::digest(bytes);
    let got_hex: String = got.iter().map(|b| format!("{b:02x}")).collect();
    got_hex == want
}

// ─── 以下整体 Android-only ─────────────────────────────

#[cfg(target_os = "android")]
fn apk_endpoints(app: &tauri::AppHandle) -> Vec<String> {
    let configured = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("apkEndpoints"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if configured.is_empty() {
        log::warn!("[Update-apk] 配置里没读到 apkEndpoints，退回内置 Gitee 源");
        return vec![GITEE_APK_MANIFEST_URL.to_string()];
    }
    let mut eps = configured;
    // 与桌面同款：检查阶段成功的源，下载阶段别再重头试一遍（见 `move_matching_to_front`）。
    if let Some(last_good) = last_good_source() {
        if move_matching_to_front(&mut eps, |u| u == &last_good) {
            log::info!("[Update-apk] 优先复用上次成功的更新源: {last_good}");
        }
    }
    eps
}

#[cfg(target_os = "android")]
fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))
}

#[cfg(target_os = "android")]
async fn fetch_manifest(client: &reqwest::Client, endpoint: &str) -> Result<ApkManifest, String> {
    // ❗ 超时挂在**这个请求**上，不挂在 client 上：同一个 client 还跑 APK 下载，
    //   一个 15s 的总超时会把几百 MB 的包掐死。桌面端同理见 `MANIFEST_CHECK_TIMEOUT_SECS`。
    let resp = client
        .get(endpoint)
        .timeout(Duration::from_secs(MANIFEST_CHECK_TIMEOUT_SECS))
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("HTTP 状态错误: {e}"))?;
    let json = resp
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("manifest 不是合法 JSON: {e}"))?;
    // 防呆：误把桌面 updater.json 挂到 apkEndpoints 上时给明确报错，
    // 而不是 serde 的 missing field `version` 猜谜。
    if json.get("url").and_then(|v| v.as_str()).is_none() {
        return Err("manifest 缺少 url 字段（这是桌面 updater.json 吗？）".into());
    }
    serde_json::from_value(json).map_err(|e| format!("manifest 字段不合法: {e}"))
}

#[cfg(target_os = "android")]
async fn check_one_source(
    client: &reqwest::Client,
    endpoint: &str,
    current: &str,
) -> Result<Option<ApkManifest>, String> {
    let m = fetch_manifest(client, endpoint).await?;
    if is_newer(current, &m.version) {
        Ok(Some(m))
    } else {
        Ok(None)
    }
}

/// 与桌面 `check_update` 同 shape：`Some({version, body})` / `None`。
#[cfg(target_os = "android")]
pub async fn check_apk_update(app: &tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let client = http_client()?;
    let current = app.package_info().version.to_string();
    let mut attempts: Vec<(String, String)> = Vec::new();
    let eps = apk_endpoints(app);
    for (i, ep) in eps.iter().enumerate() {
        log::info!("[Update-apk] 检查源 {}/{ep_count}: {ep}", i + 1, ep_count = eps.len());
        match retry_with_backoff(2, &format!("检查 apk 更新({ep})"), || {
            check_one_source(&client, ep, &current)
        })
        .await
        {
            Ok(Some(m)) => {
                record_good_source(ep);
                log::info!("[Update-apk] 发现新版本 v{} (源: {ep})", m.version);
                return Ok(Some(serde_json::json!({
                    "version": m.version,
                    "body": m.notes,
                })));
            }
            Ok(None) => {
                record_good_source(ep);
                return Ok(None);
            }
            Err(e) => {
                log::warn!("[Update-apk] 源 {ep} 失败: {e}");
                attempts.push((ep.clone(), e));
                continue;
            }
        }
    }
    Err(format_source_failures(&attempts))
}

#[cfg(target_os = "android")]
enum ApkDownload {
    /// 本次流式下载完成（bytes + 落盘路径；sha256 已校验通过）。
    Downloaded(Vec<u8>, std::path::PathBuf),
    /// 缓存文件命中（bytes 也读好了）。
    FromCache(Vec<u8>, std::path::PathBuf),
    TooSlow { avg_bps: u64 },
    Failed(String),
}

/// 流式下载到应用 cache/updates 目录，带慢源看门狗（语义对齐桌面
/// `download_with_speed_guard`：宽限期、均速判据、最后一源关狗）。
#[cfg(target_os = "android")]
async fn download_apk(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    manifest: &ApkManifest,
    enable_watchdog: bool,
) -> ApkDownload {
    use futures_util::StreamExt;

    let cache_dir = match app.path().app_cache_dir() {
        Ok(d) => d.join("updates"),
        Err(e) => return ApkDownload::Failed(format!("无法取应用缓存目录: {e}")),
    };
    if let Err(e) = std::fs::create_dir_all(&cache_dir) {
        return ApkDownload::Failed(format!("无法创建 updates 目录: {e}"));
    }
    let dest = cache_dir.join(apk_file_name(&manifest.url));

    // 命中缓存（上次下完但没装/没权限）：校验通过就免重下。
    if let Ok(bytes) = std::fs::read(&dest) {
        if sha256_matches(&bytes, manifest.sha256.as_deref()) && !bytes.is_empty() {
            log::info!("[Update-apk] 缓存命中，跳过下载: {}", dest.display());
            return ApkDownload::FromCache(bytes, dest);
        }
        let _ = std::fs::remove_file(&dest);
    }

    let resp = match client
        .get(&manifest.url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
    {
        Ok(r) => r,
        Err(e) => return ApkDownload::Failed(format!("下载请求失败: {e}")),
    };
    let total = resp.content_length();
    let mut stream = resp.bytes_stream();

    let acc = Arc::new(AtomicU64::new(0));
    let acc_watch = acc.clone();
    let settled = Arc::new(AtomicBool::new(false));
    let settled_watch = settled.clone();
    let started = Instant::now();
    let app_progress = app.clone();
    let dest_dl = dest.clone();

    let dl_fut = async move {
        let mut file = match std::fs::File::create(&dest_dl) {
            Ok(f) => f,
            Err(e) => return Err(format!("无法写入 {} : {e}", dest_dl.display())),
        };
        let mut buf: Vec<u8> = Vec::new();
        let mut write_err: Option<String> = None;
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(b) => {
                    buf.extend_from_slice(&b);
                    acc.fetch_add(b.len() as u64, Ordering::Relaxed);
                    let downloaded = acc.load(Ordering::Relaxed);
                    let _ = app_progress.emit(
                        "update:progress",
                        serde_json::json!({ "downloaded": downloaded, "total": total }),
                    );
                    if let Err(e) = std::io::Write::write_all(&mut file, &b) {
                        write_err = Some(format!("写入中断: {e}"));
                        break;
                    }
                }
                Err(e) => {
                    write_err = Some(format!("下载流错误: {e}"));
                    break;
                }
            }
        }
        drop(file);
        settled.store(true, Ordering::Relaxed);
        match write_err {
            Some(e) => {
                let _ = std::fs::remove_file(&dest_dl);
                Err(e)
            }
            None => Ok(buf),
        }
    };

    let wd_fut = async move {
        if !enable_watchdog {
            std::future::pending::<()>().await;
        }
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if settled_watch.load(Ordering::Relaxed) {
                std::future::pending::<()>().await;
            }
            let elapsed = started.elapsed().as_secs_f64();
            let downloaded = acc_watch.load(Ordering::Relaxed);
            if is_download_too_slow(elapsed, downloaded) {
                let avg_bps = (downloaded as f64 / elapsed.max(SPEED_GRACE_SECS)) as u64;
                return ApkDownload::TooSlow { avg_bps };
            }
        }
    };

    tokio::select! {
        biased;
        r = dl_fut => match r {
            Ok(bytes) => {
                // 校验在收流末尾一次做（APK 数十 MB，内存可承受；换来了 sha 直接对 bytes 算）。
                let known_len_ok = total.map(|t| bytes.len() as u64 == t).unwrap_or(true);
                if !known_len_ok || !sha256_matches(&bytes, manifest.sha256.as_deref()) {
                    let _ = std::fs::remove_file(&dest);
                    ApkDownload::Failed(if known_len_ok {
                        "sha256 校验不匹配（下载内容损坏或源被篡改）".to_string()
                    } else {
                        "下载字节数与 Content-Length 不符".to_string()
                    })
                } else {
                    ApkDownload::Downloaded(bytes, dest)
                }
            }
            Err(e) => ApkDownload::Failed(e),
        },
        o = wd_fut => {
            let _ = std::fs::remove_file(&dest);
            o
        }
    }
}

/// 拉起系统安装器。Ok(true)=已打开；Ok(false)=缺「安装未知应用」权限。
#[cfg(target_os = "android")]
async fn launch_installer(app: &tauri::AppHandle, path: &str) -> Result<bool, String> {
    let Some(installer) = app.try_state::<ApkInstaller<tauri::Wry>>() else {
        return Err("安装插件未就绪".into());
    };
    let reply = installer
        .0
        .run_mobile_plugin::<InstallReply>(
            "installApk",
            InstallArgs {
                path: path.to_string(),
            },
        )
        .map_err(|e| e.to_string())?;
    Ok(reply.status == "launched")
}

/// 后台完整流程：多源 failover 检查+下载+校验+拉起安装器。事件与桌面同名。
#[cfg(target_os = "android")]
pub fn spawn_apk_update(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let _ = app.emit("update:checking", ());
        let client = match http_client() {
            Ok(c) => c,
            Err(e) => {
                let _ = app.emit("update:error", serde_json::json!({ "message": e }));
                return;
            }
        };
        let current = app.package_info().version.to_string();
        let groups = apk_endpoints(&app);
        let mut attempts: Vec<(String, String)> = Vec::new();

        for (i, ep) in groups.iter().enumerate() {
            let update = match check_one_source(&client, ep, &current).await {
                Ok(Some(m)) => {
                    record_good_source(ep);
                    m
                }
                Ok(None) => {
                    record_good_source(ep);
                    let _ = app.emit("update:uptodate", ());
                    return;
                }
                Err(e) => {
                    log::warn!("[Update-apk] 源 {ep} 检查失败: {e}");
                    attempts.push((ep.clone(), e));
                    continue;
                }
            };
            let _ = app.emit(
                "update:available",
                serde_json::json!({ "version": update.version, "body": update.notes }),
            );
            let _ = app.emit("update:downloading", ());

            // 最后一源关看门狗（桌面同款纪律：慢，好过断）。
            let dest = match download_apk(&app, &client, &update, i + 1 < groups.len()).await {
                ApkDownload::Downloaded(_, p) | ApkDownload::FromCache(_, p) => p,
                ApkDownload::TooSlow { avg_bps } => {
                    let _ = app.emit(
                        "update:source_slow",
                        serde_json::json!({
                            "source": ep, "avg_bps": avg_bps,
                        }),
                    );
                    attempts.push((ep.clone(), format!("下载过慢（约 {} KB/s）", avg_bps / 1024)));
                    continue;
                }
                ApkDownload::Failed(e) => {
                    log::warn!("[Update-apk] 源 {ep} 下载失败: {e}");
                    attempts.push((ep.clone(), e));
                    continue;
                }
            };

            let _ = app.emit(
                "update:ready",
                serde_json::json!({ "version": update.version }),
            );
            match launch_installer(&app, &dest.to_string_lossy()).await {
                Ok(true) => {
                    log::info!("[Update-apk] 已拉起系统安装器: {}", dest.display());
                    return;
                }
                // needPermission 不是错误：ready 已发，前端按引导态处理。
                Ok(false) => {
                    let _ = app.emit("update:needPermission", ());
                    return;
                }
                Err(e) => {
                    log::warn!("[Update-apk] 拉起安装器失败: {e}");
                    attempts.push((ep.clone(), e));
                    continue;
                }
            }
        }
        let _ = app.emit(
            "update:error",
            serde_json::json!({ "message": format_source_failures(&attempts) }),
        );
    });
}

// ─── 辅助命令（桌面 stub 与 keepalive 同法）────────────

/// 「允许安装未知应用」授权状态。桌面恒 allowed=true（无此概念，不触发移动端引导 UI）。
#[tauri::command]
pub fn apk_install_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        let Some(installer) = app.try_state::<ApkInstaller<tauri::Wry>>() else {
            return Err("安装插件未就绪".into());
        };
        #[derive(Deserialize)]
        struct StatusReply {
            allowed: bool,
        }
        let reply = installer
            .0
            .run_mobile_plugin::<StatusReply>("installStatus", serde_json::json!({}))
            .map_err(|e| e.to_string())?;
        Ok(serde_json::json!({ "allowed": reply.allowed }))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(serde_json::json!({ "allowed": true }))
    }
}

/// 跳系统设置「安装未知应用」页。
#[tauri::command]
pub fn apk_open_install_settings(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let Some(installer) = app.try_state::<ApkInstaller<tauri::Wry>>() else {
            return Err("安装插件未就绪".into());
        };
        installer
            .0
            .run_mobile_plugin::<()>("openInstallSettings", serde_json::json!({}))
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]
    use super::*;

    // —— is_newer ——
    #[test]
    fn 补丁号更大判新() {
        assert!(is_newer("7.2.9", "7.2.10"));
    }
    #[test]
    fn 相同版本不判新() {
        assert!(!is_newer("7.2.9", "7.2.9"));
    }
    #[test]
    fn 两位数段是真数字序不是字符序() {
        // 反例守卫：字符串比较会把 "7.10.0" 判旧于 "7.2.9"
        assert!(is_newer("7.2.9", "7.10.0"));
        assert!(!is_newer("7.10.0", "7.2.9"));
    }
    #[test]
    fn 高位更大判新() {
        assert!(is_newer("6.9.9", "7.0.0"));
        assert!(!is_newer("8.0.0", "7.9.9"));
    }
    #[test]
    fn 段数不同补齐比较() {
        assert!(is_newer("7.2", "7.2.1"));
        assert!(!is_newer("7.2.1", "7.2"));
    }
    #[test]
    fn 预发布后缀不参与比较() {
        assert!(!is_newer("7.2.9", "7.2.9-beta.1"));
    }
    #[test]
    fn 垃圾输入宁可不更() {
        assert!(!is_newer("7.2.9", "not-a-version"));
        assert!(!is_newer("", "7.2.9"));
    }

    // —— apk_file_name ——
    #[test]
    fn url尾段取文件名() {
        assert_eq!(
            apk_file_name("https://x.com/releases/download/v7.3.0/PastePanda_7.3.0_universal-release.apk"),
            "PastePanda_7.3.0_universal-release.apk"
        );
    }
    #[test]
    fn 路径穿越字符被剔干净() {
        // 反例守卫：`../../etc/x.apk` 若原样拼进 join() 会写到目录外
        let name = apk_file_name("https://x.com/../../evil.apk");
        assert!(!name.contains('/') && !name.contains('\\'));
        assert_eq!(name, "evil.apk");
    }
    #[test]
    fn 查询串不会混进文件名() {
        let name = apk_file_name("https://x.com/f/app.apk?token=abc");
        assert!(!name.contains('?') && !name.contains('='));
    }
    #[test]
    fn 隐藏文件名不会以点开头() {
        assert!(!apk_file_name("https://x.com/.apk").starts_with('.'));
    }

    // —— sha256_matches ——
    #[test]
    fn 期望缺失或空串都按不校验放行() {
        assert!(sha256_matches(b"abc", None));
        // 空白期望按缺失处理（与字段缺失同义的宽容策略）——行为在此钉死。
        assert!(sha256_matches(b"abc", Some("  ")));
        // 已知向量：sha256("abc")
        let abc_hash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert!(sha256_matches(b"abc", Some(abc_hash)));
        assert!(sha256_matches(b"abc", Some(&abc_hash.to_uppercase())));
        assert!(!sha256_matches(b"abd", Some(abc_hash)));
    }
}
