//! 会话链路状态：**数据走哪条路** + **链路还活着吗**（2026-09-17 对标改造）。
//!
//! # 它答什么
//!
//! | 问题 | 来源 |
//! |---|---|
//! | 数据实际走的哪条路 | 复用 [`crate::sync::path_kind`]，从 iroh **活连接**实测 |
//! | 链路还活着吗 | 最后一次收到对端 pong 的时刻（`last_pong_ms`，C3 起为单调口径） |
//!
//! # 🔴 它刻意不答什么（这是本模块存在的主要理由）
//!
//! **不答「画面有没有更新」。** 被控端在画面无变化时刻意不推帧
//! （`video.rs` 的 `DirtyOutcome::Static` → `inbound.rs` 里 `jpeg.is_empty()`
//! 直接 Sleep）。所以「2.5s 没有新帧」是**正常状态**，不是链路故障。
//! 前端曾经拿它当断链证据（`stalled`），结果是用户看一屏静止桌面 2.5 秒
//! 就见到「画面已停滞」+「心跳超时」，而 ping/pong 一直通着——必然误报。
//! 现在帧静默归 UI 侧的中性观测，链路活性只认本模块的 pong 时间戳。
//!
//! **也不答「在不在线」。** 那是 `devices.last_ok_ms` + 组播的事。
//!
//! # 为什么可以信 `Connection::paths()`
//!
//! `sync/path_kind.rs` 的模块头已经把 iroh 1.1.0 的源码考证写全了
//! （`remote_info()` 的 `Active` 粘滞、连接关闭不清理），这里不再重复：
//! **只用按连接的 `paths()`，绝不用 `Endpoint::remote_info()`**。

use crate::sync::path_kind::{self, PathKind};
use iroh::endpoint::Connection;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;

/// 🔴 P1-5（2026-09-23 审计）：半开链路看门狗的踢人阈值（毫秒）。
///
/// # 为什么是 15 秒
///
/// 心跳是发起端 UI 每约 1 秒一条 ping、被控端立刻回 pong：
/// - 3.5s（`stream_cfg::HEARTBEAT_TIMEOUT_MS`）没动静 → **暂停推流**，
///   这是省带宽的软判据，一条丢包就能触发，绝不能拿来做收口；
/// - 15s ≈ 连着丢 15 条心跳，且给了「对端整机睡眠 3 秒后醒来」两轮的余量。
///   半开连接（QUIC 不会立刻报错、对端进程被杀/拔网线）此前只有
///   `SESSION_TTL_MS`（2 小时）兜底——被控端可以挂着「正在被控制」的横幅、
///   发起端可以挂着「已连接」的画面，两小时不放。
///
/// 阈值定义成常量而不是散在两处循环里的字面量：两边（发起/被控）必须是同一个数，
/// 否则「一侧认为还活着、另一侧已经收口」。
pub const LINK_STALE_KICK_MS: i64 = 15_000;

/// 半开判定（纯函数，时间由调用方传入 —— 同 `stream_cfg` 的假时钟纪律）：
/// 这条链路是不是已经**没有任何证据**了？
///
/// - `last_evidence_ms` 是被控侧的「最后一次收到对端输入/心跳」或发起侧的
///   「最后一次登记连接 / 收到 pong」，取哪个由调用方决定（两边证据的来源不同）；
/// - `0` 表示该证据还没有过 ⇒ 回落成从 `started_ms` 起算的宽限期，
///   刚建好的会话不该因为「还没来得及收心跳」被踢；
/// - 两个都是 0（调用方连会话开始时间都没给）→ **不踢**。宁可漏踢一次
///   （还有 TTL 兜底），也不能因为拿不到数据就收掉别人正在用的会话。
/// - 边界取严格 `>`：正好卡在阈值上不算失联（与 `should_pause` 同口径）。
pub fn link_stale_kick(started_ms: i64, last_evidence_ms: i64, now_ms: i64, timeout_ms: i64) -> bool {
    let base = started_ms.max(last_evidence_ms);
    base > 0 && now_ms - base > timeout_ms
}

/// 发起侧看门狗的**活性证据**：三个来源取最大（任一成立即算活着）。
///
/// 抽成纯函数、而不是把三个 `.max()` 直接写在 `outbound_heartbeat_stale` 里，
/// 是为了让守卫单测能**直接钉住生产判据**（「入站帧可以顶替缺失的 pong」）——
/// 那正是 v7.2.5 回归里被误踢的场景——而不必构造整个 `RcService`。
///
/// - `attached_ms`：连接刚登记（会话建好、还没收到任何东西）的宽限期；
/// - `last_pong_ms`：心跳往返 —— **依赖发起端前端 UI 每秒发 ping**；
/// - `last_inbound_ms`：任何入站帧（画面 / 控制帧）—— **不依赖前端**。
///
/// 三者同为单调 ms 口径，`0` = 尚未有过。返回 `0` 表示「一次证据都没有」。
pub fn heartbeat_evidence(attached_ms: i64, last_pong_ms: i64, last_inbound_ms: i64) -> i64 {
    attached_ms.max(last_pong_ms).max(last_inbound_ms)
}

/// 会话收尾时交回的东西：这一程**走的是哪条路** + **网速摘要**。
///
/// 两者都在 `detach` 时一次性取出——因为它们都只能从活连接读，
/// 分开两次调用容易出现「读了一个、另一个已经被清空」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinkEnd {
    /// 本次实际走的路径。
    pub path: PathKind,
    /// RTT 摘要（毫秒）：`(min, avg, max)`；全 0 = 本会话没采到样本。
    pub rtt_min: i64,
    pub rtt_avg: i64,
    pub rtt_max: i64,
}

/// RTT 采样累积（**会话内内存中，不落盘**）。
///
/// # 为什么是摘要而不是曲线
///
/// 会话历史存在 `config` 的 JSON blob 里（`rc.history::KEY`，最多 20 条），
/// 每次 `save_config` 都是**整份写盘**。一条 10 分钟的会话按每秒采样就是
/// 600 个点，20 条历史 = 一万多个数字，成本和收益完全不成比例。
/// 而「这次会话网速怎么样」用 min/avg/max 就答完了。
#[derive(Default, Clone, Copy)]
struct RttAcc {
    min: i64,
    max: i64,
    sum: i64,
    count: u32,
}

impl RttAcc {
    fn push(&mut self, rtt_ms: i64) {
        // ❗ 只在 `> 0` 时采样。`RcService::note_rtt(0)` 是**清零复位**、
        //    不是一次测量；把它算进来会让 avg 被拽向 0，看着像「网速突然变好」。
        if rtt_ms <= 0 {
            return;
        }
        self.min = if self.count == 0 {
            rtt_ms
        } else {
            self.min.min(rtt_ms)
        };
        self.max = self.max.max(rtt_ms);
        self.sum += rtt_ms;
        self.count += 1;
    }

    /// `(min, avg, max)`；没采到样本时全 0——前端据此不显示这一格。
    fn summary(&self) -> (i64, i64, i64) {
        if self.count == 0 {
            return (0, 0, 0);
        }
        (self.min, self.sum / i64::from(self.count), self.max)
    }
}

/// 会话链路状态。
///
/// 生命周期与会话对齐：`attach` 在建会话时登记连接，`detach` 在收尾时清空
/// 并交回本次走的路与网速摘要（供历史记录落库）。无会话时字段都是「空」。
pub struct LinkState {
    /// 会话的 iroh 连接句柄（clone 的 handle）。连接关闭后它仍在，但
    /// `paths()` 会返回最后一份快照——所以只能用来读，不能用来判在线。
    conn: Mutex<Option<Connection>>,
    /// 🔴 C3（2026-09-23 审计）：最后一次收到对端 pong 的时刻（**单调 ms**，
    /// `mono::mono_ms()` 口径）；0 = 还没收到过。原先存 epoch ms——墙钟一跳，
    /// 发起侧看门狗的「距最后一次 pong」就会算错（向前跳误踢、向后跳永不断）。
    /// 单调基座是进程私有的：这个裸值**不得**直接发给前端（跨基座无意义），
    /// 出网一律换算成 age，见 `pong_age_ms`。
    last_pong_ms: Mutex<i64>,
    /// 🔴 P1-5：本次连接登记（`attach`）的时刻（单调 ms，同上 C3）；0 = 没有活动会话。
    ///
    /// 看门狗在**发起侧**的起算锚点。为什么不能直接用会话的 `started_ms`：
    /// 拨号本身最长 15 秒（`dial_and_request` 的超时），拿「申请发出」当锚点
    /// 会让一场慢连接刚建立就被判失联。`attach` 发生在连接真通之后、
    /// 会话转 Active 之前，才是「这条链路开始活着」的时刻。
    attached_ms: AtomicI64,
    /// 🔴 P1-5 后续（2026-09-23，v7.2.5 回归后补）：最后一次收到**任何**入站帧
    /// （控制帧 / JPEG / H.264）的时刻（单调 ms）；0 = 本会话还没收到过。
    ///
    /// # 为什么看门狗不能只信 `last_pong_ms`
    ///
    /// pong 的前提是发起端**前端 UI 每秒发一条 ping**（`useRcLinkState` 的
    /// interval，由会话视图挂载驱动）。会话窗口一旦不跑（前端异常、视图被换掉），
    /// 被控端照样活着、画面照样在推，看门狗却会把它判成「对端失联」——
    /// 这正是 `last_pong_ms` 单证据的漏洞。任何成功到达的入站帧都是「链路还活着」
    /// 的硬证据，且**不依赖前端**，所以拿它与 pong 并列取最大。
    last_inbound_ms: AtomicI64,
    /// 上一次上报给前端的路径档位。用于「换路了」通知去重
    /// （多实例并发轮询 `rc_status` 时，变化只该被消费一次）。
    reported: Mutex<PathKind>,
    /// 本会话的 RTT 采样累积（`detach` 时交出，`attach` 时清零）。
    rtt: Mutex<RttAcc>,
}

impl Default for LinkState {
    fn default() -> Self {
        Self::new()
    }
}

impl LinkState {
    pub const fn new() -> Self {
        Self {
            conn: Mutex::new(None),
            last_pong_ms: Mutex::new(0),
            attached_ms: AtomicI64::new(0),
            last_inbound_ms: AtomicI64::new(0),
            reported: Mutex::new(PathKind::None),
            rtt: Mutex::new(RttAcc {
                min: 0,
                max: 0,
                sum: 0,
                count: 0,
            }),
        }
    }

    /// 会话建立时登记连接句柄（clone，不是拿走所有权）。
    ///
    /// 顺带把 pong 与入站时刻清零：新会话不能继承上一个会话的「刚刚还有心跳」，
    /// 否则断线重连后的头几秒会谎报已连接——**两个活性证据位都要清，漏一个等于没清**。
    pub fn attach(&self, conn: &Connection) {
        *self.conn.lock().unwrap_or_else(|p| p.into_inner()) = Some(conn.clone());
        *self.last_pong_ms.lock().unwrap_or_else(|p| p.into_inner()) = 0;
        self.last_inbound_ms.store(0, Ordering::Relaxed);
        // 🔴 P1-5：连接真通的那一刻起表，看门狗拿它当「本会话最早的链路证据」
        self.attached_ms.store(super::mono::mono_ms(), Ordering::Relaxed);
        *self.reported.lock().unwrap_or_else(|p| p.into_inner()) = PathKind::None;
        *self.rtt.lock().unwrap_or_else(|p| p.into_inner()) = RttAcc::default();
    }

    /// 会话收尾：交回本次走的路与网速摘要（落库/历史用）并清空。
    ///
    /// ❗ 必须在会话还没彻底凉的时候调，或者接受 `paths()` 的最后快照——
    ///   两者都能拿到值，只是前者更准（见 `path_kind::of_conn` 的注释）。
    pub fn detach(&self) -> LinkEnd {
        let path = self.path_kind().unwrap_or(PathKind::None);
        let (rtt_min, rtt_avg, rtt_max) =
            self.rtt.lock().unwrap_or_else(|p| p.into_inner()).summary();
        *self.conn.lock().unwrap_or_else(|p| p.into_inner()) = None;
        *self.last_pong_ms.lock().unwrap_or_else(|p| p.into_inner()) = 0;
        self.attached_ms.store(0, Ordering::Relaxed);
        self.last_inbound_ms.store(0, Ordering::Relaxed);
        *self.reported.lock().unwrap_or_else(|p| p.into_inner()) = PathKind::None;
        *self.rtt.lock().unwrap_or_else(|p| p.into_inner()) = RttAcc::default();
        LinkEnd {
            path,
            rtt_min,
            rtt_avg,
            rtt_max,
        }
    }

    /// 收到对端 pong。`rtt_ms` 是本次往返时延（`<= 0` 表示这不是一次测量，
    /// 见 `RttAcc::push`）。**链路活性的唯一证据**——发送侧的成功不算。
    pub fn note_pong(&self, rtt_ms: i64) {
        *self.last_pong_ms.lock().unwrap_or_else(|p| p.into_inner()) = super::mono::mono_ms();
        self.rtt
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(rtt_ms);
    }

    /// 最后一次 pong 的时刻（单调 ms，见字段注释）；0 = 本会话还没收到过。
    ///
    /// ❗ 只在**本进程内**比较（看门狗与 `mono_ms()` 同基座）。要给前端就换
    ///   [`Self::pong_age_ms`]，裸值出网即失效。
    pub fn last_pong_ms(&self) -> i64 {
        *self.last_pong_ms.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 🔴 P1-5 后续：「刚刚收到过对端的东西」——链路活性的**第二证据位**。
    ///
    /// 调用点**收口**在 `outbound::OutboundVideo::run` 一处（`read_incoming` 一成功
    /// 就刷，不分帧类型）——以后新增入站帧类型自动覆盖，不会漏。别把它散进
    /// 各帧类型的分支里（那正是「加了新类型忘了补」的经典入口）。
    ///
    /// 每帧都可能调，所以用原子而不是 Mutex；`Relaxed` 足够——这个值只参与
    /// 「谁更新」的先后比较，不需要与别的字段构成 happens-before。
    pub fn note_inbound(&self) {
        self.last_inbound_ms
            .store(super::mono::mono_ms(), Ordering::Relaxed);
    }

    /// 最后一次收到任何入站帧的时刻（单调 ms，见字段注释）；0 = 本会话还没收到过。
    /// 与 [`Self::last_pong_ms`] 同基座，**只在进程内比较**，不出网。
    pub fn last_inbound_ms(&self) -> i64 {
        self.last_inbound_ms.load(Ordering::Relaxed)
    }

    /// C3：把最后一次 pong 换算成「距今多少毫秒」——**跨基座唯一安全的投影**。
    /// 前端拿 age 用 `performance.now()` 外推，不接触两端各自的单调/墙钟基座。
    /// `None` = 本会话还没收到过任何 pong。`now_mono` 由调用方传 `mono_ms()`
    /// （假时钟纪律，便于单测）。
    pub fn pong_age_ms(&self, now_mono: i64) -> Option<i64> {
        let pong = self.last_pong_ms();
        (pong > 0).then(|| now_mono - pong)
    }

    /// 本次连接登记的时刻（单调 ms，见字段注释）；0 = 没有活动会话。见 P1-5 字段注释。
    pub fn attached_ms(&self) -> i64 {
        self.attached_ms.load(Ordering::Relaxed)
    }

    /// 当前路径档位；没有活动连接时 `None`（**不是** `PathKind::None`——
    /// 「没会话」和「有会话但一条路都没通」是两回事，前者不该显示任何路径标签）。
    pub fn path_kind(&self) -> Option<PathKind> {
        let guard = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        guard.as_ref().map(path_kind::of_conn)
    }

    /// 当前路径档位的稳定字符串（`lan` / `direct` / `relay` / 空串）。
    /// 给 `RcStatus` 直接用，省得调用方认识 `PathKind`。
    pub fn path_kind_str(&self) -> String {
        self.path_kind()
            .unwrap_or(PathKind::None)
            .as_str()
            .to_string()
    }

    /// 路径是否变了？返回 `(from, to)`，没变返回 `None`。
    ///
    /// ❗ 首次观测（`from` 仍是 `None`）**不算换路**：那是会话刚开始，
    ///   报「已切换到局域网直连」会把用户吓一跳。
    pub fn take_path_change(&self) -> Option<(PathKind, PathKind)> {
        let now = self.path_kind()?;
        let mut reported = self.reported.lock().unwrap_or_else(|p| p.into_inner());
        if now == *reported {
            return None;
        }
        let from = std::mem::replace(&mut *reported, now);
        if from == PathKind::None {
            return None;
        }
        Some((from, now))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_没有会话时没有路径也没有心跳() {
        let l = LinkState::new();
        assert_eq!(l.path_kind(), None, "无会话时不该报出任何路径档位");
        assert_eq!(l.last_pong_ms(), 0);
        assert_eq!(l.take_path_change(), None, "无会话时不该报换路");
    }

    #[test]
    fn test_收到pong才记时间_发送成功不算() {
        let l = LinkState::new();
        assert_eq!(l.last_pong_ms(), 0, "还没收到任何 pong");
        l.note_pong(20);
        assert!(l.last_pong_ms() > 0, "收到 pong 后必须留下时间戳");
    }

    #[test]
    fn test_重复note_pong只保留最近一次() {
        let l = LinkState::new();
        l.note_pong(20);
        let first = l.last_pong_ms();
        std::thread::sleep(std::time::Duration::from_millis(2));
        l.note_pong(20);
        assert!(l.last_pong_ms() >= first, "后一次必须不早于前一次");
    }

    #[test]
    fn test_pong只投影age_裸单调值与假想墙钟都不出网() {
        // 🔴 C3：pong 时间戳是进程私有单调基座；前端只能拿到 age。
        // 若哪天有人把裸 mono（或墙钟 epoch）塞进 RcStatus，跨基座比较
        // 会静默算错新鲜度——这条守卫钉住投影的形状。
        let l = LinkState::new();
        assert_eq!(l.pong_age_ms(9_999_999), None, "没见过 pong 时必须给 None");
        l.note_pong(20);
        let now = crate::rc::mono::mono_ms();
        let age = l.pong_age_ms(now).expect("收到 pong 后应有 age");
        assert!((0..5_000).contains(&age), "刚收到的 pong age 必须很小：{age}");
        // 假时钟外推：把「现在」拨后 10s，age 线性增长
        assert_eq!(l.pong_age_ms(now + 10_000), Some(age + 10_000));
        let _ = l.detach();
        assert_eq!(l.pong_age_ms(crate::rc::mono::mono_ms()), None, "detach 后回 None");
    }

    #[test]
    fn test_detach之后状态清空_不能继承上一会话的心跳() {
        let l = LinkState::new();
        l.note_pong(20);
        let _ = l.detach();
        assert_eq!(
            l.last_pong_ms(),
            0,
            "新会话不能继承上一个会话的「刚刚还有心跳」"
        );
        assert_eq!(l.path_kind(), None);
    }

    /// 🔴 P1-5 后续（2026-09-23）：入站证据是**独立**的活性位——与 pong 各记各的，
    /// 且会话边界必须清空（否则上一场的「刚刚收过东西」会给新会话续命，
    /// 同 `last_pong_ms` 那个坑）。
    #[test]
    fn test_入站证据独立于pong_且不跨会话继承() {
        let l = LinkState::new();
        assert_eq!(l.last_inbound_ms(), 0, "还没有会话时不该有入站证据");
        l.note_inbound();
        assert!(l.last_inbound_ms() > 0, "收到入站帧后必须留下时间戳");
        assert_eq!(
            l.last_pong_ms(),
            0,
            "入站帧**不是** pong——不能冒充心跳去喂 RTT 采样"
        );
        let _ = l.detach();
        assert_eq!(l.last_inbound_ms(), 0, "会话收尾必须清掉入站证据");
    }

    /// 🔴 直接复刻 v7.2.5 的误踢场景并钉住修复：pong 一条都没到（`RcFrame` 同 tag
    /// 死变体吞包的时代），但画面/控制帧一直在到 —— 会话**必须**被判为活着。
    ///
    /// `heartbeat_evidence` 正是生产代码（`outbound_heartbeat_stale`）调用的那个
    /// 函数，所以这里测的是**判据本身**，不是把逻辑复刻一遍。
    #[test]
    fn test_入站帧能顶替缺失的pong_不再误踢活会话() {
        let started = 1_000_i64;
        let now = started + 16_000; // 已越过 15s 阈值

        // 半秒前刚收到一帧 ⇒ 证据新鲜 ⇒ 不踢（v7.2.5 在这里误踢了活会话）
        let fresh = heartbeat_evidence(0, 0, now - 500);
        assert!(
            !link_stale_kick(started, fresh, now, LINK_STALE_KICK_MS),
            "有入站帧就是活着的——这正是 v7.2.5 被误踢的场景"
        );

        // 对照组：三条证据全无 ⇒ 只能从 started 起算 ⇒ 才该收口（真失联）。
        // 看门狗的本职（治半开链路）不能因为这次修复被丢掉。
        let none = heartbeat_evidence(0, 0, 0);
        assert!(
            link_stale_kick(started, none, now, LINK_STALE_KICK_MS),
            "一条证据都没有（真失联）才允许收口"
        );

        // 三源取最大：pong 陈旧但入站新鲜时取入站那个；不是"取最后写入的来源"
        assert_eq!(heartbeat_evidence(5, 0, now - 100), now - 100);
        assert_eq!(heartbeat_evidence(9, 7, 3), 9);
    }

    #[test]
    fn test_detach交回rtt摘要() {
        let l = LinkState::new();
        for rtt in [40, 20, 60] {
            l.note_pong(rtt);
        }
        let end = l.detach();
        assert_eq!(end.rtt_min, 20);
        assert_eq!(end.rtt_max, 60);
        assert_eq!(end.rtt_avg, 40, "(40+20+60)/3");
    }

    #[test]
    fn test_rtt摘要忽略非正样本() {
        let l = LinkState::new();
        l.note_pong(30);
        // 🔴 `note_rtt(0)` 是**清零复位**、不是一次测量。若把它算进来，
        //    avg 会被拽向 0，看起来像「网速突然变好」。
        l.note_pong(0);
        l.note_pong(-5);
        let end = l.detach();
        assert_eq!(end.rtt_min, 30, "非正样本不该参与 min");
        assert_eq!(end.rtt_avg, 30, "非正样本不该参与平均");
        assert_eq!(end.rtt_max, 30);
    }

    #[test]
    fn test_没采样时rtt摘要全零_前端据此不显示() {
        let l = LinkState::new();
        let end = l.detach();
        assert_eq!((end.rtt_min, end.rtt_avg, end.rtt_max), (0, 0, 0));
    }

    #[test]
    fn test_新会话的rtt摘要不继承上一会话() {
        let l = LinkState::new();
        l.note_pong(100);
        let _ = l.detach();
        // 上一程的 100 不该掺进来 ⇒ 新会话只剩 50 这一个样本
        l.note_pong(50);
        let end = l.detach();
        assert_eq!(end.rtt_avg, 50, "detach 必须清空采样累积");
    }

    // —— 🔴 P1-5：半开链路看门狗的纯判据（假时钟，不需要网络与会话）——

    const T: i64 = 1_757_000_000_000;

    #[test]
    fn test_有pong证据时按最后一次算() {
        // 会话 0s 开始，第 10s 收到 pong，此后 12s 无响应 ⇒ 距最后一次证据 12s < 15s
        assert!(!link_stale_kick(T, T + 10_000, T + 22_000, LINK_STALE_KICK_MS));
        // 再撑 3s，超过 15s ⇒ 踢
        assert!(link_stale_kick(T, T + 10_000, T + 25_001, LINK_STALE_KICK_MS));
    }

    #[test]
    fn test_阈值边界正好卡住不算失联() {
        // 严格 `>`：正好 15s 还在容忍范围内（与 should_pause 同口径）
        assert!(!link_stale_kick(T, T, T + LINK_STALE_KICK_MS, LINK_STALE_KICK_MS));
        assert!(link_stale_kick(T, T, T + LINK_STALE_KICK_MS + 1, LINK_STALE_KICK_MS));
    }

    #[test]
    fn test_还没收到任何证据时从会话开始算宽限() {
        // evidence = 0（新会话一条心跳都没收到）⇒ 锚点回落 started_ms，不能立刻踢
        assert!(!link_stale_kick(T, 0, T + 5_000, LINK_STALE_KICK_MS));
        assert!(link_stale_kick(T, 0, T + LINK_STALE_KICK_MS + 1, LINK_STALE_KICK_MS));
        // 两个都没有（拿不到数据）⇒ 宁可漏踢，交给 TTL 兜底
        assert!(!link_stale_kick(0, 0, T, LINK_STALE_KICK_MS));
    }

    #[test]
    fn test_证据早于会话开始时以会话为准_不被上一场的心跳续命() {
        // 极端但真实：link 上残留着旧会话的 pong，新会话刚开始
        assert!(link_stale_kick(T, T - 60_000, T + LINK_STALE_KICK_MS + 1, LINK_STALE_KICK_MS));
    }

    #[test]
    fn test_阈值取值本身有依据_远大于暂停阈值远小于会话ttl() {
        // 3.5s 只是「暂停推流」的软判据，15s 才是收口判据；两者不能相等，
        // 否则丢一条包就结束会话。同时必须远小于 SESSION_TTL_MS（2h），
        // 否则半开连接要挂两个小时才释放。
        assert!(LINK_STALE_KICK_MS > 3_500 * 3, "得给心跳留足重传余量");
        assert!(LINK_STALE_KICK_MS < 60_000, "半开不该挂一分钟以上");
    }
}
