//! 远程端点：绑定 iroh endpoint 与入连接接受循环。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use iroh::Endpoint;

use crate::sync::identity::NodeIdentity;

use super::protocol::ALPN;
use super::service::RcService;

pub(crate) async fn bind_rc_endpoint(me: &NodeIdentity, relay: bool) -> Result<Endpoint, String> {
    use iroh::endpoint::{presets, RelayMode};
    let key = me.iroh_secret();
    let b = if relay {
        Endpoint::builder(presets::N0).secret_key(key)
    } else {
        Endpoint::builder(presets::Minimal)
            .secret_key(key)
            .relay_mode(RelayMode::Disabled)
            .clear_address_lookup()
    };
    b.alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .map_err(|e| format!("绑定远程端点失败：{}", e))
}

pub(crate) async fn accept_loop(svc: Arc<RcService>, ep: Endpoint, stop: Arc<AtomicBool>) {
    while !stop.load(Ordering::SeqCst) {
        let conn = tokio::select! {
            r = crate::sync::transport::accept_conn(&ep) => match r {
                Ok(c) => c,
                Err(e) => {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    log::warn!("[RC] 接入连接失败：{e}");
                    continue;
                }
            },
            _ = tokio::time::sleep(std::time::Duration::from_millis(400)) => {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                continue;
            }
        };
        let svc2 = svc.clone();
        tauri::async_runtime::spawn(async move {
            svc2.handle_inbound_conn(conn).await;
        });
    }
    log::info!("[RC] 入连接循环已停止");
}
