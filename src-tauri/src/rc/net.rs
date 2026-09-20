//! 远程端点：绑定 iroh endpoint 与入连接接受循环。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use iroh::Endpoint;

use crate::sync::identity::NodeIdentity;

use super::protocol::{ALPN, FILE_ALPN};
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
    // 双 ALPN：画面/控制走 `rc/1`，文件走 `rc-file/1`（G6）。两条路共用同一个
    // 端点与同一个 accept 循环，**不新绑端口、不新开 relay 连接**。
    b.alpns(vec![ALPN.to_vec(), FILE_ALPN.to_vec()])
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
        // 按 ALPN 分派。❗ 必须在把 `conn` 移进任务**之前**读出来。
        let is_file = conn.alpn() == FILE_ALPN;
        tauri::async_runtime::spawn(async move {
            if is_file {
                svc2.handle_file_conn(conn).await;
            } else {
                svc2.handle_inbound_conn(conn).await;
            }
        });
    }
    log::info!("[RC] 入连接循环已停止");
}
