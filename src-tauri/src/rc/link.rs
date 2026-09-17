//! 会话链路状态：**数据走哪条路** + **链路还活着吗**（2026-09-17 对标改造）。
//!
//! # 它答什么
//!
//! | 问题 | 来源 |
//! |---|---|
//! | 数据实际走的哪条路 | 复用 [`crate::sync::path_kind`]，从 iroh **活连接**实测 |
//! | 链路还活着吗 | 最后一次收到对端 pong 的时刻（`last_pong_ms`） |
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
use std::sync::Mutex;

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
    /// 最后一次收到对端 pong 的时刻（epoch ms）；0 = 还没收到过。
    last_pong_ms: Mutex<i64>,
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
    /// 顺带把 pong 时间戳清零：新会话不能继承上一个会话的「刚刚还有心跳」，
    /// 否则断线重连后的头几秒会谎报已连接。
    pub fn attach(&self, conn: &Connection) {
        *self.conn.lock().unwrap_or_else(|p| p.into_inner()) = Some(conn.clone());
        *self.last_pong_ms.lock().unwrap_or_else(|p| p.into_inner()) = 0;
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
        *self.last_pong_ms.lock().unwrap_or_else(|p| p.into_inner()) = super::service::now_ms();
        self.rtt
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(rtt_ms);
    }

    /// 最后一次 pong 的时刻（epoch ms）；0 = 本会话还没收到过。
    pub fn last_pong_ms(&self) -> i64 {
        *self.last_pong_ms.lock().unwrap_or_else(|p| p.into_inner())
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
    fn test_detach之后状态清空_不能继承上一会话的心跳() {
        let l = LinkState::new();
        l.note_pong(20);
        let _ = l.detach();
        assert_eq!(l.last_pong_ms(), 0, "新会话不能继承上一个会话的「刚刚还有心跳」");
        assert_eq!(l.path_kind(), None);
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
}
