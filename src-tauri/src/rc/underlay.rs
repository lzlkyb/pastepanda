//! 实验备用承载：只借已获批 RC 连接协调，媒体仍走原身份/原 ALPN 的 QUIC。
use std::{path::{Path, PathBuf}, sync::{Arc, OnceLock}, time::Duration};
use iroh::endpoint::Connection;
use super::service::RcService;

mod config;
mod diagnostics;
mod fetch;
mod runtime;
mod session;
mod stun;

static APP_DIR: OnceLock<PathBuf> = OnceLock::new();
static NETWORK_EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub(crate) const ENABLED_KEY: &str = "rc_easytier_enabled";

pub(crate) fn init(dir: &Path) { let _ = APP_DIR.set(dir.to_owned()); }

#[cfg(target_os = "android")]
pub(crate) fn network_changed() {
    NETWORK_EPOCH.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

fn enabled(cfg: &serde_json::Value) -> bool {
    cfg.get(ENABLED_KEY).and_then(|v| v.as_bool()).unwrap_or_else(|| {
        cfg!(feature = "easytier-underlay") || APP_DIR.get()
            .is_some_and(|d| d.join("easytier-prototype.enabled").is_file())
    })
}

pub(crate) fn start(svc: Arc<RcService>, id: String, conn: Connection, host: bool) {
    if !enabled(&svc.cfg()) || !svc.session_id_is(&id)
        || crate::sync::path_kind::of_conn(&conn) != crate::sync::path_kind::PathKind::Relay {
        return;
    }
    let epoch = NETWORK_EPOCH.load(std::sync::atomic::Ordering::Relaxed);
    tauri::async_runtime::spawn(async move {
        let work = session::run(conn.clone(), host);
        let cancel = async {
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                if !svc.session_id_is(&id) || !enabled(&svc.cfg())
                    || NETWORK_EPOCH.load(std::sync::atomic::Ordering::Relaxed) != epoch {
                    break;
                }
                // 原生 LAN/IPv6/UDP 已接管就不再保留第二套探测/承载。
                if conn.paths().iter().any(|p| p.is_selected() &&
                    matches!(p.remote_addr(), iroh::TransportAddr::Ip(a) if !a.ip().is_loopback())) {
                    break;
                }
            }
        };
        log::info!("[RC-UNDERLAY] 开始备用直连协调，session={id} host={host}");
        tokio::select! {
            result = work => if let Err(error) = result {
                log::warn!("[RC-UNDERLAY] 备用承载未完成，保留原链路：{error}");
            },
            _ = cancel => log::info!("[RC-UNDERLAY] 会话结束、关闭或切网，释放备用承载"),
            _ = conn.closed() => log::info!("[RC-UNDERLAY] 原连接关闭，释放备用承载"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_disable_overrides_prototype_build() {
        assert!(!enabled(&serde_json::json!({ENABLED_KEY: false})));
        assert!(enabled(&serde_json::json!({ENABLED_KEY: true})));
    }
}
