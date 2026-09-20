//! 剪贴板同步的状态 + 「跨会话串扰」不变量（C8(b)）。
//!
//! 从对端拉剪贴板是**异步等回包**的：发 `ClipboardPull` 之后要轮询回包到没到。
//! 这里有两处必须同时管住，否则会「串剪贴板」：
//!
//! 1. 并发 pull 共用一个序号 —— 先到的回包会让两个等待都返回，后一个只能拿到
//!    空值。用 `pull_lock` 串行化。
//! 2. 上一个会话迟到的回包会把序号顶上去，让本次 pull 误判成「自己要的数据到了」，
//!    于是把**上个会话**的剪贴板内容当成本次结果返回。用 `epoch` 认代：代变了就
//!    直接作废本次等待。
//!
//! 字段、`ClipWait` 决策、作废入口三者必须**同时**正确，所以收在这一个文件里。
//! 它们原先散在 `service.rs` 的三条路径上（等待循环 / 接收循环写入 / 会话收口作废），
//! 改一处漏一处就会以「偶发串内容」的形式回来——那种测试很难稳定复现的 bug。
//!
//! 编排方法 `push_clipboard` / `pull_clipboard` **留在 `RcService`**：它们要调
//! `send_input`，那依赖 `outbound_send` 与 `inner` 两个不属于本组的字段。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// `pull_clipboard` 等待循环该做什么（C8(b)）。
///
/// 抽成纯函数是为了能直接单测这个判断——它的输入只有 4 个数字，
/// 但判断错了就会「跨会话串剪贴板」，是这套代码里最容易写错、最难在
/// 集成测试里稳定复现的一处。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ClipWait {
    /// 回包到了，可以取值
    Take,
    /// 还没到，继续等
    KeepWaiting,
    /// 会话已切换，本次等待作废（宁可不给，也不给别的会话的内容）
    Abandon,
}

pub(crate) fn clip_wait_decision(
    epoch_now: u64,
    epoch_at_start: u64,
    seq_now: u64,
    seq_before: u64,
) -> ClipWait {
    if epoch_now != epoch_at_start {
        return ClipWait::Abandon;
    }
    if seq_now > seq_before {
        return ClipWait::Take;
    }
    ClipWait::KeepWaiting
}

/// 剪贴板同步的状态。字段私有，外部只能走下面这几个口子。
pub(crate) struct ClipboardState {
    /// 最近从被控端拉回的剪贴板文本。
    text: Mutex<Option<String>>,
    /// P2-5：pull 的失败原因（被控端回 `clip_err` 时写入）。推进 seq 唤醒
    /// 等待循环，`pull_clipboard` 取走后转成 Err——失败不能折叠成空串，
    /// 否则「对方剪贴板是空的」和「拉取失败」无法区分，用户只会莫名拿到空。
    pull_error: Mutex<Option<String>>,
    /// 每次写入 `text` 自增；pull 用它判断回包是否已到。
    seq: AtomicU64,
    /// 剪贴板「会话代」。会话收口时自增，用于丢掉**上一个会话**迟到的回包。
    epoch: AtomicU64,
    /// 串行化 pull：两个并发 pull 共用一个 seq 时，先到的那个回包会让两个都
    /// 认为「到了」并同时 take，其中一个只能拿到空值。
    pull_lock: tokio::sync::Mutex<()>,
}

impl ClipboardState {
    pub(crate) fn new() -> Self {
        Self {
            text: Mutex::new(None),
            pull_error: Mutex::new(None),
            seq: AtomicU64::new(0),
            epoch: AtomicU64::new(0),
            pull_lock: tokio::sync::Mutex::new(()),
        }
    }

    /// 一次 pull 的「起点」：会话代 + 当前序号。等回包期间拿这两个值判决策。
    pub(crate) fn snapshot(&self) -> (u64, u64) {
        (
            self.epoch.load(Ordering::SeqCst),
            self.seq.load(Ordering::SeqCst),
        )
    }

    /// 串行化守卫。按值返回，让调用方 `.await` 拿到后自行持有到本轮结束。
    pub(crate) async fn lock_pull(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.pull_lock.lock().await
    }

    /// 用起点值判定这一轮等待该做什么；读的是**当前**的代与序号。
    pub(crate) fn decision(&self, epoch_at_start: u64, seq_before: u64) -> ClipWait {
        clip_wait_decision(
            self.epoch.load(Ordering::SeqCst),
            epoch_at_start,
            self.seq.load(Ordering::SeqCst),
            seq_before,
        )
    }

    /// 接收循环写入对端发来的剪贴板内容（序号自增 = 「有新数据」）。
    pub(crate) fn set_from_peer(&self, t: String) {
        *self.text.lock().unwrap_or_else(|p| p.into_inner()) = Some(t);
        self.seq.fetch_add(1, Ordering::SeqCst);
    }

    /// 取出本轮拿到的内容（取走即清）。
    pub(crate) fn take(&self) -> Option<String> {
        self.text.lock().unwrap_or_else(|p| p.into_inner()).take()
    }

    /// 对端回 `clip_err` 时调用：记下失败原因并推进序号唤醒等待循环
    /// （P2-5——失败走 `take_pull_error` 转 Err，不再折叠成空串）。
    pub(crate) fn set_pull_error(&self, e: String) {
        *self.pull_error.lock().unwrap_or_else(|p| p.into_inner()) = Some(e);
        self.seq.fetch_add(1, Ordering::SeqCst);
    }

    /// 取走本轮的失败原因（有 = 本次 pull 失败）。
    pub(crate) fn take_pull_error(&self) -> Option<String> {
        self.pull_error
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
    }

    /// 会话收口时调用：作废仍在等待的 pull，并丢掉可能由迟到回包写入的文本。
    pub(crate) fn invalidate(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        *self.text.lock().unwrap_or_else(|p| p.into_inner()) = None;
        *self.pull_error.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    /// 仅供测试断言：本轮等待是否会作废。
    #[cfg(test)]
    fn epoch_now(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 收到内容后取走即清() {
        let s = ClipboardState::new();
        s.set_from_peer("来自对端".into());
        assert_eq!(s.take().as_deref(), Some("来自对端"));
        assert_eq!(s.take(), None, "取走即清，第二次应为空");
    }

    #[test]
    fn 收口会作废等待并清掉池中内容() {
        let s = ClipboardState::new();
        s.set_from_peer("上个会话的内容".into());
        let (epoch0, seq0) = s.snapshot();
        // 会话收口
        s.invalidate();
        assert_eq!(s.epoch_now(), epoch0 + 1, "收口必须推进会话代");
        assert_eq!(s.take(), None, "收口要清掉池里已有的内容");
        // 收口前发起的那一轮等待必须作废，哪怕此刻已有新回包写进来
        s.set_from_peer("收口后才到的内容".into());
        assert_eq!(
            s.decision(epoch0, seq0),
            ClipWait::Abandon,
            "代变了就不能再取"
        );
    }

    #[test]
    fn 本会话内等待到内容才算取到() {
        let s = ClipboardState::new();
        let (epoch0, seq0) = s.snapshot();
        s.set_from_peer("本次内容".into());
        assert_eq!(s.decision(epoch0, seq0), ClipWait::Take);
        assert_eq!(s.take().as_deref(), Some("本次内容"));
    }

    #[tokio::test]
    async fn 并发拉取被串行化() {
        use std::sync::Arc;
        let s = Arc::new(ClipboardState::new());
        let g = s.lock_pull().await;
        let s2 = s.clone();
        let waiter = tokio::spawn(async move {
            let _g2 = s2.lock_pull().await;
        });
        // 第二个拿不到锁：给一小段时间，它应当仍在等待
        tokio::time::sleep(std::time::Duration::from_millis(60)).await;
        assert!(!waiter.is_finished(), "第二个 pull 不该拿到锁");
        drop(g);
        tokio::time::timeout(std::time::Duration::from_secs(2), waiter)
            .await
            .expect("第一个放锁后第二个应当立刻拿到")
            .unwrap();
    }
}
