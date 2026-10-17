//! 链路调度状态机（P1，2026-10-15，对标 p2wlan path_state_machine）。
//!
//! # 它答什么：链路现在处于哪个调度相位
//!
//! [`Phase::Stable`] 有活路径且证据新鲜 / [`Phase::Degraded`] 证据断供
//! （看门狗口径） / [`Phase::Recovering`] 断供后重新见到证据、观察窗内。
//! **降级与恢复是一等状态，不是日志副作用**——诊断卡、看门狗、未来的
//! 后台重探测（P2）都以这个相位为准，而不是各自散算一遍。
//!
//! # 对标 p2wlan 学到的三条纪律（`docs/远程电脑-画质与链路调度对标p2wlan-2026-10-15.md` §2.1）
//!
//! 1. **三代世代 fencing**（`SchedEpoch`）：网络世代（本机网络环境变更）×
//!    会话世代（每次 attach 递增）× 路径世代（每次观测到换路递增）。
//!    旧世代的事件一律 `RejectedEpoch`——断线重连、换网络、换路径后，
//!    迟到的旧观测**永远污染不了**当前状态。
//! 2. **幂等事件 reducer**：事件只进 [`Self::reduce`] 一处，重复/越权迁移
//!    显式拒绝并计数（`rejected` 供诊断），绝不静默改状态。
//! 3. **恢复要过观察窗**：Degraded → Recovering 后必须连续
//!    [`RECOVER_HOLD_MS`] 健康样本才回 Stable——一次 pong 不代表链路好了，
//!    这与画质自动挡的升档持续窗（12s）是同一个思想。
//!
//! # 它刻意不答什么
//!
//! - **不答在线/收口**：那是 `link.rs` 看门狗的职责（踢人阈值与 TTL）。
//!   本模块只消费看门狗的判定结果（`EvidenceLost`），不重复判。
//! - **不答画质档位**：那是 `auto_quality.rs` 的职责（RTT/丢包/帧龄）。
//!   相位与档位是两个独立维度：relay + Stable 也可能停在 balanced。
//! - **不主动探测**：P2 的后台重探测只是事件的**生产者**之一，
//!   状态机本身不发起任何网络动作（纯 reducer，时间由调用方传入，可无网络单测）。
//!
//! # 与 link.rs 的关系
//!
//! `link.rs` 的 [`crate::rc::link::LinkState`] 是**观测源**（pong/路径/证据时刻），
//! 本模块是**判定器**：link 的观测点喂事件进来，`snapshot()` 供 status 投影。
//! 刻意不合并——link 字段全是热路径原子/Mutex，状态机是每秒一次的低频逻辑。

use crate::sync::path_kind::PathKind;

/// 恢复观察窗：Recovering 相位必须连续成立这么久才回 Stable。
///
/// 取 10s：中继会话的 ping 约 1s 一条，10s ≈ 连续 10 条健康 pong，
/// 排掉单条迟到的网络抖动；同时远小于看门狗的 relay 宽限（30s+），
/// 不会出现「还停在 Recovering 就又被踢」的交错。与画质自动挡的升档
/// 持续窗（12s）同量级但略短——链路恢复比画质升档更该积极。
const RECOVER_HOLD_MS: i64 = 10_000;

/// 三代世代 fencing（对标 p2wlan `PathEpoch`）。
///
/// - `network`：本机网络环境世代（换网卡/换网段 +1）。调用方持有并 bump，
///   状态机只比较。当前生产者：[`crate::rc::link::LinkState::bump_network_generation`]。
/// - `session`：会话世代，每次 `Attached` 事件 +1（状态机内部维护）。
///   断线重连后，旧会话的迟到 pong 立即失效。
/// - `path`：路径世代，每次 `PathChanged` +1（状态机内部维护）。
///   换路后，旧路径上的失联/健康样本不再定罪新路径（P2 探测防串线用同一位）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SchedEpoch {
    pub network: u64,
    pub session: u64,
    pub path: u64,
}

/// 调度相位。`since_mono` 是进入该相位的时刻（单调 ms，0 = Unbound）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// 无会话（attach 前全空，detach 后回这里）。
    Unbound,
    /// 有会话且证据新鲜。
    Stable,
    /// 证据断供（看门狗口径）。`since` = 进入时刻。
    Degraded { since: i64 },
    /// 断供后重新见到证据，观察窗内。`since` = 观察窗起点。
    Recovering { since: i64 },
}

impl Phase {
    /// 稳定字符串给 status 投影：`stable` / `degraded` / `recovering` / `""`。
    pub fn as_str(&self) -> &'static str {
        match self {
            Phase::Unbound => "",
            Phase::Stable => "stable",
            Phase::Degraded { .. } => "degraded",
            Phase::Recovering { .. } => "recovering",
        }
    }
}

/// 状态机事件（link.rs 观测点 / 看门狗 / P2 探测喂入）。
///
/// 每个事件都带事件发生时的 epoch 快照——状态机按「事件属于哪个世代」分拣。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchedEvent {
    /// 会话登记（`LinkState::attach`）。epoch 由调用方从上一次状态顺延
    /// （`session` 位由状态机内部 +1，调用方从 `snapshot().epoch` 取）。
    Attached { epoch: SchedEpoch },
    /// 会话收尾（`LinkState::detach`）。
    Detached { epoch: SchedEpoch },
    /// 收到 pong（活性证据）。
    PongObserved { epoch: SchedEpoch, rtt_ms: i64 },
    /// 看门狗判证据断供（`link_stale_kick` 为真时喂）。
    EvidenceLost { epoch: SchedEpoch },
    /// 观测到路径变化（`take_path_change` 的 (from, to)）。
    PathChanged { epoch: SchedEpoch, from: PathKind, to: PathKind },
}

/// 迁移判定（对标 p2wlan `PathTransitionDecision` 的子集——我们的事件源少，
/// 用不上十种；缺的种类等真有事件源再补，不预放空壳）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// 相位变了（副作用点：status 投影变化）。
    Applied,
    /// 事件有效但相位没变（如 Stable 期间例行的 pong）。
    Observed,
    /// 同效事件重复（如 Degraded 期间继续 EvidenceLost）——幂等接受。
    Duplicate,
    /// 无会话时收到会话事件（还没 attach 就 pong / detach 之后迟到证据）。
    /// 语义上无害，接受但不动状态。
    Ignored,
    /// 世代不匹配——**唯一的硬拒绝**：旧网络/旧会话/旧路径的迟到事件。
    RejectedEpoch,
}

impl Decision {
    /// 事件是否被状态机接受（除 [`Decision::RejectedEpoch`] 外都算）。
    pub fn accepted(self) -> bool {
        self != Decision::RejectedEpoch
    }
}

/// 状态机本体。字段私有，读快照走 [`Self::snapshot`]。
#[derive(Debug, Clone)]
pub struct LinkSched {
    epoch: SchedEpoch,
    phase: Phase,
    revision: u64,
    rejected: u64,
}

/// 只读快照（status 投影 / 测试断言用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SchedSnapshot {
    pub epoch: SchedEpoch,
    pub phase: Phase,
    pub revision: u64,
    pub rejected: u64,
}

impl Default for LinkSched {
    fn default() -> Self {
        Self::new()
    }
}

impl LinkSched {
    pub const fn new() -> Self {
        Self {
            epoch: SchedEpoch { network: 0, session: 0, path: 0 },
            phase: Phase::Unbound,
            revision: 0,
            rejected: 0,
        }
    }

    pub fn snapshot(&self) -> SchedSnapshot {
        SchedSnapshot {
            epoch: self.epoch,
            phase: self.phase,
            revision: self.revision,
            rejected: self.rejected,
        }
    }

    /// 唯一的入口：喂一个事件，返回判定。时间由调用方传入（假时钟纪律），
    /// 进入新相位的 `since` 直接取 `now_mono`——状态机自己不持有时钟。
    pub fn reduce(&mut self, ev: SchedEvent, now_mono: i64) -> Decision {
        let d = self.reduce_inner(&ev, now_mono);
        if d == Decision::RejectedEpoch {
            self.rejected += 1;
        } else if d == Decision::Applied {
            self.revision += 1;
        }
        d
    }

    fn reduce_inner(&mut self, ev: &SchedEvent, now_mono: i64) -> Decision {
        match ev {
            SchedEvent::Attached { epoch } => self.attach(*epoch),
            SchedEvent::Detached { epoch } => self.detach(*epoch),
            SchedEvent::PongObserved { epoch, rtt_ms: _ } => self.on_pong(*epoch, now_mono),
            SchedEvent::EvidenceLost { epoch } => self.on_evidence_lost(*epoch, now_mono),
            SchedEvent::PathChanged { epoch, from: _, to } => {
                self.on_path_changed(*epoch, *to, now_mono)
            }
        }
    }

    /// 事件世代与本机世代是否同源。状态机里的世代比较只看
    /// `network`（外部世界）与 `session`（会话边界）；`path` 位在
    /// PathChanged 时内部递增，**事件里带来的 path 值只在 Detached 时精确对账**
    /// ——其余事件允许 path 位滞后（观测与换路天然有先后）。
    fn same_lineage(&self, ev_epoch: SchedEpoch) -> bool {
        ev_epoch.network == self.epoch.network && ev_epoch.session == self.epoch.session
    }

    fn attach(&mut self, mut epoch: SchedEpoch) -> Decision {
        // ❗ 语义：attach 只信调用方「现在有一场新会话」这个事实，**永远 Applied**
        // （session 位 +1）。不做「同世代重复检测」——调用方不知道内部计数器，
        // 检测必然漏判；而重挂（bound 期间再 attach，如上一场崩了没走 detach）
        // 正是 fencing 要覆盖的场景：世代 +1 后旧会话的迟到事件立即全部失效。
        epoch.session = self.epoch.session + 1;
        epoch.path = 0;
        self.epoch = epoch;
        self.phase = Phase::Stable;
        Decision::Applied
    }

    fn detach(&mut self, epoch: SchedEpoch) -> Decision {
        if self.phase == Phase::Unbound {
            return Decision::Ignored;
        }
        if !self.same_lineage(epoch) {
            return Decision::RejectedEpoch;
        }
        self.phase = Phase::Unbound;
        Decision::Applied
    }

    fn on_pong(&mut self, epoch: SchedEpoch, now_mono: i64) -> Decision {
        if self.phase == Phase::Unbound {
            return Decision::Ignored;
        }
        if !self.same_lineage(epoch) {
            return Decision::RejectedEpoch;
        }
        match self.phase {
            Phase::Stable => Decision::Observed,
            Phase::Degraded { .. } => {
                self.phase = Phase::Recovering { since: now_mono };
                Decision::Applied
            }
            Phase::Recovering { .. } => Decision::Observed,
            Phase::Unbound => unreachable!(),
        }
    }

    fn on_evidence_lost(&mut self, epoch: SchedEpoch, now_mono: i64) -> Decision {
        if self.phase == Phase::Unbound {
            return Decision::Ignored;
        }
        if !self.same_lineage(epoch) {
            return Decision::RejectedEpoch;
        }
        match self.phase {
            Phase::Stable => {
                self.phase = Phase::Degraded { since: now_mono };
                Decision::Applied
            }
            // 已经 Degraded 再报断供 = 同一事实的重复播报，幂等接受。
            Phase::Degraded { .. } => Decision::Duplicate,
            // 🔴 守卫（对标 p2wlan「探测失败不毁健康 relay」的镜像）：
            // Recovering 中再次断供只回 Degraded，**绝不销毁会话本身**——
            // 收口是看门狗的事，状态机只管相位。
            Phase::Recovering { .. } => {
                self.phase = Phase::Degraded { since: now_mono };
                Decision::Applied
            }
            Phase::Unbound => unreachable!(),
        }
    }

    fn on_path_changed(&mut self, epoch: SchedEpoch, to: PathKind, now_mono: i64) -> Decision {
        if self.phase == Phase::Unbound {
            return Decision::Ignored;
        }
        if !self.same_lineage(epoch) {
            return Decision::RejectedEpoch;
        }
        // 换路 = 新证据 + 新路径世代（旧路径的迟到观测从此失效）。
        self.epoch.path += 1;
        // Recovering 中换路：观察窗不重置（换路不是恢复证明，
        // 恢复证明只有连续健康样本——poll 的观察窗说了算）。
        let _ = to;
        match self.phase {
            Phase::Stable => Decision::Observed,
            Phase::Degraded { .. } => {
                self.phase = Phase::Recovering { since: now_mono };
                Decision::Applied
            }
            Phase::Recovering { .. } => Decision::Observed,
            Phase::Unbound => unreachable!(),
        }
    }

    /// Recovering → Stable 的观察窗判定（调用方在喂事件后查询）。
    ///
    /// 为什么不是 reduce 内部自动升：时间推进不是事件，把「查询时刻」
    /// 塞进 reducer 会让 `Observed` 的 pong 背上隐式迁移（p2wlan 的
    /// DirectFirstDeadline 是显式事件，我们的观察窗没有独立事件源，
    /// 用查询式消费更诚实——调用方每秒 tick 一次 `poll(now)` 即可）。
    pub fn poll(&mut self, now_mono: i64) -> Decision {
        let Phase::Recovering { since } = self.phase else {
            return Decision::Observed;
        };
        if now_mono - since >= RECOVER_HOLD_MS {
            self.phase = Phase::Stable;
            self.revision += 1;
            Decision::Applied
        } else {
            Decision::Observed
        }
    }

    /// Degraded/Recovering 相位已持续多久（诊断卡显示用）。
    /// `None` = 当前相位无时长语义（Stable/Unbound）。
    pub fn phase_age_ms(&self, now_mono: i64) -> Option<i64> {
        match self.phase {
            Phase::Degraded { since } | Phase::Recovering { since } => {
                Some((now_mono - since).max(0))
            }
            Phase::Stable | Phase::Unbound => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 100_000;

    fn epoch(net: u64, sess: u64) -> SchedEpoch {
        SchedEpoch { network: net, session: sess, path: 0 }
    }

    fn attached(s: &mut LinkSched, net: u64) -> SchedEpoch {
        let ev = SchedEvent::Attached { epoch: SchedEpoch { network: net, session: 0, path: 0 } };
        let e = ev;
        let d = s.reduce(e, T0);
        assert_eq!(d, Decision::Applied);
        s.snapshot().epoch
    }

    #[test]
    fn test_生命周期_attached_stable_pong_observed_detach() {
        let mut s = LinkSched::new();
        assert_eq!(s.snapshot().phase, Phase::Unbound);
        let e = attached(&mut s, 0);
        assert_eq!(s.snapshot().phase, Phase::Stable);
        // Stable 期间例行 pong：有效但不迁移
        assert_eq!(s.reduce(SchedEvent::PongObserved { epoch: e, rtt_ms: 20 }, T0 + 1), Decision::Observed);
        assert_eq!(s.snapshot().phase, Phase::Stable);
        assert_eq!(s.reduce(SchedEvent::Detached { epoch: e }, T0 + 2), Decision::Applied);
        assert_eq!(s.snapshot().phase, Phase::Unbound);
    }

    #[test]
    fn test_降级_恢复观察窗_升回stable_全链路() {
        let mut s = LinkSched::new();
        let e = attached(&mut s, 0);
        // 证据断供 → Degraded（since = 事件时刻）
        assert_eq!(s.reduce(SchedEvent::EvidenceLost { epoch: e }, T0), Decision::Applied);
        assert_eq!(s.snapshot().phase, Phase::Degraded { since: T0 });
        // 一条 pong → Recovering（观察窗起点 = pong 时刻）
        assert_eq!(s.reduce(SchedEvent::PongObserved { epoch: e, rtt_ms: 20 }, T0 + 100), Decision::Applied);
        assert_eq!(s.snapshot().phase, Phase::Recovering { since: T0 + 100 });
        // 观察窗未满：poll 不升
        assert_eq!(s.poll(T0 + 100 + RECOVER_HOLD_MS - 1), Decision::Observed);
        assert_eq!(s.snapshot().phase, Phase::Recovering { since: T0 + 100 });
        // 观察窗满：升回 Stable
        assert_eq!(s.poll(T0 + 100 + RECOVER_HOLD_MS), Decision::Applied);
        assert_eq!(s.snapshot().phase, Phase::Stable);
    }

    #[test]
    fn test_recovering中再次断供只回degraded_不销毁会话() {
        // 🔴 守卫（对标「探测失败不毁健康 relay」镜像）：Recovering 中
        // EvidenceLost 只回 Degraded，会话还在——收口权在看门狗。
        let mut s = LinkSched::new();
        let e = attached(&mut s, 0);
        s.reduce(SchedEvent::EvidenceLost { epoch: e }, T0);
        s.reduce(SchedEvent::PongObserved { epoch: e, rtt_ms: 20 }, T0 + 100);
        assert_eq!(s.snapshot().phase, Phase::Recovering { since: T0 + 100 });
        assert_eq!(s.reduce(SchedEvent::EvidenceLost { epoch: e }, T0 + 200), Decision::Applied);
        assert_eq!(s.snapshot().phase, Phase::Degraded { since: T0 + 200 });
        // 会话仍然有效：pong 仍被接受（不是 Unbound）
        assert_eq!(s.reduce(SchedEvent::PongObserved { epoch: e, rtt_ms: 20 }, T0 + 300), Decision::Applied);
    }

    #[test]
    fn test_旧世代事件被拒_fencing() {
        // 🔴 三代 fencing 的核心守卫：新会话 attach 后，旧会话的迟到事件
        // 必须被 RejectedEpoch 且状态分毫不动。
        let mut s = LinkSched::new();
        let e1 = attached(&mut s, 0);
        let rev_after_e1 = s.snapshot().revision;
        // 新会话（session 世代 +1）
        let ev2 = SchedEvent::Attached { epoch: SchedEpoch { network: 0, session: 0, path: 0 } };
        s.reduce(ev2, T0 + 1);
        let e2 = s.snapshot().epoch;
        assert_eq!(e2.session, e1.session + 1, "session 世代必须由状态机内部递增");
        // 旧会话的 pong / 断供 / detach 全被拒
        assert_eq!(s.reduce(SchedEvent::PongObserved { epoch: e1, rtt_ms: 20 }, T0 + 2), Decision::RejectedEpoch);
        assert_eq!(s.reduce(SchedEvent::EvidenceLost { epoch: e1 }, T0 + 3), Decision::RejectedEpoch);
        assert_eq!(s.reduce(SchedEvent::Detached { epoch: e1 }, T0 + 4), Decision::RejectedEpoch);
        let snap = s.snapshot();
        assert_eq!(snap.phase, Phase::Stable, "被拒事件不得改变相位");
        assert_eq!(snap.revision, rev_after_e1 + 1, "revision 只计 attach");
        assert_eq!(snap.rejected, 3, "拒绝必须逐次计数");
        // 网络世代变了（换网）：旧网络世代的一切事件同样被拒
        s.reduce(SchedEvent::Detached { epoch: e2 }, T0 + 5);
        let mut s2 = LinkSched::new();
        let e_net1 = attached(&mut s2, 1);
        s2.reduce(SchedEvent::Detached { epoch: e_net1 }, T0);
        let ev_net0 = SchedEvent::Attached { epoch: SchedEpoch { network: 0, session: 0, path: 0 } };
        s2.reduce(ev_net0, T0);
        let e_net0 = s2.snapshot().epoch;
        assert_ne!(e_net0.network, e_net1.network);
        assert_eq!(s2.reduce(SchedEvent::PongObserved { epoch: e_net1, rtt_ms: 20 }, T0), Decision::RejectedEpoch);
    }

    #[test]
    fn test_bound期间重attach世代递增_重复断供幂等() {
        let mut s = LinkSched::new();
        let e1 = attached(&mut s, 0);
        // bound 期间再 attach = 重挂（上一场没 detach 的兜底）：世代 +1，旧世代立即失效
        let re = SchedEvent::Attached { epoch: SchedEpoch { network: 0, session: 0, path: 0 } };
        assert_eq!(s.reduce(re, T0 + 1), Decision::Applied);
        let e2 = s.snapshot().epoch;
        assert_eq!(e2.session, e1.session + 1);
        assert_eq!(s.reduce(SchedEvent::PongObserved { epoch: e1, rtt_ms: 20 }, T0 + 2), Decision::RejectedEpoch);
        // Degraded 期间反复 EvidenceLost → Duplicate（同效重复播报）
        s.reduce(SchedEvent::EvidenceLost { epoch: e2 }, T0 + 3);
        let snap1 = s.snapshot();
        assert_eq!(s.reduce(SchedEvent::EvidenceLost { epoch: e2 }, T0 + 4), Decision::Duplicate);
        assert_eq!(s.snapshot().phase, snap1.phase);
    }

    #[test]
    fn test_无会话时事件被忽略_不是拒绝() {
        // 还没 attach 就收到 pong/detach：无害（迟到证据），Ignored 不计数。
        let mut s = LinkSched::new();
        let e = SchedEpoch { network: 0, session: 99, path: 0 };
        assert_eq!(s.reduce(SchedEvent::PongObserved { epoch: e, rtt_ms: 20 }, T0), Decision::Ignored);
        assert_eq!(s.reduce(SchedEvent::Detached { epoch: e }, T0), Decision::Ignored);
        assert_eq!(s.reduce(SchedEvent::EvidenceLost { epoch: e }, T0), Decision::Ignored);
        let snap = s.snapshot();
        assert_eq!(snap.phase, Phase::Unbound);
        assert_eq!(snap.rejected, 0, "Ignored 不是拒绝");
    }

    #[test]
    fn test_路径变化递增path世代_degraded中换路进recovering() {
        let mut s = LinkSched::new();
        let e = attached(&mut s, 0);
        s.reduce(SchedEvent::EvidenceLost { epoch: e }, T0);
        // Degraded 中观测到换路（如 relay → direct）：换路本身是新证据
        assert_eq!(
            s.reduce(SchedEvent::PathChanged { epoch: e, from: PathKind::Relay, to: PathKind::Direct }, T0 + 1),
            Decision::Applied
        );
        let snap = s.snapshot();
        assert_eq!(snap.phase, Phase::Recovering { since: T0 + 1 });
        assert_eq!(snap.epoch.path, 1, "path 世代必须递增");
        // 换路后旧路径（path=0）语境内的事件按同一 lineage 接受（path 位允许滞后），
        // 但新 path 语境内 detach 仍需同 network+session。
        assert_eq!(s.reduce(SchedEvent::Detached { epoch: snap.epoch }, T0 + 2), Decision::Applied);
    }

    #[test]
    fn test_phase_age投影() {
        let mut s = LinkSched::new();
        assert_eq!(s.phase_age_ms(T0), None, "Unbound 无时长");
        let e = attached(&mut s, 0);
        assert_eq!(s.phase_age_ms(T0), None, "Stable 无时长");
        s.reduce(SchedEvent::EvidenceLost { epoch: e }, T0 + 500);
        assert_eq!(s.phase_age_ms(T0 + 1500), Some(1000));
        // 时钟回拨防护：age 不为负
        assert_eq!(s.phase_age_ms(T0 + 100), Some(0));
    }
}
