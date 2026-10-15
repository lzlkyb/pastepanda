//! P3 — 视频数据报片宽探测（对标 p2wlan `dplpmtud`，2026-10-15）。
//!
//! # 它答什么
//!
//! 被控端→发起端的视频数据报能不能用 1400B 大分片（`vid_dgram::FRAG_BIG`），
//! 还是必须保守走 1000B（`vid_dgram::FRAG`）。链路 MTU 是**路径属性**：
//! 以太网 1500 下大分片每帧包数 −30%（同码率丢包敏感度直降），但 PPPoE /
//! VPN / 中继路径可能吃不下——发出去就是**静默丢**（数据报无重传），
//! 画面雪崩。所以必须探测确认后才升档，探测不过永远保守。
//!
//! # 协议（借 DPLPMTUD 的三要素：探测报文 / 身份 / 确认）
//!
//! 被控端发 `0xD2` 探针数据报（target 总长 = 片宽 + `HEADER`，`nonce` 8B
//! 随机身份 + 声明尺寸 2B，尾部补零到目标长）；发起端在视频数据报读取循环
//! 里认出 `0xD2` **原样回发**；被控端的数据报读取循环认出回显 → [`note_ack`]。
//! 回显到达 = 发起端真的**收到**了那个尺寸的数据报（收不到就不可能回），
//! 这正是视频流方向要证的那条腿；发起端→被控端的回显腿顺带也验了。
//!
//! # 兼容性（旧对端零风险）
//!
//! - 旧发起端：不认识 `0xD2`，探针掉进 `feed` 的 tag 校验被静默丢弃 →
//!   探测超时 → 恒 1000B，行为与今天完全一致；
//! - 被控端只对 `Request.vd_frag > 1000` 的新对端开探测；门在发送端，
//!   flags 位只是随帧自描述（接收端无状态，见 `vid_dgram` 模块头）。
//!
//! # 与 p2wlan 的取舍
//!
//! 它是 VPN 数据面（WireGuard），探测走专用协议、有 8B 粒度二分与
//! 30s 复确认/10min 重升的完整状态机。我们视频数据报只有两档（1000/1400），
//! 粗梯 [`LADDER`] 足够；复确认降级为**周期重探**（[`REPROBE_SECS`]）——
//! 重探失败自动降档，等价于它「复确认失败回落」的语义，代码量减一半。

use super::vid_dgram::{FRAG, FRAG_BIG, HEADER};
use iroh::endpoint::Connection;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// 探针标记字节（与视频数据报 `DGRAM_TAG=0xD1` 区分；误解包即弃）。
pub const PROBE_TAG: u8 = 0xD2;
/// 探针头：tag 1B + nonce 8B + 声明尺寸 2B = 11B；其余补零到目标总长。
pub const PROBE_HEAD: usize = 11;
/// 探测梯（数据报总长 = 片宽 + 头）。降序尝试，**首个成功即用**——
/// 不做二分：两档制下梯子就这两级，1400 走不通试 1200（WiFi+隧道常见），
/// 再不通回 1000。1300 的边际收益配不上多一轮探测延迟。
const LADDER: [usize; 2] = [FRAG_BIG + HEADER, 1200 + HEADER];
/// 每轮尺寸发多少个探针（丢 1 个不误判，全丢才算失败）。
const PROBES_PER_SIZE: usize = 4;
/// 探针间隔（把 4 个摊在 400ms 里，跨慢中继也不挤）。
const PROBE_GAP_MS: u64 = 100;
/// 等回显的超时：> 中继 RTT 上界（秒级），小于它会让慢路径永远升不了档。
const ACK_WAIT_MS: u64 = 3_000;
/// 重探周期。路径变化（直连↔中继切换）会改 MTU；10min 内自愈。
const REPROBE_SECS: u64 = 600;

/// 等待确认的探针身份（回显核对的唯一依据）：每个 nonce 占一个 bit。
static ACK_SEEN: AtomicU64 = AtomicU64::new(0);

/// 回显处理器调用：登记「这个 nonce 被对端确认收到」。探测循环轮询它。
pub fn note_ack(nonce: u64) {
    ACK_SEEN.fetch_or(nonce_bit(nonce), Ordering::Relaxed);
}

fn nonce_bit(nonce: u64) -> u64 {
    1u64 << (nonce % 63)
}

/// 构造一个探针数据报（总长 `total`，尾部补零）。`nonce` 用 1..63 的
/// 序号（bit 位身份，见 [`nonce_bit`]）。
fn probe_datagram(total: usize, nonce: u64) -> Vec<u8> {
    let mut dg = vec![0u8; total.max(PROBE_HEAD)];
    dg[0] = PROBE_TAG;
    dg[1..9].copy_from_slice(&nonce.to_le_bytes());
    dg[9..11].copy_from_slice(&(total as u16).to_le_bytes());
    dg
}

/// 从线上字节解析探针（回显两端都要解析）。返回 `(nonce, 声明总长)`。
pub fn parse_probe(dg: &[u8]) -> Option<(u64, u16)> {
    if dg.len() < PROBE_HEAD || dg[0] != PROBE_TAG {
        return None;
    }
    let nonce = u64::from_le_bytes(dg[1..9].try_into().ok()?);
    let total = u16::from_le_bytes(dg[9..11].try_into().ok()?);
    Some((nonce, total))
}

/// 被控端探测任务入口。`max_frag` = 对端声明能解的最大片宽
/// （`Request.vd_frag`，≤1000 时调用方不该 spawn 本任务，这里也再防一道）。
///
/// 流程：**先复位 1000**（防上一场残留）→ 逐级试 [`LADDER`]（总长换算回
/// 片宽写 [`super::stream_cfg::set_vd_frag`]）→ 每 [`REPROBE_SECS`] 重探
/// （重探从当前档起，失败自动降档）。会话结束由调用方丢弃本任务
/// （会话 id 检查在宿主循环里，与其它 inbound 任务同纪律）。
pub async fn run(conn: Connection, max_frag: usize) {
    super::stream_cfg::set_vd_frag(FRAG);
    if max_frag <= FRAG {
        return; // 旧对端：门没开，恒 1000，别白发探针
    }
    let mut current = FRAG;
    loop {
        // 逐级上探：首个确认的档生效（含当前档的再确认）。
        for &total in LADDER.iter() {
            let frag = total - HEADER;
            if frag <= current {
                continue; // 不低于已在用的档
            }
            if probe_once(&conn, total).await {
                current = frag;
                super::stream_cfg::set_vd_frag(current);
                log::info!("[PMTUD] 片宽升档 {} → {}（数据报 {}B）", FRAG, current, total);
                break;
            }
        }
        // 等下一轮重探（路径变化 10min 内自愈；会话死了任务随宿主循环退出）。
        tokio::time::sleep(Duration::from_secs(REPROBE_SECS)).await;
        // 重探失败要能降档：先把 current 清回安全档再走上面的梯子。
        // （成功则梯子第一级就是它自己，立刻恢复。）
        current = FRAG;
        super::stream_cfg::set_vd_frag(FRAG);
    }
}

/// 单档探测：发 [`PROBES_PER_SIZE`] 个探针，[`ACK_WAIT_MS`] 内任意一个
/// 被确认即算过。全静默 = 路径吃不下（或对端不认识探针），返回 false。
async fn probe_once(conn: &Connection, total: usize) -> bool {
    ACK_SEEN.store(0, Ordering::Relaxed);
    for i in 0..PROBES_PER_SIZE {
        let nonce = 1 + i as u64; // bit 身份，见 nonce_bit
        let dg = probe_datagram(total, nonce);
        if conn.send_datagram(dg.into()).is_err() {
            // 本地 QUIC 都塞不下（max_datagram_size 上限）→ 直接判负。
            return false;
        }
        tokio::time::sleep(Duration::from_millis(PROBE_GAP_MS)).await;
    }
    // 等回显：任一 nonce 位被登记即成功。
    let deadline = tokio::time::Instant::now() + Duration::from_millis(ACK_WAIT_MS);
    let want: u64 = (1..=PROBES_PER_SIZE as u64).map(nonce_bit).fold(0, |a, b| a | b);
    while tokio::time::Instant::now() < deadline {
        if ACK_SEEN.load(Ordering::Relaxed) & want != 0 {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_探针往返解析_身份与尺寸不串线() {
        // 往返：构造 → 解析必须还原 nonce 与总长（发起端回显 = 原样回发，
        // 被控端解析出的身份必须能对上本轮的 bit）。
        let dg = probe_datagram(1434, 3);
        assert_eq!(dg.len(), 1434, "探针总长必须精确 = 目标数据报尺寸");
        assert_eq!(dg[0], PROBE_TAG);
        let (nonce, total) = parse_probe(&dg).expect("合法探针必须能解析");
        assert_eq!((nonce, total), (3, 1434));
        // 身份 bit 隔离：3 号确认不应满足 1/2 号的等待位（防陈旧回显配错轮）
        assert_eq!(nonce_bit(3) & nonce_bit(1), 0);
        assert_eq!(nonce_bit(3) & nonce_bit(2), 0);
        let want: u64 = (1..=2u64).map(nonce_bit).fold(0, |a, b| a | b);
        assert_eq!(want & nonce_bit(3), 0, "本轮只发了 2 个探针，3 号的确认不该命中");
        assert_eq!(want & nonce_bit(1), nonce_bit(1), "1 号确认必须命中");
    }

    #[test]
    fn test_非探针字节不误认() {
        // 视频数据报（0xD1）绝不能被认成探针——发起端读取循环先查 tag 再喂
        // 重组器，这条守卫钉住「tag 分流不吞视频帧」。
        let mut video = probe_datagram(1034, 1);
        video[0] = super::super::vid_dgram::DGRAM_TAG;
        assert_eq!(parse_probe(&video), None, "0xD1 视频帧不许被当探针");
        assert_eq!(parse_probe(&[]), None);
        assert_eq!(parse_probe(&[PROBE_TAG; 5]), None, "短于探针头的字节不许解析");
    }

    #[test]
    fn test_梯子与档位换算() {
        // 梯子第一级 = FRAG_BIG + HEADER：升档写回片宽时换算不能错一位
        // ——错一位就是 1433B 探针换来 1401B 片宽、线上帧超预算被全网丢弃。
        let total = LADDER[0];
        assert_eq!(total - HEADER, FRAG_BIG);
        assert_eq!(LADDER[1] - HEADER, 1200);
        assert!(total > 1200 + HEADER, "梯子必须降序");
    }

    #[test]
    fn test_note_ack位语义成立() {
        // note_ack 是回显处理器与探测循环的唯一交汇。
        // 这里钉 bit 语义本身（fetch_or 累积、不互踩）——
        // 曾在这里犯过「fetch_or(nonce) 而不是 bit」的错，这条守卫钉住它。
        ACK_SEEN.store(0, Ordering::Relaxed);
        note_ack(2);
        assert_eq!(ACK_SEEN.load(Ordering::Relaxed) & nonce_bit(2), nonce_bit(2));
        assert_eq!(ACK_SEEN.load(Ordering::Relaxed) & nonce_bit(1), 0);
        note_ack(1);
        assert_ne!(ACK_SEEN.load(Ordering::Relaxed) & nonce_bit(1), 0);
        ACK_SEEN.store(0, Ordering::Relaxed);
    }
}
