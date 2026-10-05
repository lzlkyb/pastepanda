//! 观察共享端点自身的发现结果；独立 STUN socket 的映射不能代表这个端点。

use std::sync::Arc;

use futures_util::StreamExt;
use iroh::{Endpoint, Watcher as _};

pub(super) async fn watch(ep: Arc<Endpoint>) {
    let mut addresses = ep.watch_addr().stream();
    let mut reports = ep.net_report().stream();
    loop {
        // watcher 持有端点状态，close 不会自动结束 stream；显式监听关闭以免任务泄漏。
        tokio::select! {
            _ = ep.closed() => break,
            addr = addresses.next() => {
                let Some(addr) = addr else { break };
                log::info!("[IROH-ADDR] local={addr:?}");
            }
            report = reports.next() => {
                let Some(report) = report else { break };
                if let Some(report) = report {
                    log::info!("[IROH-NET] {report}");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn endpoint_close_stops_watchers_even_while_arc_is_retained() {
        let ep = Arc::new(Endpoint::bind(iroh::endpoint::presets::Minimal).await.unwrap());
        let task = tokio::spawn(watch(ep.clone()));
        ep.close().await;
        tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await.expect("诊断任务必须随端点关闭退出")
            .expect("诊断任务不能 panic");
    }
}
