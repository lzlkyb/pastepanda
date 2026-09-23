//! 进程内单调时钟（C3，2026-09-23 审计）。
//!
//! # 为什么要有它
//!
//! 远程电脑的所有超时判据（会话 TTL、心跳停滞、推流暂停、重连 settle）原先全走
//! `chrono::Utc::now()`——**墙钟**。墙钟会在会话中途跳变：系统时间自动同步、
//! 手动改表、时区/DST 边界、虚拟机恢复。跳一次：
//! - 向前跳 → 正在开的会话被判过期/停滞，毫无反常地断流；
//! - 向后跳 → 该断的不断（TTL 形同失效），看门狗失灵。
//!
//! 超时是「过了多久」的问题，正确答案只能来自单调钟。墙钟只留给两个用途：
//! 展示时间戳、跨进程/跨机比较（历史记录、配对 join 的 at_ms）。
//!
//! # 口径
//!
//! `mono_ms()` = 距**本进程启动**的毫秒数，恒 ≥0、恒增、量级远小于 epoch
//! （进程活一天 ≈ 8.6e7，epoch ≈ 1.7e12）。这个量级差是守卫单测的判据，
//! 也是防误用的护栏：谁把墙钟值混进单调域，比较立刻露馅。
//!
//! # 跨端边界
//!
//! 本基座是进程私有的——**绝不能把 `mono_ms()` 裸值发出去**（对端/前端各自有
//! 不同的基座，跨基座比较无意义）。投影给前端时换算成 age（差值），前端用
//! `performance.now()` 外推，见 `RcStatus.pong_age_ms`。

use std::sync::OnceLock;
use std::time::Instant;

fn epoch() -> &'static Instant {
    static BASE: OnceLock<Instant> = OnceLock::new();
    BASE.get_or_init(Instant::now)
}

/// 距进程启动的单调毫秒数。超时判据的唯一时间源。
///
/// 下限钳到 **1**：下游多处用 `0` 当「还没有过」哨兵（pong 时刻、活动时刻），
/// 基座落地后的第一个毫秒若返回 0，真实事件会被误读成「从未发生」。
pub fn mono_ms() -> i64 {
    epoch().elapsed().as_millis().max(1) as i64
}

#[cfg(test)]
mod tests {
    use super::mono_ms;

    #[test]
    fn mono_is_far_below_epoch() {
        // 守卫：单调值量级必须远小于墙钟 epoch（≈1.7e12）。
        // 若哪天有人把墙钟混进这个口径，此处与下游比较一起露馅。
        let m = mono_ms();
        assert!(m >= 0);
        assert!(m < 100_000_000_000, "mono_ms 不该达到 epoch 量级：{m}");
    }

    #[test]
    fn mono_is_nondecreasing() {
        let a = mono_ms();
        let b = mono_ms();
        assert!(b >= a);
    }
}
