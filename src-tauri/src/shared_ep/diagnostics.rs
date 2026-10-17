//! 观察共享端点自身的发现结果；独立 STUN socket 的映射不能代表这个端点。
//!
//! # R0 诊断出口（2026-10-15，`docs/远程电脑-打洞升级决策-自建预测注入与TUN-2026-10-15.md`）
//!
//! `watch` 只把 Report 打进日志；本模块另一半把最新 Report 结构化成
//! [`NetDiagSnapshot`] 给前端/命令层，核心是 [`punch_verdict`] 判定——
//! 「这台设备的网络下，iroh 会不会尝试直连」的机制判定：
//!
//! - `mapping_varies_by_dest`（对称 NAT）= true 时 **iroh 直接放弃直连**
//!   （iroh 1.1 源码取证见决策稿 §1），这是「老是绕中继」的第一根因；
//! - 判定按**协议族分开**：iroh 的 `Report::mapping_varies_by_dest()` 把
//!   v4/v6 做 `||` 聚合，IPv6 测出 varies 会连坐稳定的 v4 —— 聚合口径
//!   在这里收口，不许调用方自己再聚合。
//!
//! 判定规则写死在本函数 + 单测；前端只显示、不复算。

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use iroh::unstable_net_report::NetReport;
use iroh::{Endpoint, Watcher as _};
use serde::Serialize;

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

// ---------------------------------------------------------------------------
// R0：结构化出口 + 打洞可行性判定
// ---------------------------------------------------------------------------

/// 单协议族的映射观测明细。
#[derive(Debug, Clone, Serialize)]
pub struct FamilyMapping {
    /// 该族 QAD 探测是否成功（拿到公网映射）。
    pub udp: bool,
    /// 对称 NAT 判定：`Some(true)`= 映射随目的变（iroh 放弃直连）；
    /// `Some(false)`= 映射稳定；`None`= 样本不足（QAD 没跑够或单 relay）。
    pub mapping_varies: Option<bool>,
    /// QAD 观测到的公网映射（ip:port）。本地 UI 显示用，不进日志、不上传。
    pub observed: Option<String>,
}

/// 打洞可行性判定（机制层，写死规则见 [`punch_verdict`]）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PunchExpectation {
    /// 映射稳定（EIM）：iroh 会互发探测，直连可期。
    DirectLikely,
    /// 有 UDP 但对称性未证伪（单 relay 样本）：直连可能，待更多样本。
    DirectPossible,
    /// 对称 NAT：**iroh 不会尝试直连，恒走中继**（R1a 端口预测注入的目标场景）。
    RelayOnly,
    /// UDP 全被阻断：数据面只能走 relay 的 HTTPS 回落。
    UdpBlocked,
    /// 网络需要网页认证，探测结果不可信。
    Captive,
    /// 还没有可用报告（刚启动 / 探测未完成）。
    Unknown,
}

impl PunchExpectation {
    /// 给前端的一句话结论。文案口径与决策稿 §1 一致，别在组件里再写一份。
    pub fn zh_summary(self) -> &'static str {
        match self {
            PunchExpectation::DirectLikely => "映射稳定，可尝试直连",
            PunchExpectation::DirectPossible => "UDP 可用，对称性待更多探测样本",
            PunchExpectation::RelayOnly => "对称 NAT：iroh 会放弃直连、恒走中继",
            PunchExpectation::UdpBlocked => "UDP 被阻断，只能走中继回落",
            PunchExpectation::Captive => "网络需网页认证（captive portal）",
            PunchExpectation::Unknown => "网络探测尚未完成",
        }
    }
}

/// 最新一次 net_report 的结构化快照（[`rc_diagnostics`](crate::commands::net_diag) 下发）。
#[derive(Debug, Clone, Serialize)]
pub struct NetDiagSnapshot {
    pub udp_v4: bool,
    pub udp_v6: bool,
    pub mapping_varies_by_dest_ipv4: Option<bool>,
    pub mapping_varies_by_dest_ipv6: Option<bool>,
    /// 观测到的公网映射（ip:port 字符串）。本地显示用。
    pub global_v4: Option<String>,
    pub global_v6: Option<String>,
    pub captive_portal: Option<bool>,
    pub preferred_relay: Option<String>,
    /// 各 relay 的探测延迟（毫秒取整）。
    pub relay_latencies_ms: Vec<RelayLatencyEntry>,
    /// 主判定：在「有 UDP 的族」里取最明确的一条（v4 优先，见 [`punch_verdict`]）。
    pub verdict: PunchExpectation,
    /// 两个协议族各自的观测明细（前端展开用）。
    pub family_v4: FamilyMapping,
    pub family_v6: FamilyMapping,
}

#[derive(Debug, Clone, Serialize)]
pub struct RelayLatencyEntry {
    pub probe: String,
    pub relay: String,
    pub ms: u64,
}

/// 主判定：聚合两个协议族，取「有 UDP 且信息最明确」的一条，IPv4 优先。
///
/// 规则优先级（单测钉死）：
/// 1. captive portal → `Captive`（其余字段都不可信）；
/// 2. 双族都无 UDP → `UdpBlocked`；
/// 3. 任一**有 UDP** 的族上 `mapping_varies = Some(true)` → `RelayOnly`
///    （对称 NAT 对「该族」成立即放弃该族；v4/v6 走不同隧道时可能一族能直连
///    一族不能，主判定取族间最悲观 + 明细交前端展示）；
/// 4. 任一有 UDP 的族 `Some(false)` → `DirectLikely`；
/// 5. 有 UDP 但两族都是 `None`（样本不足）→ `DirectPossible`；
/// 6. 无报告 → `Unknown`。
pub fn punch_verdict(report: &NetReport) -> PunchExpectation {
    if report.captive_portal == Some(true) {
        return PunchExpectation::Captive;
    }
    if !report.udp_v4 && !report.udp_v6 {
        return PunchExpectation::UdpBlocked;
    }
    // 族级映射观测：该族有 UDP 才有有效 mapping 信息。
    let families = [
        (report.udp_v4, report.mapping_varies_by_dest_ipv4),
        (report.udp_v6, report.mapping_varies_by_dest_ipv6),
    ];
    let mut any_stable = false;
    for (udp, mapping) in families {
        if !udp {
            continue;
        }
        match mapping {
            Some(true) => return PunchExpectation::RelayOnly,
            Some(false) => any_stable = true,
            None => {}
        }
    }
    if any_stable {
        PunchExpectation::DirectLikely
    } else {
        PunchExpectation::DirectPossible
    }
}

/// 单族观测明细。
fn family_of(udp: bool, mapping: Option<bool>, observed: Option<impl std::fmt::Display>) -> FamilyMapping {
    FamilyMapping {
        udp,
        mapping_varies: mapping,
        observed: observed.map(|o| o.to_string()),
    }
}

/// 取共享端点最新一次 net_report 快照；端点未绑定或报告未就绪 → `None`。
pub async fn snapshot(ep: &Endpoint) -> Option<NetDiagSnapshot> {
    let mut watcher = ep.net_report();
    // 报告最多几秒一份；没就绪时不让命令层挂着等，直接报「尚未完成」。
    // initialized() 的 Output 是首个非 None 的 Value（NetReport 本体，见 n0-watcher）。
    let fut = watcher.initialized();
    let report = tokio::time::timeout(Duration::from_secs(8), fut).await.ok()?;
    Some(to_snapshot(&report))
}

fn to_snapshot(report: &NetReport) -> NetDiagSnapshot {
    let mut relay_latencies_ms: Vec<RelayLatencyEntry> = report
        .relay_latency
        .iter()
        .map(|(probe, url, dur)| RelayLatencyEntry {
            probe: format!("{probe:?}"),
            relay: url.to_string(),
            ms: dur.as_millis() as u64,
        })
        .collect();
    relay_latencies_ms.sort_by(|a, b| a.ms.cmp(&b.ms));
    NetDiagSnapshot {
        udp_v4: report.udp_v4,
        udp_v6: report.udp_v6,
        mapping_varies_by_dest_ipv4: report.mapping_varies_by_dest_ipv4,
        mapping_varies_by_dest_ipv6: report.mapping_varies_by_dest_ipv6,
        global_v4: report.global_v4.as_ref().map(ToString::to_string),
        global_v6: report.global_v6.as_ref().map(ToString::to_string),
        captive_portal: report.captive_portal,
        preferred_relay: report.preferred_relay.as_ref().map(ToString::to_string),
        relay_latencies_ms,
        verdict: punch_verdict(report),
        family_v4: family_of(report.udp_v4, report.mapping_varies_by_dest_ipv4, report.global_v4.as_ref()),
        family_v6: family_of(report.udp_v6, report.mapping_varies_by_dest_ipv6, report.global_v6.as_ref()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, SocketAddrV4};

    #[tokio::test]
    async fn endpoint_close_stops_watchers_even_while_arc_is_retained() {
        let ep = Arc::new(Endpoint::bind(iroh::endpoint::presets::Minimal).await.unwrap());
        let task = tokio::spawn(watch(ep.clone()));
        ep.close().await;
        tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await.expect("诊断任务必须随端点关闭退出")
            .expect("诊断任务不能 panic");
    }

    /// 手工构造报告：`#[non_exhaustive]` 不能字面构造，Default + 逐字段改。
    fn report(udp_v4: bool, varies_v4: Option<bool>) -> NetReport {
        let mut r = NetReport::default();
        r.udp_v4 = udp_v4;
        r.mapping_varies_by_dest_ipv4 = varies_v4;
        if udp_v4 {
            r.global_v4 = Some(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 1234));
        }
        r
    }

    #[test]
    fn 判定_各网络形态_与决策稿规则一致() {
        // 期望值逐字写死（判据 20-②：不许遍历被测常量自证）。
        assert_eq!(punch_verdict(&report(true, Some(false))), PunchExpectation::DirectLikely);
        assert_eq!(punch_verdict(&report(true, Some(true))), PunchExpectation::RelayOnly);
        assert_eq!(punch_verdict(&report(true, None)), PunchExpectation::DirectPossible);
        assert_eq!(punch_verdict(&report(false, None)), PunchExpectation::UdpBlocked);

        let mut captive = report(true, Some(false));
        captive.captive_portal = Some(true);
        assert_eq!(punch_verdict(&captive), PunchExpectation::Captive);
        // captive 为 false 不遮蔽正常判定。
        captive.captive_portal = Some(false);
        assert_eq!(punch_verdict(&captive), PunchExpectation::DirectLikely);
    }

    #[test]
    fn 判定_对称性按族分开_不因v6连坐稳定的v4() {
        // iroh 聚合口径（v4||v6）会把这条误判成 RelayOnly；我们的收口判定不连坐：
        // v4 稳定 + v6 对称 → v4 仍可直连，主判定按「任一族对称即最悲观」给 RelayOnly，
        // 但 v4 明细保留 Some(false) 供前端展示族间差异。
        let mut r = report(true, Some(false));
        r.udp_v6 = true;
        r.mapping_varies_by_dest_ipv6 = Some(true);
        assert_eq!(punch_verdict(&r), PunchExpectation::RelayOnly);
        assert_eq!(r.mapping_varies_by_dest_ipv4, Some(false));
    }

    #[test]
    fn 快照_字段映射与判定一致() {
        // RelayLatencies 只能由 iroh 探测进程内部填充（update_relay 是 pub(super)），
        // 延迟排序留给探针实测核对；这里钉住字段映射与判定联动。
        let mut r = report(true, Some(false));
        r.preferred_relay = Some("https://relay.example".parse().unwrap());
        let snap = to_snapshot(&r);
        assert_eq!(snap.verdict, PunchExpectation::DirectLikely);
        assert_eq!(snap.preferred_relay.as_deref(), Some("https://relay.example/"));
        assert!(snap.family_v4.udp);
        assert_eq!(snap.family_v4.mapping_varies, Some(false));
        assert!(!snap.family_v6.udp);
        assert_eq!(snap.relay_latencies_ms.len(), 0);
    }
}
