//! 混合逻辑时钟（M6，设计稿 §7.5 档②）。
//!
//! # 它修的是什么
//!
//! §7.5 自己推翻了 §7.1 的「`updated_ms` 是全局偏序」：**墙钟跨机不可比**。
//! 两台机器差几秒到几分钟是常态（NTP 间隔、休眠唤醒、虚拟机、手动改时间）。
//! 于是会出现这个**静默丢数据**：
//!
//! 1. A 在自己钟上 10:00:05 改了一篇，同步给 B
//! 2. B 的钟慢 10 秒，B 在**看到 A 那版之后**于自己钟上 10:00:03 又改了一次
//! 3. 后写胜按数值比 → **B 那次编辑输了**，而它明明是后发生的
//!
//! B 的改动就这么没了，**不进冲突列表**（因为不是同一毫秒），
//! 而 §7.4 把这类当成「概率极低」放过了。
//!
//! # 做法：把见过的远端最大值吸进本机时钟
//!
//! 不加列、不加逻辑计数器。`updated_ms` 已经由 P2a 保证**本机永不倒退**
//! （`MAX(?, updated_ms + 1)`），这里再加一条：
//!
//! > **本机发出的时间戳，必须大于我们见过的任何时间戳（含远端的）。**
//!
//! 两条合起来，`updated_ms` 就是一个 HLC——物理时间与逻辑计数折进了同一个数。
//! 好处是 **AM-9 的 `ORDER BY … updated_ms DESC` 一行都不用改**。
//!
//! 代价要认：**对端钟快，我们的时间戳会被推着往前跳。** 这是 HLC 的固有代价，
//! 幅度受对端偏斜限制——所以必须有上限，见下。
//!
//! # 🔴 为什么必须有偏斜上限
//!
//! 一台年份设成 2099 的机器，只要同步一次就能把我们的时钟推到 2099，
//! **而且是永久的**（时钟只能前进）。之后本机所有笔记的时间都错，无法恢复。
//!
//! 所以超过 [`MAX_FUTURE_SKEW_MS`] 的远端值**拒绝吸收**，并且——
//!
//! ❗ **拒绝不能静默**。拒了之后我们再也赢不过那台机器的笔记（它的数永远更大），
//! 那是个真实后果，得报出来让人去修钟，
//! 而不是让用户发现「自己改的东西总是不生效」却不知道为什么。

use std::sync::atomic::{AtomicI64, Ordering};

/// 允许吸收的最大「超前」幅度：5 分钟。
///
/// 依据：没跑 NTP 的机器日常漂移是**分钟级**，不是小时级。
/// 5 分钟能容下真实偏斜，又拦得住年份/时区设错那一类（差几小时到几年）。
pub const MAX_FUTURE_SKEW_MS: i64 = 5 * 60 * 1000;

/// 吸收远端时钟的结果。
#[derive(Debug, PartialEq)]
pub enum Absorb {
    /// 吸了（或对方本来就不比我们新，无需动作）。
    Ok,
    /// 🔴 对端时钟超前太多，拒绝吸收。带上超前的毫秒数。
    TooFarAhead { ahead_ms: i64 },
}

/// 本节点的时钟。**一个进程一份**（它是节点的属性，不是数据库句柄的属性）。
#[derive(Debug)]
pub struct HlcClock {
    floor: AtomicI64,
}

impl HlcClock {
    /// 用一个已知下界建时钟。`floor` 通常取
    /// `max(持久化的下界, MAX(notes.updated_ms), MAX(tombstones.tombstone_ms))`。
    pub fn with_floor(floor: i64) -> Self {
        Self {
            floor: AtomicI64::new(floor),
        }
    }

    /// 发一个新时间戳：`max(墙钟, floor + 1)`，并把 floor 抬到它。
    ///
    /// `wall_ms` 由调用方传入而不是这里取，**否则这个函数没法测**
    /// （同 `note_append_daily` 把 date/hm 交给调用方的理由）。
    pub fn issue(&self, wall_ms: i64) -> i64 {
        // fetch_update 而不是 load + store：两个线程同时写笔记时，
        // load+store 会让两者拿到同一个值，那就不是严格递增了。
        match self
            .floor
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |f| {
                Some(wall_ms.max(f + 1))
            }) {
            Ok(prev) => wall_ms.max(prev + 1),
            Err(_) => wall_ms,
        }
    }

    /// 当前下界。只读，用于诊断与持久化。
    pub fn floor(&self) -> i64 {
        self.floor.load(Ordering::SeqCst)
    }

    /// 吸收对端见过的最大时间戳。
    pub fn absorb(&self, remote_max: i64, wall_ms: i64) -> Absorb {
        let ahead = remote_max - wall_ms;
        if ahead > MAX_FUTURE_SKEW_MS {
            return Absorb::TooFarAhead { ahead_ms: ahead };
        }
        self.floor.fetch_max(remote_max, Ordering::SeqCst);
        Absorb::Ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: i64 = 1_788_500_000_000;

    #[test]
    fn test_hlc_墙钟正常时就用墙钟() {
        let c = HlcClock::with_floor(0);
        assert_eq!(c.issue(T), T);
    }

    #[test]
    fn test_hlc_墙钟回拨时也严格递增() {
        let c = HlcClock::with_floor(0);
        assert_eq!(c.issue(T), T);
        // 钟被拨回去 1 秒
        assert_eq!(c.issue(T - 1000), T + 1, "回拨时必须继续前进，不能倒退");
        assert_eq!(c.issue(T - 1000), T + 2);
    }

    #[test]
    fn test_hlc_同一毫秒内连发也严格递增() {
        let c = HlcClock::with_floor(0);
        let a = c.issue(T);
        let b = c.issue(T);
        assert!(b > a, "{} 应大于 {}", b, a);
    }

    /// 🔴 这条是 HLC 的全部意义：吸收远端之后，本机发的必须比远端的大。
    ///
    /// 不这样的话就是模块文档里那个静默丢数据——
    /// B 在看到 A 那版之后改的，却因为自己钟慢而判输。
    #[test]
    fn test_hlc_吸收远端之后本机发的时间戳更大() {
        let c = HlcClock::with_floor(0);
        // 本机钟慢 10 秒；对端那版是 T
        let my_wall = T - 10_000;
        assert_eq!(c.absorb(T, my_wall), Absorb::Ok);
        let mine = c.issue(my_wall);
        assert!(
            mine > T,
            "本机钟慢时，看到远端 {} 之后发出的 {} 仍必须更大",
            T,
            mine
        );
    }

    #[test]
    fn test_hlc_对端不比我们新时不动时钟() {
        let c = HlcClock::with_floor(T);
        assert_eq!(c.absorb(T - 5000, T), Absorb::Ok);
        assert_eq!(c.floor(), T, "对端更旧，不该动本机下界");
    }

    /// 🔴 一台年份设错的机器不能永久污染我们的时钟。
    #[test]
    fn test_hlc_超前太多的远端值拒绝吸收() {
        let c = HlcClock::with_floor(T);
        let far = T + 10 * 365 * 24 * 3600 * 1000; // 声称自己在 10 年后
        match c.absorb(far, T) {
            Absorb::TooFarAhead { ahead_ms } => assert!(ahead_ms > 0),
            other => panic!("该拒绝，实得 {:?}", other),
        }
        assert_eq!(c.floor(), T, "拒绝之后不能留下任何影响");
    }

    #[test]
    fn test_hlc_五分钟内的偏斜照常吸收() {
        let c = HlcClock::with_floor(T);
        let ok = T + MAX_FUTURE_SKEW_MS - 1;
        assert_eq!(c.absorb(ok, T), Absorb::Ok, "分钟级偏斜是常态，不能拦");
        assert_eq!(c.floor(), ok);
    }
}
