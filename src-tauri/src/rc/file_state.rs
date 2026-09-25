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
use std::collections::HashSet;
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
    /// P2-6: inbound connection peer slot (claim at accept, release when conn ends).
    /// Busy check merges peers+asks+tasks to kill the file_busy / task_start TOCTOU.
    peers: Mutex<HashSet<String>>,
    /// P1-4: in-flight `.pppart` name slots. Same part name = single writer.
    parts: Mutex<HashSet<String>>,
    seq: AtomicU64,
}

impl FileState {
    pub(crate) fn new() -> Self {
        Self {
            asks: Mutex::new(Vec::new()),
            tasks: Mutex::new(Vec::new()),
            peers: Mutex::new(HashSet::new()),
            parts: Mutex::new(HashSet::new()),
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
    ///
    /// 🔴 P3-14（2026-09-25 审计）：**终态粘滞**——已是终态（Done / Denied /
    /// Failed / Canceled）就不再改写。`file_cancel` 的
    /// `is_running → task_finish(Canceled)` 是两步操作，与传输任务自己的收口
    /// `task_finish(Done)` 竞态时，旧实现会把刚完成的 Done 覆盖成 Canceled
    /// ——「明明传完了却显示已取消」。先到的终态算数；迟到的终态是幂等
    /// 无操作（返回 `false`，不发事件——先到的那个终态早已强制上报过）。
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
        // 🔴 P3-14：与上方 task_progress 的「终态不被进度拉回」是同一条不变量的
        // 另一半——终态之间同样不许互相改写。
        if t.state.is_over() {
            return false;
        }
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

    // ── 占位（P1-4 / P2-6：busy 检查与占位必须同一临界区）────────────────

    /// Same peer busy if: reserved slot, live ask, or non-over task.
    /// Lock order: peers -> asks -> tasks (matches try_reserve_peer).
    fn peer_busy_inner(&self, peers: &HashSet<String>, peer: &str) -> bool {
        if peers.contains(peer) {
            return true;
        }
        {
            let asks = self.asks.lock().unwrap_or_else(|p| p.into_inner());
            if asks.iter().any(|a| a.peer == peer) {
                return true;
            }
        }
        let tasks = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
        tasks.iter().any(|t| t.peer == peer && !t.state.is_over())
    }

    /// Claim a peer slot at accept time (one file connection per device).
    /// false = already busy (caller rejects with busy).
    ///
    /// P2-6: the old "file_busy snapshot then task_start" was two separate
    /// locks, so two connections could both pass. Claim+check share one
    /// peers critical section; release_peer frees it when the conn ends.
    pub(crate) fn try_reserve_peer(&self, peer: &str) -> bool {
        let mut peers = self.peers.lock().unwrap_or_else(|p| p.into_inner());
        if self.peer_busy_inner(&peers, peer) {
            return false;
        }
        peers.insert(peer.to_string());
        true
    }

    pub(crate) fn release_peer(&self, peer: &str) {
        let mut peers = self.peers.lock().unwrap_or_else(|p| p.into_inner());
        peers.remove(peer);
    }

    /// Is this `.pppart` name reserved by an in-flight transfer?
    pub(crate) fn part_reserved(&self, part_name: &str) -> bool {
        let parts = self.parts.lock().unwrap_or_else(|p| p.into_inner());
        parts.contains(part_name)
    }

    /// Claim a `.pppart` name. false = already taken.
    pub(crate) fn try_reserve_part(&self, part_name: &str) -> bool {
        let mut parts = self.parts.lock().unwrap_or_else(|p| p.into_inner());
        if parts.contains(part_name) {
            return false;
        }
        parts.insert(part_name.to_string());
        true
    }

    pub(crate) fn release_part(&self, part_name: &str) {
        let mut parts = self.parts.lock().unwrap_or_else(|p| p.into_inner());
        parts.remove(part_name);
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
mod tests;
