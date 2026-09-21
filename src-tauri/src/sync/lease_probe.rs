//! 同步「在线租约」窗口的**实测探针**（2026-09-21 临时加，定完窗口就删）。
//!
//! # 为何要有它
//!
//! `kbOnline.ts` 的 `ONLINE_STALE_MS`（现 `90_000`）是**推算**出来的——
//! 注释写着「同步周期 30s ± 10s，两个周期还没动静就不该说在线」。
//! 但那个 30s 是 `coordinate::PERIOD_SECS` 的**配置值**，不是「两次真续约
//! 之间实际过了多久」的**实测值**。两者会不一样：
//!
//! - 心跳（`Wait::Heartbeat`）只在**两边都没改过东西**时走空闲那条路，
//!   有活干时是「脏了就拨」——间隔由 `MIN_SESSION_GAP` + 合并窗口决定；
//! - 退避（`Wait::Fixed`）会让成功的间隔**远大于**一个周期；
//! - 休眠（`Wait::Dormant`）时是分钟级。
//!
//! 于是「窗口取 90s」到底够不够，只有实测能回答。
//! ⚠️ 特别注意**退避与休眠**：那两种情况下的间隔可能到分钟级，
//! 若要让在线显示覆盖它们，窗口就得跟着放大——但那会让「对端真挂了」
//! 也被多显示成在线很久。这正是那个不可兼得的取舍，得拿数据定。
//!
//! # 怎么用
//!
//! 跑一段时间的真机同步（含正常空闲期），然后 grep 日志：
//!
//! ```text
//! [SYNC-LEASE] peer=12345678 距上次续约 31.2s（累计 7 次，min 30.1 max 61.4 窗口 90s）
//! ```
//!
//! 判据：**`max` 明显小于 `ONLINE_STALE_MS`** 才安全。若 `max` 逼近或超过
//! 窗口，说明窗口会被正常的空闲期顶穿 → 设备随机闪离线 → 需要调大窗口。
//! 反过来若 `max` 只有窗口的一半不到，窗口可以收紧（更快发现真离线）。
//!
//! # 设计约束
//!
//! - **只读不写**：不动任何库、不影响判定、不改变循环节奏。
//! - **常驻开销可忽略**：每条对端一个 `(last_ms, count, min, max)` 四元组，
//!   调用点是同步成功路径（本来就一条 `log::info!`），不引入额外 IO。
//! - **内存态**：进程重启即清，不需要清理逻辑（也因此 `min` 是「本次运行内」的）。

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::OnceLock;

/// 一条对端的续约统计（都是**本次进程运行内**的）。
#[derive(Debug, Clone, Copy)]
struct Lease {
    /// 上一次成功续约的时刻（毫秒）。
    last_ms: i64,
    /// 本次运行内续约了几次。
    count: u32,
    /// 相邻两次续约间隔的最小值（只有 `count >= 2` 才有意义）。
    min_gap_ms: i64,
    /// 相邻两次续约间隔的最大值。
    max_gap_ms: i64,
}

fn table() -> &'static Mutex<HashMap<String, Lease>> {
    static T: OnceLock<Mutex<HashMap<String, Lease>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 记一次「真续约」（同步成功、`device_mark_online` 刚写过库）。
///
/// `now_ms` 由调用方传入（它那边刚取过），不在这里再取一次——
/// 两次取时间会差几毫秒，而它要跟 `device_mark_online` 写进库的
/// `last_seen` 对齐。
///
/// ❗ 只在**成功**路径调。失败路径不调（那不是续约，是租约断了）。
pub fn record(peer: &str, now_ms: i64) {
    let mut m = match table().lock() {
        Ok(m) => m,
        //  poisoning 不该让同步循环崩——探针崩掉是最坏的权衡。
        Err(p) => p.into_inner(),
    };
    let short = &peer[..8.min(peer.len())];
    match m.get_mut(peer) {
        None => {
            m.insert(
                peer.to_string(),
                Lease {
                    last_ms: now_ms,
                    count: 1,
                    min_gap_ms: i64::MAX,
                    max_gap_ms: 0,
                },
            );
            // 首次：还没有间隔可报，但要说清「探针生效了」——
            // 否则日志里没 `[SYNC-LEASE]` 会分不清是「探针没生效」还是
            // 「一次都没成功过」。RC 那边的 `[RC-PERF]` 也是这个理由。
            log::info!(
                "[SYNC-LEASE] peer={} 首次续约（本次运行第 1 次）—— 探针已生效",
                short
            );
        }
        Some(l) => {
            let gap = now_ms - l.last_ms;
            l.last_ms = now_ms;
            l.count += 1;
            // ❗ 只在间隔**非负**时更新 min：时钟回拨（或 `i64` 溢出）会产生
            //    负数，混进 `min` 会把「最小间隔」永久钉在一个假值上。
            if gap >= 0 {
                l.min_gap_ms = l.min_gap_ms.min(gap);
                l.max_gap_ms = l.max_gap_ms.max(gap);
            }
            let window = crate::sync::lease_probe::current_window_ms();
            log::info!(
                "[SYNC-LEASE] peer={} 距上次续约 {:.1}s（累计 {} 次，min {:.1} max {:.1} 窗口 {}s）{}",
                short,
                gap as f64 / 1000.0,
                l.count,
                l.min_gap_ms as f64 / 1000.0,
                l.max_gap_ms as f64 / 1000.0,
                window / 1000,
                // 间隔已经顶穿窗口时明确预警：这是「设备会闪离线」的直接征兆。
                if gap > window {
                    "  ⚠️ 已超窗口：该设备在两次续约之间会被判离线"
                } else {
                    ""
                }
            );
        }
    }
}

/// 当前生效的在线窗口（毫秒）。
///
/// 读的是后端自己的那份常量，**故意不从 `kbOnline.ts` 拿**——
/// 那是前端文件，后端 `include_str!` 一个 `.ts` 只为读个数字
/// 是把两个模块焊死。这里重复定义 + 一条注释指路，
/// 两边不一致时以「日志里打出来的窗口」为准去核对前端。
fn current_window_ms() -> i64 {
    // ❗ 与 `src/lib/kbOnline.ts` 的 `ONLINE_STALE_MS` 必须一致。
    //    改了那边记得改这里（探针存在的意义就是让这个数**可见**，
    //    它自己写错的话会误导窗口取值）。
    90_000
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 探针不得 panic、不得因重复 peer 累积错误状态。
    ///
    /// ❗ 没法断言日志内容（`log` 在测试里没有捕获层），所以这里钉的是
    /// **不崩** + **计数正确**这两条能真正验证的性质。
    #[test]
    fn 探针连续记录不崩且计数正确() {
        let peers = table();
        peers.lock().map(|mut t| t.clear()).unwrap_or_default();
        record("aaaaaaaaaaaaaaaa", 1000);
        record("aaaaaaaaaaaaaaaa", 2000); // gap 1000
        record("aaaaaaaaaaaaaaaa", 3500); // gap 1500
        let t = peers.lock().unwrap();
        let l = t.get("aaaaaaaaaaaaaaaa").expect("应有记录");
        assert_eq!(l.count, 3, "三次续约应记 3 次");
        assert_eq!(l.min_gap_ms, 1000, "最小间隔应是最短的那次");
        assert_eq!(l.max_gap_ms, 1500, "最大间隔应是最长的那次");
        assert_eq!(l.last_ms, 3500, "last 应是最后一次");
    }

    /// 时钟回拨产生的负间隔**不得**污染 `min`。
    #[test]
    fn 时钟回拨不污染最小间隔() {
        let peers = table();
        peers.lock().map(|mut t| t.clear()).unwrap_or_default();
        record("bbbbbbbbbbbbbbbb", 10_000);
        record("bbbbbbbbbbbbbbbb", 2_000); // 回拨：gap = -8000
        let t = peers.lock().unwrap();
        let l = t.get("bbbbbbbbbbbbbbbb").expect("应有记录");
        assert_eq!(l.count, 2);
        assert_eq!(l.min_gap_ms, i64::MAX, "负间隔不应进入 min");
        assert_eq!(l.max_gap_ms, 0, "负间隔也不应进入 max");
    }

    /// 窗口与前端常量必须一致——这是探针唯一的「正确性」依赖。
    #[test]
    fn 窗口常量与前端一致() {
        // 用 `include_str!` 直接读前端源码，免得两边悄悄漂移：
        // 探针打出的窗口要是错的，拿它当依据定窗口取值就会被带偏。
        let ts = include_str!("../../../src/lib/kbOnline.ts");
        assert!(
            ts.contains("ONLINE_STALE_MS = 90_000"),
            "探针里写死 90_000，但 kbOnline.ts 已经不是这个值了——\
             两边必须同步（改了前端就把 lease_probe::current_window_ms 也改掉）"
        );
    }
}
