//! probe/netdiag — iroh 打洞效果单机探针（R0-3）。判据见 README.md。
//!
//! 无参：本机网络画像（net_report + watch_addr + 判定）。
//! 带参 `netdiag-probe <对端 node_id>`：双端打洞实测——拨对端，保持 60s，
//! 每 5s 打印各路径（direct/relay）、选中路径与 RTT。两端都要跑本探针。

use std::time::Duration;

use iroh::endpoint::presets;
use iroh::unstable_net_report::NetReport;
use iroh::{Endpoint, EndpointAddr, EndpointId, Watcher as _};

const ALPN: &[u8] = b"netdiag/1";

fn verdict(r: &NetReport) -> (&'static str, &'static str) {
    if r.captive_portal == Some(true) {
        return ("Captive", "网络需网页认证，探测不可信");
    }
    if !r.udp_v4 && !r.udp_v6 {
        return ("UdpBlocked", "UDP 全被阻断，只能走中继回落");
    }
    let fams = [
        (r.udp_v4, r.mapping_varies_by_dest_ipv4),
        (r.udp_v6, r.mapping_varies_by_dest_ipv6),
    ];
    let mut any_stable = false;
    for (udp, mapping) in fams {
        if !udp {
            continue;
        }
        match mapping {
            Some(true) => {
                return ("RelayOnly", "对称 NAT：iroh 会放弃直连、恒走中继");
            }
            Some(false) => any_stable = true,
            None => {}
        }
    }
    if any_stable {
        ("DirectLikely", "映射稳定（EIM）：iroh 会互发探测，直连可期")
    } else {
        ("DirectPossible", "有 UDP 但对称性未证伪（单 relay 样本不足）")
    }
}

fn print_report(tag: &str, r: &NetReport) {
    println!("\n== net_report [{tag}] ==");
    println!(
        "udp_v4={} udp_v6={} captive={:?}",
        r.udp_v4, r.udp_v6, r.captive_portal
    );
    println!(
        "mapping_varies v4={:?} v6={:?}",
        r.mapping_varies_by_dest_ipv4, r.mapping_varies_by_dest_ipv6
    );
    println!("global_v4={:?} global_v6={:?}", r.global_v4, r.global_v6);
    println!("preferred_relay={:?}", r.preferred_relay);
    let mut lats: Vec<_> = r.relay_latency.iter().collect();
    lats.sort_by_key(|(_, _, d)| *d);
    for (probe, url, d) in &lats {
        println!("  relay {probe:?} {url} {:.0}ms", d.as_secs_f64() * 1000.0);
    }
    let (v, why) = verdict(r);
    println!(">> 判定: {v} — {why}");
}

async fn wait_report(ep: &Endpoint, secs: u64) -> Option<NetReport> {
    let mut w = ep.net_report();
    tokio::time::timeout(Duration::from_secs(secs), w.initialized())
        .await
        .ok()
}

async fn snapshot_mode(ep: &Endpoint) {
    let id = ep.id();
    println!("本机 node id: {id}");
    println!("bound sockets: {:?}", ep.bound_sockets());

    // watch_addr：本地地址表 + 已发现的 direct addrs（含 portmapper 结果）。
    let addr = ep.watch_addr().get();
    println!("\n== watch_addr ==");
    println!("ip addrs: {:?}", addr.ip_addrs().collect::<Vec<_>>());
    println!("relay urls: {:?}", addr.relay_urls().collect::<Vec<_>>());

    println!("\n等待 net_report（QAD 要对多个 relay 各探一轮，最长 90s）…");
    let Some(report) = wait_report(&ep, 90).await else {
        println!("!! 90s 内没拿到报告：n0 relay 连不上或 UDP 全断");
        return;
    };
    print_report("最新", &report);

    // 再等一轮增量报告（QAD 对多 relay 的第二次探测才有 mapping 判定）。
    println!("\n再等一轮（对称 NAT 判定需要 ≥2 个 relay 的 QAD 样本）…");
    tokio::time::sleep(Duration::from_secs(30)).await;
    let mut w = ep.net_report();
    if let Some(r2) = wait_report(&ep, 60).await {
        print_report("增量", &r2);
    }
}

async fn dial_mode(ep: &Endpoint, peer: EndpointId) {
    println!("本机 node id: {}", ep.id());
    println!("拨号对端 {peer}（alpn netdiag/1）…");
    let conn = match ep
        .connect(EndpointAddr::new(peer), ALPN)
        .await
    {
        Ok(c) => c,
        Err(e) => {
            println!("!! 连接失败: {e}");
            return;
        }
    };
    println!("已连接。观察 60s 内路径迁移（iroh 每 60s 尝试 relay→direct 升级）…");
    for i in 0..12u32 {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let paths = conn.paths();
        let mut line = String::new();
        for p in paths.iter() {
            line.push_str(&format!(
                "  [{}{}] {} rtt={:.0}ms\n",
                if p.is_selected() { "*" } else { " " },
                if p.is_relay() { "RELAY" } else { "IP   " },
                p.remote_addr(),
                p.rtt().as_secs_f64() * 1000.0
            ));
        }
        println!("t={}s:\n{line}", (i + 1) * 5);
    }
}

#[tokio::main]
async fn main() {
    let arg = std::env::args().nth(1);
    let ep = Endpoint::builder(presets::N0)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .expect("bind");
    match arg.and_then(|s| s.parse::<EndpointId>().ok()) {
        Some(peer) => dial_mode(&ep, peer).await,
        None => snapshot_mode(&ep).await,
    }
    ep.close().await;
}
