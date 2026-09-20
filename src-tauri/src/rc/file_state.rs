//! 文件传输的跨会话状态（G6）。
//!
//! 与 `clipboard.rs` 同源的理由：**字段、判据、作废入口三者必须同时正确**，
//! 所以收在一个文件里——散在 `service.rs` / 网络层 / 命令层三条路径上，
//! 改一处漏一处会以「偶发串台」的形式回来，那种 bug 很难稳定复现。
//!
//! 与剪贴板的差别：文件通道**独立于 RC 会话**（独立 ALPN，设计稿决策 1），
//! 所以这里没有「会话代」概念，只有任务 id；连接断了由 `file_transfer.rs`
//! 显式收口。
//!
//! 本模块**不发事件、不碰网络、不碰磁盘**——只有状态与判据，全部可单测。
//! 把 io 与判据分开是为了让「超时该判多久」「进度该不该上报」这类最容易
//! 写错、又最难在真机上复现的决定能被测试直接钉住。
//! （`FileTask.path` 只是个**展示用的字符串**，上面这句仍然成立：这里不读写磁盘。）

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// 等用户响应确认条的超时（设计稿 §4.4：60s，两端都显示倒计时）。
pub(crate) const ASK_TIMEOUT_MS: i64 = 60_000;

/// 进度事件节流：最快 10Hz。
///
/// 传输按 1 MiB 分块，一秒能推几十块；不节流会把前端事件队列打满，
/// 而**画面流走的是同一个事件通道**——进度条会把视频挤卡。这是有意取舍：
/// 进度条 100ms 更新一次肉眼看不出差别。
pub(crate) const EMIT_MIN_INTERVAL_MS: i64 = 100;

/// 任务表上限。只清「已结束」的老条目，运行中的永远不清。
const MAX_TASKS: usize = 64;

/// 待响应确认条上限。正常一屏最多几条；超限只可能是对端失控狂发。
/// 超限时顶掉最老的一条（它的 outcome 变 Gone → 对应 serve 循环按
/// 「已取消」收尾），比让列表无限膨胀、确认条堆满屏幕可靠。
const MAX_ASKS: usize = 32;

/// 用户对确认条的回应。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AskReply {
    /// 推送方向 = 落盘目录；取回方向 = **要发送的文件**路径。
    Accept(PathBuf),
    Deny,
}

/// 请求的方向（由谁发起）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AskKind {
    /// 对方要把文件发给我（我要选放哪儿）。
    Push,
    /// 对方要我把文件发给他（我要选发哪个）。
    Pull,
}

/// 一条待用户响应的请求。
#[derive(Debug, Clone)]
pub(crate) struct FileAsk {
    pub(crate) id: String,
    pub(crate) peer: String,
    pub(crate) peer_name: String,
    pub(crate) kind: AskKind,
    /// 推送时是对方报的文件名；取回时为空（用户选完才知道）。
    pub(crate) name: String,
    /// 推送时是对方报的大小；取回时为 0。
    pub(crate) size: u64,
    pub(crate) first_seen_ms: i64,
    pub(crate) reply: Option<AskReply>,
}

/// 轮询循环看到的「这一轮该做什么」。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AskOutcome {
    /// 还没点（也没超时）。
    Waiting,
    Accept(PathBuf),
    Deny,
    /// 超时未响应 = 拒绝（默认拒绝，设计稿第 2 层）。
    Timeout,
    /// 请求已经不在了（被显式取消）。
    Gone,
}

/// 任务方向（本机视角）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskDir {
    /// 本机在发。
    Send,
    /// 本机在收。
    Recv,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    /// 已发头帧，等对方确认（或对方等用户响应）。
    Awaiting,
    /// 正在传字节。
    Transferring,
    Done,
    Denied,
    Failed,
    /// 本机用户/对端主动取消。
    Canceled,
}

impl TaskState {
    pub(crate) fn is_over(self) -> bool {
        matches!(
            self,
            TaskState::Done | TaskState::Denied | TaskState::Failed | TaskState::Canceled
        )
    }
}

/// 一条任务（前端列表就是它的投影）。
#[derive(Debug, Clone, Serialize)]
pub struct FileTask {
    pub(crate) id: String,
    pub(crate) peer: String,
    pub(crate) peer_name: String,
    pub(crate) dir: TaskDir,
    /// 落盘（收）/ 源（发）文件名。收侧是**净化后**的名字——UI 要显示真实落点名。
    pub(crate) name: String,
    pub(crate) size: u64,
    /// 本次传输的起始偏移（续传 > 0）。
    pub(crate) offset: u64,
    /// 已完成的绝对字节数（0..=size）。百分比 = done / size。
    pub(crate) done: u64,
    /// 本机磁盘上的**绝对路径**，只为完成态的「打开所在文件夹」服务。
    ///
    /// 收侧 = 实际落盘路径；发侧 = 源文件路径（去找原件）。
    /// 🔴 它**不参与任何判据**（进度/终态/上限都只用 `done`/`size`/`state`），
    ///    只是个展示字段——所以缺了不影响正确性，缺了就不给那个按钮。
    /// 🔴 只在本机 `rc-file-state` 事件里流动，**不出网**（对端拿到本机路径没有意义）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) path: Option<String>,
    pub(crate) state: TaskState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) err: Option<String>,
    pub(crate) started_ms: i64,
    pub(crate) updated_ms: i64,
}

/// 发给前端的完整快照。
#[derive(Debug, Clone, Serialize)]
pub struct FileSnapshot {
    pub(crate) asks: Vec<AskView>,
    pub(crate) tasks: Vec<FileTask>,
}

/// 确认条的投影（`PathBuf` 转成展示用字符串）。
#[derive(Debug, Clone, Serialize)]
pub struct AskView {
    pub(crate) id: String,
    pub(crate) peer: String,
    pub(crate) peer_name: String,
    pub(crate) kind: AskKind,
    pub(crate) name: String,
    pub(crate) size: u64,
    pub(crate) first_seen_ms: i64,
}

pub(crate) struct FileState {
    asks: Mutex<Vec<FileAsk>>,
    tasks: Mutex<Vec<FileTask>>,
    seq: AtomicU64,
}

impl FileState {
    pub(crate) fn new() -> Self {
        Self {
            asks: Mutex::new(Vec::new()),
            tasks: Mutex::new(Vec::new()),
            seq: AtomicU64::new(0),
        }
    }

    fn next_id(&self, prefix: &str, now_ms: i64) -> String {
        let n = self.seq.fetch_add(1, Ordering::SeqCst);
        format!("{}-{}-{}", prefix, now_ms, n)
    }

    // ── 待响应的请求 ───────────────────────────────────────────────────

    /// 登记一条待响应请求，返回它的 id（轮询循环按 id 取结果）。
    pub(crate) fn ask(
        &self,
        peer: &str,
        peer_name: &str,
        kind: AskKind,
        name: &str,
        size: u64,
        now_ms: i64,
    ) -> String {
        let id = self.next_id("ask", now_ms);
        let mut g = self.asks.lock().unwrap_or_else(|p| p.into_inner());
        // 并发防洪（C5）：先到先得，顶掉最老的等待者
        if g.len() >= MAX_ASKS {
            let cut = g.len() - MAX_ASKS + 1;
            log::warn!("[RC] 待响应确认条超过 {MAX_ASKS} 条，顶掉最老的 {cut} 条");
            g.drain(0..cut);
        }
        g.push(FileAsk {
            id: id.clone(),
            peer: peer.to_string(),
            peer_name: peer_name.to_string(),
            kind,
            name: name.to_string(),
            size,
            first_seen_ms: now_ms,
            reply: None,
        });
        id
    }

    /// 用户在确认条上做了选择。返回 `false` = 这条已经不在（例如已被取消）。
    ///
    /// **不覆盖已有回应**：连点两下以先到的那次为准，避免「先点拒绝又点接受」
    /// 之类的竞态把已生效的决定改掉。
    pub(crate) fn reply(&self, id: &str, r: AskReply) -> bool {
        let mut g = self.asks.lock().unwrap_or_else(|p| p.into_inner());
        match g.iter_mut().find(|a| a.id == id) {
            Some(a) if a.reply.is_none() => {
                a.reply = Some(r);
                true
            }
            _ => false,
        }
    }

    /// 轮询循环每 200ms 调一次：现在该做什么。
    pub(crate) fn outcome(&self, id: &str, now_ms: i64) -> AskOutcome {
        let g = self.asks.lock().unwrap_or_else(|p| p.into_inner());
        let Some(a) = g.iter().find(|a| a.id == id) else {
            return AskOutcome::Gone;
        };
        match a.reply.as_ref() {
            Some(AskReply::Accept(p)) => AskOutcome::Accept(p.clone()),
            Some(AskReply::Deny) => AskOutcome::Deny,
            None => {
                if ask_timed_out(a.first_seen_ms, now_ms) {
                    AskOutcome::Timeout
                } else {
                    AskOutcome::Waiting
                }
            }
        }
    }

    /// 一条请求的下场已定，从待办里摘掉（确认条随之消失）。
    pub(crate) fn drop_ask(&self, id: &str) {
        let mut g = self.asks.lock().unwrap_or_else(|p| p.into_inner());
        g.retain(|a| a.id != id);
    }

    pub(crate) fn asks(&self) -> Vec<AskView> {
        let g = self.asks.lock().unwrap_or_else(|p| p.into_inner());
        g.iter()
            .map(|a| AskView {
                id: a.id.clone(),
                peer: a.peer.clone(),
                peer_name: a.peer_name.clone(),
                kind: a.kind,
                name: a.name.clone(),
                size: a.size,
                first_seen_ms: a.first_seen_ms,
            })
            .collect()
    }

    // ── 任务 ───────────────────────────────────────────────────────────

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn task_start(
        &self,
        peer: &str,
        peer_name: &str,
        dir: TaskDir,
        name: &str,
        size: u64,
        offset: u64,
        now_ms: i64,
    ) -> String {
        let id = self.next_id("task", now_ms);
        let mut g = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
        if g.len() >= MAX_TASKS {
            // 只清已结束的：运行中的任务被清掉会让用户看到「进度条凭空消失」。
            let over: Vec<usize> = g
                .iter()
                .enumerate()
                .filter(|(_, t)| t.state.is_over())
                .map(|(i, _)| i)
                .take(g.len() - MAX_TASKS + 1)
                .collect();
            for i in over.into_iter().rev() {
                g.remove(i);
            }
        }
        g.push(FileTask {
            id: id.clone(),
            peer: peer.to_string(),
            peer_name: peer_name.to_string(),
            dir,
            name: name.to_string(),
            size,
            offset,
            done: offset,
            path: None,
            state: TaskState::Awaiting,
            err: None,
            started_ms: now_ms,
            updated_ms: now_ms,
        });
        id
    }

    /// 记下本机磁盘上的绝对路径（完成态「打开所在文件夹」用）。
    ///
    /// 返回 `false` = 任务不存在（已被上限回收）。调用方**忽略返回值即可**：
    /// 这只是个展示字段，缺了就是不给那个按钮，绝不该因此中断传输。
    ///
    /// 🔴 必须在**首次 `emit` 之前**调用，否则前端第一帧看不到路径；
    ///    之后每次 `emit` 都会带上（终态强制上报，所以最终一定能到）。
    pub(crate) fn task_note_path(&self, id: &str, path: &Path) -> bool {
        let mut g = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
        let Some(t) = g.iter_mut().find(|t| t.id == id) else {
            return false;
        };
        t.path = Some(path.to_string_lossy().to_string());
        true
    }

    /// 更新进度。返回 `true` = **该往前端发事件了**（节流后）。
    pub(crate) fn task_progress(&self, id: &str, done: u64, now_ms: i64) -> bool {
        let mut g = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
        let Some(t) = g.iter_mut().find(|t| t.id == id) else {
            return false;
        };
        // 🔴 已落终态的任务不再被动：取消（或失败）之后**还在飞的块**不能把它拉回
        //    「传输中」——那会让用户看到「点了取消，进度条又自己动起来了」。
        if t.state.is_over() {
            return false;
        }
        t.done = done.min(t.size);
        // 🔴 首次进入「传输中」必须**强制**上报：否则第一块被 100ms 窗口节流掉，
        //    UI 上就仍是「等待对方确认 / 正在等待」——用户看到的是卡住。
        let entering = t.state != TaskState::Transferring;
        t.state = TaskState::Transferring;
        if should_emit(t.updated_ms, now_ms, entering) {
            t.updated_ms = now_ms;
            true
        } else {
            false
        }
    }

    /// 落终态。返回 `true` = 该发事件（终态一律强制上报，不受节流限制）。
    pub(crate) fn task_finish(
        &self,
        id: &str,
        state: TaskState,
        err: Option<String>,
        now_ms: i64,
    ) -> bool {
        let mut g = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
        let Some(t) = g.iter_mut().find(|t| t.id == id) else {
            return false;
        };
        t.state = state;
        if state == TaskState::Done {
            t.done = t.size;
        }
        t.err = err;
        t.updated_ms = now_ms;
        true
    }

    /// 这条任务还在跑吗？（用户点取消前后台任务据此决定要不要继续推字节）
    pub(crate) fn is_running(&self, id: &str) -> bool {
        let g = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
        g.iter().any(|t| t.id == id && !t.state.is_over())
    }

    /// 单条任务的状态（测试用；命令层拿整份快照）。
    #[allow(dead_code)]
    pub(crate) fn task_state(&self, id: &str) -> Option<TaskState> {
        let g = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
        g.iter().find(|t| t.id == id).map(|t| t.state)
    }

    pub(crate) fn tasks(&self) -> Vec<FileTask> {
        let g = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
        g.clone()
    }

    /// 清掉已结束的任务（前端「清空」按钮 → 命令层）。
    pub(crate) fn clear_over(&self) {
        let mut g = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
        g.retain(|t| !t.state.is_over());
    }

    pub(crate) fn snapshot(&self) -> FileSnapshot {
        FileSnapshot {
            asks: self.asks(),
            tasks: self.tasks(),
        }
    }
}

/// 确认条超时判据（纯函数，边界可测）。
pub(crate) fn ask_timed_out(first_seen_ms: i64, now_ms: i64) -> bool {
    now_ms.saturating_sub(first_seen_ms) >= ASK_TIMEOUT_MS
}

/// 进度事件该不该发（纯函数）。
///
/// `force` 给终态与「用户刚点了按钮」用——那些必须**立刻**可见，
/// 等 100ms 节流窗口在体感上就是「点了没反应」。
pub(crate) fn should_emit(last_ms: i64, now_ms: i64, force: bool) -> bool {
    force || now_ms.saturating_sub(last_ms) >= EMIT_MIN_INTERVAL_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_000_000;

    #[test]
    fn 超时判据边界() {
        assert!(!ask_timed_out(T0, T0));
        assert!(!ask_timed_out(T0, T0 + ASK_TIMEOUT_MS - 1));
        assert!(ask_timed_out(T0, T0 + ASK_TIMEOUT_MS));
        assert!(ask_timed_out(T0, T0 + ASK_TIMEOUT_MS * 2));
        // 时钟回拨不 panic
        assert!(!ask_timed_out(T0, T0 - 5_000));
    }

    #[test]
    fn 节流判据() {
        assert!(!should_emit(T0, T0 + 50, false));
        assert!(should_emit(T0, T0 + EMIT_MIN_INTERVAL_MS, false));
        // force 无视窗口（终态与按钮反馈必须立刻可见）
        assert!(should_emit(T0, T0, true));
        // 时钟回拨不 panic
        assert!(!should_emit(T0, T0 - 1, false));
    }

    #[test]
    fn 两个并发请求互不干扰() {
        let st = FileState::new();
        let a = st.ask("peerA", "台式机", AskKind::Push, "a.zip", 100, T0);
        let b = st.ask("peerB", "笔记本", AskKind::Pull, "", 0, T0);
        assert_ne!(a, b, "id 必须唯一");
        assert_eq!(st.outcome(&a, T0), AskOutcome::Waiting);
        assert!(st.reply(&b, AskReply::Deny));
        // B 的拒绝不能影响 A
        assert_eq!(st.outcome(&a, T0), AskOutcome::Waiting);
        assert_eq!(st.outcome(&b, T0), AskOutcome::Deny);
        assert_eq!(st.asks().len(), 2, "两条都在，直到各自摘掉");
        st.drop_ask(&b);
        assert_eq!(st.outcome(&b, T0), AskOutcome::Gone);
        assert_eq!(st.asks().len(), 1);
    }

    #[test]
    fn 重复回应以先到的为准() {
        let st = FileState::new();
        let a = st.ask("p", "n", AskKind::Push, "a.bin", 1, T0);
        assert!(st.reply(&a, AskReply::Accept(PathBuf::from("D:\\收"))));
        // 第二下（拒绝）不该改写已生效的决定
        assert!(!st.reply(&a, AskReply::Deny));
        assert_eq!(
            st.outcome(&a, T0),
            AskOutcome::Accept(PathBuf::from("D:\\收"))
        );
        // 不存在的 id
        assert!(!st.reply("nope", AskReply::Deny));
    }

    #[test]
    fn 超时即拒且可被显式取消() {
        let st = FileState::new();
        let a = st.ask("p", "n", AskKind::Push, "a.bin", 1, T0);
        assert_eq!(st.outcome(&a, T0 + ASK_TIMEOUT_MS), AskOutcome::Timeout);
        st.drop_ask(&a);
        assert_eq!(st.outcome(&a, T0 + ASK_TIMEOUT_MS), AskOutcome::Gone);
    }

    #[test]
    fn 任务生命周期与进度节流() {
        let st = FileState::new();
        let id = st.task_start("p", "笔记本", TaskDir::Recv, "大文件.bin", 1_000_000, 0, T0);
        assert_eq!(st.task_state(&id).unwrap(), TaskState::Awaiting);
        // 第一块：立刻上报（上次更新时间 == 起始时间，窗口已过）
        assert!(st.task_progress(&id, 1024, T0));
        // 紧接着的第二块：被节流
        assert!(!st.task_progress(&id, 2048, T0 + 10));
        assert!(!st.task_progress(&id, 3072, T0 + 99));
        // 窗口过了才上报
        assert!(st.task_progress(&id, 4096, T0 + 100));
        assert_eq!(st.task_state(&id).unwrap(), TaskState::Transferring);
        // 终态强制上报 + 补齐 done
        assert!(st.task_finish(&id, TaskState::Done, None, T0 + 120));
        let t = &st.tasks()[0];
        assert_eq!(t.done, t.size, "完成时 done 必须补齐到 size");
        assert_eq!(t.state, TaskState::Done);
        // 进度不会超过 size（对端报大了也不能显示 >100%）
        let id2 = st.task_start("p", "n", TaskDir::Send, "x", 10, 0, T0);
        st.task_progress(&id2, 999, T0 + 200);
        assert_eq!(st.tasks().iter().find(|t| t.id == id2).unwrap().done, 10);
    }

    #[test]
    fn 终态任务不再被进度拉回来() {
        let st = FileState::new();
        let id = st.task_start("p", "n", TaskDir::Send, "a.bin", 100, 0, T0);
        assert!(st.task_progress(&id, 10, T0));
        st.task_finish(&id, TaskState::Canceled, None, T0);
        // 取消之后还在飞的块：不改变状态、不发事件
        assert!(!st.task_progress(&id, 20, T0 + 500));
        assert_eq!(st.task_state(&id).unwrap(), TaskState::Canceled);
        assert_eq!(st.tasks()[0].done, 10, "done 不能被终态后的块改写");
        // 失败态同理
        let id2 = st.task_start("p", "n", TaskDir::Recv, "b.bin", 100, 0, T0);
        st.task_finish(&id2, TaskState::Failed, Some("x".into()), T0);
        assert!(!st.task_progress(&id2, 50, T0 + 500));
        assert_eq!(st.task_state(&id2).unwrap(), TaskState::Failed);
    }

    #[test]
    fn 续传任务从偏移量起算() {
        let st = FileState::new();
        let id = st.task_start("p", "n", TaskDir::Send, "v.zip", 1000, 400, T0);
        let t = &st.tasks()[0];
        assert_eq!(t.offset, 400);
        assert_eq!(t.done, 400, "续传时已完成量从断点起算（百分比直接可用）");
        st.task_progress(&id, 500, T0 + 200);
        assert_eq!(st.tasks()[0].done, 500);
    }

    #[test]
    fn 任务表上限只清已结束的() {
        let st = FileState::new();
        // 一条运行中 + 塞满已结束
        let live = st.task_start("p", "n", TaskDir::Send, "live.bin", 10, 0, T0);
        for i in 0..MAX_TASKS {
            let id = st.task_start("p", "n", TaskDir::Send, "x", 10, 0, T0 + i as i64);
            st.task_finish(&id, TaskState::Done, None, T0 + i as i64);
        }
        // 再加一条触发清理
        st.task_start("p", "n", TaskDir::Recv, "new.bin", 10, 0, T0 + 999);
        let tasks = st.tasks();
        assert!(tasks.len() <= MAX_TASKS, "{}", tasks.len());
        assert!(
            tasks.iter().any(|t| t.id == live),
            "运行中的任务不能被清掉（否则进度条会凭空消失）"
        );
    }

    #[test]
    fn 快照投影字段齐全() {
        let st = FileState::new();
        let _ = st.ask("p1", "台式机", AskKind::Push, "报告.zip", 123, T0);
        let id = st.task_start("p1", "台式机", TaskDir::Recv, "报告.zip", 123, 0, T0);
        st.task_finish(&id, TaskState::Failed, Some("对方断开".into()), T0 + 1);
        let snap = st.snapshot();
        let v = serde_json::to_value(&snap).unwrap();
        assert_eq!(v["asks"][0]["kind"], "push");
        assert_eq!(v["asks"][0]["name"], "报告.zip");
        assert_eq!(v["asks"][0]["size"], 123);
        assert_eq!(v["tasks"][0]["dir"], "recv");
        assert_eq!(v["tasks"][0]["state"], "failed");
        assert_eq!(v["tasks"][0]["err"], "对方断开");
        assert_eq!(v["tasks"][0]["peer_name"], "台式机");
    }

    /// 完成态「打开所在文件夹」：路径**缺省不进快照**（不占位），写进去后必须带着。
    #[test]
    fn path缺省不出现在快照里_写入后带上() {
        let st = FileState::new();
        let id = st.task_start("p", "n", TaskDir::Recv, "报告.zip", 123, 0, T0);

        let v = serde_json::to_value(st.snapshot()).unwrap();
        assert!(
            v["tasks"][0].get("path").is_none(),
            "没有路径就不该出现这个键——前端靠「有没有」决定摆不摆按钮"
        );

        assert!(
            st.task_note_path(&id, Path::new(r"C:\Users\me\Downloads\报告.zip")),
            "任务在表里就该写成功"
        );
        let v = serde_json::to_value(st.snapshot()).unwrap();
        assert_eq!(
            v["tasks"][0]["path"], r"C:\Users\me\Downloads\报告.zip",
            "写入的路径必须原样进快照（Windows 反斜杠不能被打弯）"
        );
    }

    /// 任务已被上限回收时报 `false`，且**不 panic**——这只是展示字段，
    /// 缺了就不给按钮，绝不该因此中断传输。
    #[test]
    fn task_note_path对不存在的任务返回false() {
        let st = FileState::new();
        assert!(!st.task_note_path("task-不存在", Path::new(r"C:\x.bin")));
    }

    /// 路径**不参与判据**：带不带 path，进度与终态判据完全一致
    /// （免得以后有人把 path 当「已落盘」的证据去用）。
    #[test]
    fn path不参与任何判据() {
        let st = FileState::new();
        let id = st.task_start("p", "n", TaskDir::Recv, "a.bin", 100, 0, T0);
        assert!(st.task_progress(&id, 50, T0 + 200));
        st.task_note_path(&id, Path::new(r"C:\x\a.bin"));
        // 写入 path 之后再推进度：节流与状态机行为不变
        assert!(!st.task_progress(&id, 60, T0 + 210), "仍在节流窗口内");
        assert!(st.task_finish(&id, TaskState::Done, None, T0 + 300));
        assert_eq!(st.task_state(&id), Some(TaskState::Done));
    }

    #[test]
    fn 清空只清结束的() {
        let st = FileState::new();
        let live = st.task_start("p", "n", TaskDir::Send, "live", 1, 0, T0);
        let done = st.task_start("p", "n", TaskDir::Send, "done", 1, 0, T0);
        st.task_finish(&done, TaskState::Done, None, T0);
        st.clear_over();
        let tasks = st.tasks();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, live);
        // 取消判据：运行中的可以取消，已结束的不行
        assert!(st.is_running(&live));
        st.task_finish(&live, TaskState::Canceled, None, T0);
        assert!(!st.is_running(&live));
    }
}
