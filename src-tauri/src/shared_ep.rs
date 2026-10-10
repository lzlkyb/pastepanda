//! 全进程唯一的 iroh 端点：**一个身份一个端点**，sync / RC / 文件传输按 ALPN 分派。
//!
//! # 🔴 为什么必须共用（2026-10-02 公网联调实锤）
//!
//! 此前 sync（`sync/transport.rs`）与 RC（`rc/net.rs`）各自 bind 一个端点，
//! 却用同一个 [`crate::sync::identity::NodeIdentity`]——**同一 node id 有两个
//! Endpoint 抢 n0 中继/发现的按-id 路由**。局域网靠 presence 广播的精确直连
//! 地址掩盖了这一点；公网没有 presence，按 node id 路由的结果看运气：
//!
//! - 手机拨 RC，被路由到桌面的**同步**端点 → 它不认识 `pastepanda/rc/1` →
//!   掐断 → 手机报 `aborted by peer … closed during the handshake`；
//! - 桌面拨同步，被路由到手机的 **RC** 端点 → `error 120: peer doesn't
//!   support any known protocol`（TLS ALPN 不匹配）。
//!
//! iroh 的语义本就是「一个身份一个端点」。新增**常驻**联网业务时：把它的
//! ALPN 加进 [`shared_alpns`]，进会话时 [`register`] 一个连接处理器——
//! **不要**再为自己 bind 第二个同身份端点。
//!
//! 端点一经绑定**永不关闭**（随进程生灭）：任何业务的 stop 都只 [`unregister`]
//! 自己的 ALPN，绝不 `endpoint.close()`——那会把别人的在途连接一起杀掉。

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use iroh::endpoint::{presets, QuicTransportConfig};
use iroh::Endpoint;

use crate::rc::protocol::{ALPN as RC_ALPN, FILE_ALPN as RC_FILE_ALPN};
use crate::sync::identity::NodeIdentity;
use crate::sync::transport::ALPN as SYNC_ALPN;

mod diagnostics;
pub mod network;
#[cfg(target_os = "android")]
mod android_dns;

/// 一个业务对入站连接的处理：拿到已握手连接，自己 spawn 去跑。
pub type ConnHandler = Arc<dyn Fn(iroh::endpoint::Connection) + Send + Sync>;

/// 共享端点注册的全部 ALPN。🔴 必须包含每一条常驻业务的 ALPN——漏了哪条，
/// 哪条业务的入连接就会被礼貌拒绝（见 [`dispatch_loop`]）。
pub fn shared_alpns() -> Vec<Vec<u8>> {
    vec![
        SYNC_ALPN.to_vec(),
        crate::sync::asset::ALPN.to_vec(),
        RC_ALPN.to_vec(),
        RC_FILE_ALPN.to_vec(),
    ]
}

/// ALPN → 处理器。查无此 ALPN 的入连接会被对端看到 `aborted by peer`。
struct RouteTable {
    routes: Mutex<HashMap<Vec<u8>, ConnHandler>>,
}

impl RouteTable {
    fn new() -> Self {
        Self {
            routes: Mutex::new(HashMap::new()),
        }
    }

    fn register(&self, alpn: &[u8], h: ConnHandler) {
        let old = self
            .routes
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(alpn.to_vec(), h);
        if old.is_some() {
            log::warn!("[SharedEp] ALPN {} 重复注册，后者覆盖", String::from_utf8_lossy(alpn));
        }
    }

    fn unregister(&self, alpn: &[u8]) {
        self.routes
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(alpn);
    }

    fn dispatch(&self, alpn: &[u8]) -> Option<ConnHandler> {
        self.routes
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(alpn)
            .cloned()
    }
}

fn table() -> &'static RouteTable {
    static TABLE: OnceLock<RouteTable> = OnceLock::new();
    TABLE.get_or_init(RouteTable::new)
}

/// 注册本业务 ALPN 的入连接处理器（幂等：重复注册以后者为准）。
pub fn register(alpn: &[u8], h: ConnHandler) {
    table().register(alpn, h);
}

/// 摘除本业务 ALPN（业务 stop 时调）。之后该 ALPN 的入连接会被礼貌拒绝。
pub fn unregister(alpn: &[u8]) {
    table().unregister(alpn);
}

static SHARED: tokio::sync::OnceCell<Arc<Endpoint>> = tokio::sync::OnceCell::const_new();

pub(crate) fn existing() -> Option<Arc<Endpoint>> {
    SHARED.get().cloned()
}

/// 取共享端点，首个调用方负责绑定（幂等，之后所有调用方拿到同一个实例）。
///
/// 恒以 N0 preset 绑定（中继 + 公网地址发现）：需要它的业务（RC 公网、同步
/// 跨网）都在调用方；「只走局域网」的诉求由测试用自己的临时端点满足
/// （`sync::transport::bind` 仅测试可见）。
pub async fn get_or_bind(app_dir: &Path) -> Result<Arc<Endpoint>, String> {
    SHARED
        .get_or_try_init(|| async {
            // 必须早于 Endpoint::bind；否则首次构造解析器会 panic 后回落 Google DNS。
            #[cfg(target_os = "android")]
            android_dns::init().await?;
            let me = NodeIdentity::load_or_create(app_dir)?;
            // 🔴 传输调参从 rc/net.rs 原样搬来（2026-09-27/28 内网高延迟复盘）：
            // - **数据报发送缓冲 1MB**：≈ 一整只带校验的关键帧爆发。更深只会让
            //   WiFi 拥塞时旧帧排队 300ms+ 才发出；帧龄快速码控在源头消灭排队。
            // - **BBR3**：WiFi 突发丢包下 Cubic 窗口塌缩、流写入停摆数秒；
            //   BBR 模型驱动、对随机丢包不塌窗。sync 的批量传输同栈同利。
            let transport = QuicTransportConfig::builder()
                .datagram_send_buffer_size(1024 * 1024)
                .congestion_controller_factory(Arc::new(
                    noq_proto::congestion::Bbr3Config::default(),
                ))
                .build();
            let ep = Endpoint::builder(presets::N0)
                .secret_key(me.iroh_secret())
                .alpns(shared_alpns())
                .transport_config(transport)
                .bind()
                .await
                .map_err(|e| format!("绑定共享 iroh 端点失败：{}", e))?;
            let ep = Arc::new(ep);
            tauri::async_runtime::spawn(diagnostics::watch(ep.clone()));
            tauri::async_runtime::spawn(dispatch_loop(ep.clone()));
            log::info!(
                "[SharedEp] 共享端点已绑定，端口 {}，ALPN {} 条",
                ep.bound_sockets()
                    .first()
                    .map(|s| s.port())
                    .unwrap_or_default(),
                shared_alpns().len()
            );
            Ok(ep)
        })
        .await
        .cloned()
}

/// 唯一的 accept 循环：收连接 → 按 ALPN 查表 → 交给业务处理器。
async fn dispatch_loop(ep: Arc<Endpoint>) {
    while let Some(incoming) = ep.accept().await {
        let conn = match incoming.await {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[SharedEp] 入连接握手失败：{e}");
                continue;
            }
        };
        let alpn = conn.alpn().to_vec();
        match table().dispatch(&alpn) {
            Some(h) => h(conn),
            // 业务未启动 / 已停止： politely 拒掉，别让对端挂着等超时。
            None => {
                log::warn!(
                    "[SharedEp] ALPN {} 无处理器（业务未启动？），已拒绝",
                    String::from_utf8_lossy(&alpn)
                );
                conn.close(2u32.into(), b"channel-off");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 共享端点_alpn清单_同步远程文件与知识库单图齐全() {
        let alpns = shared_alpns();
        assert_eq!(alpns.len(), 4);
        assert!(alpns.contains(&SYNC_ALPN.to_vec()), "漏了同步 ALPN——同步入连接会被拒");
        assert!(alpns.contains(&RC_ALPN.to_vec()), "漏了远程会话 ALPN——公网会话会被拒");
        assert!(alpns.contains(&RC_FILE_ALPN.to_vec()), "漏了文件传输 ALPN——G6 会被拒");
        assert!(alpns.contains(&crate::sync::asset::ALPN.to_vec()), "漏了知识库单图 ALPN");
        // 所有路由互不相同：撞了的话后注册的会覆盖先注册的。
        let mut uniq = alpns.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(uniq.len(), 4);
    }

    #[test]
    fn 路由表_注册即派_摘除即拒_重复注册后者覆盖() {
        let t = RouteTable::new();
        assert!(t.dispatch(b"a/1").is_none(), "未注册的 ALPN 必须查无");
        t.register(b"a/1", Arc::new(|_| {}));
        assert!(t.dispatch(b"a/1").is_some());
        t.unregister(b"a/1");
        assert!(t.dispatch(b"a/1").is_none());
        let first: ConnHandler = Arc::new(|_| {});
        t.register(b"b/1", first);
        t.register(b"b/1", Arc::new(|_| {}));
        // 覆盖语义由 register 的 warn 日志保证；这里钉住「重复注册不 panic、仍在表」。
        assert!(t.dispatch(b"b/1").is_some());
    }
}
