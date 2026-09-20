//! 文件传输的收发（G6 · B2）。
//!
//! 三层里的「网络与磁盘」层（判据在 `file_proto.rs`、状态在 `file_state.rs`）。
//!
//! 全部走独立 ALPN `rc-file/1`，**不依赖 RC 会话**——这是设计稿决策 1 的直接
//! 结果，也是「不接管屏幕也能传文件」（决策 8）天然成立的原因：发起端不需要
//! 先建会话。但门禁一样严（`enabled` + `has_remote_trust`）：**ALPN 是公开的，
//! 连得上 ≠ 有权限**。
//!
//! 两个方向共用同一对字节搬运函数（`send_bytes` / `recv_bytes`），区别只在
//! 谁先开口（决策 7 的派生纪律：不要写两条平行路径）：
//!
//! | 方向 | 发起侧 A 的 send 半流 | 接住侧 B 的 send 半流 |
//! |---|---|---|
//! | 推送 A→B | `PPFIL1` + `{push,name,size}`，然后字节 | `{accept,offset}` |
//! | 取回 B→A | `PPFIL1` + `{pull_req,resume}` | `{accept,name,size,offset}`，然后字节 |
//!
//! 🔴 **头写完必须等确认再灌字节**：不等的话对方拒绝时几 MB 已经塞进流控窗口，
//! 带宽白费，而且「拒绝」在用户看来没生效（设计稿 §4.2 纪律 1）。

use super::file_proto::{
    self, check_ack_accept, code, decode_ack, encode_ack, encode_head, final_from_part, part_path,
    safe_file_name, FileAck, FileHead, ResumeHint, MAX_FILE_BYTES, MAGIC,
};
use super::file_state::{AskKind, AskOutcome, AskReply, TaskDir, TaskState};
use super::protocol::FILE_ALPN;
use super::service::{now_ms, RcService};
use crate::sync::transport::{read_frame, write_frame};
use iroh::endpoint::{Connection, RecvStream, SendStream};
use iroh::{EndpointAddr, EndpointId};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

/// 分块 1 MiB。太小则 syscall 次数多、太大则进度条颗粒粗且取消迟钝。
const CHUNK: usize = 1024 * 1024;
/// 等对端开流。
const OPEN_STREAM_SECS: u64 = 10;
/// 等确认帧（含人工点确认条的 60s，留点网络余量）。
const ACK_WAIT_SECS: u64 = 75;
/// 传输中「没有进展」的判定。大文件慢慢传正常，卡住不动不正常。
const STALL_SECS: u64 = 30;

/// 一次字节搬运的结局。
///
/// **分档而不是塌缩成「失败」**：用户与排查都需要知道是断了、停了、还是自己取消的。
#[derive(Debug)]
enum TxOutcome {
    Done,
    Canceled,
    /// 对端 30s 没动静。
    Stalled,
    /// 对端提前关了流（数据没发完）。
    RemoteClosed,
    Io(String),
}

impl TxOutcome {
    fn finish(&self, got: u64, size: u64) -> (TaskState, Option<String>) {
        match self {
            TxOutcome::Done => (TaskState::Done, None),
            TxOutcome::Canceled => (TaskState::Canceled, None),
            TxOutcome::Stalled => (
                TaskState::Failed,
                Some(format!("传输中断：{} 秒没有数据往来", STALL_SECS)),
            ),
            TxOutcome::RemoteClosed => (
                TaskState::Failed,
                Some(format!("对端提前结束（已传 {} / {}）", got, size)),
            ),
            TxOutcome::Io(e) => (TaskState::Failed, Some(e.clone())),
        }
    }
}

/// 落点规划（重名递增 + `.pppart` + 续传偏移）。
struct RecvPlan {
    final_name: String,
    part: PathBuf,
    final_path: PathBuf,
    offset: u64,
}

impl RcService {
    // ── 发起侧 ─────────────────────────────────────────────────────────

    /// 把本机文件发给对端。**校验同步做完**（不合格的文件不该让整批卡住），
    /// 真正的传输在后台串行跑（弱网下并发文件互挤，总时长反而更长）。
    pub async fn file_send(self: &Arc<Self>, peer: &str, paths: Vec<PathBuf>) -> Result<(), String> {
        if paths.is_empty() {
            return Err("没有选中文件".into());
        }
        let mut items: Vec<(PathBuf, String, u64)> = Vec::with_capacity(paths.len());
        for p in paths {
            let meta = tokio::fs::metadata(&p)
                .await
                .map_err(|e| format!("读不到 {}：{}", p.display(), e))?;
            if !meta.is_file() {
                return Err(format!(
                    "{} 不是文件——目录传输留到后续版本",
                    p.display()
                ));
            }
            if meta.len() > MAX_FILE_BYTES {
                return Err(format!(
                    "{} 超过 {} GiB 上限",
                    p.display(),
                    MAX_FILE_BYTES / 1024 / 1024 / 1024
                ));
            }
            let raw = p
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let name = safe_file_name(&raw)
                .map_err(|e| format!("{} 的文件名不能用：{}", p.display(), e))?;
            items.push((p, name, meta.len()));
        }
        let svc = self.clone();
        let peer = peer.to_string();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = svc.run_send_batch(&peer, items).await {
                // 整条连接级的失败（连不上 / 对方版本不支持）只在这里报一次；
                // 单个文件的失败在上面的循环里各自落终态。
                log::warn!("[RC] 发送文件失败：{e}");
            }
        });
        Ok(())
    }

    /// 向对端要文件。**必须在发请求之前选好本机落点**——对方一接受就会灌字节
    /// （设计稿 11.2 的注意事项 1）。
    pub async fn file_pull(self: &Arc<Self>, peer: &str, dir: PathBuf) -> Result<(), String> {
        if !dir.is_dir() {
            return Err(format!("{} 不是目录", dir.display()));
        }
        let svc = self.clone();
        let peer = peer.to_string();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = svc.run_pull(&peer, dir).await {
                log::warn!("[RC] 取回文件失败：{e}");
            }
        });
        Ok(())
    }

    /// 用户在确认条上点了「接受」/「拒绝」。
    pub fn file_respond(&self, ask_id: &str, accept: Option<PathBuf>) -> Result<(), String> {
        let reply = match accept {
            Some(p) => AskReply::Accept(p),
            None => AskReply::Deny,
        };
        if !self.file.reply(ask_id, reply) {
            return Err("这条请求已经失效（可能已超时或已处理）".into());
        }
        self.emit_file_state();
        Ok(())
    }

    /// 取消一条进行中的任务。收侧保留 `.pppart`（下次可续），发侧直接停。
    pub fn file_cancel(&self, task_id: &str) {
        if self.file.is_running(task_id) {
            self.file.task_finish(task_id, TaskState::Canceled, None, now_ms());
            self.emit_file_state();
        }
    }

    /// 文件状态快照（前端初次挂载时取一次，之后靠 `rc-file-state` 事件）。
    ///
    /// `pub(crate)`：这条契约只服务本 crate 的命令层，不是对外 API——
    /// 事件与命令返回**共用同一个形状**（`FileSnapshot`），改了要一起改。
    /// 清掉已结束的任务（前端「清空」按钮）。
    pub fn file_clear_finished(&self) {
        self.file.clear_over();
        self.emit_file_state();
    }

    /// 文件状态快照（前端初次挂载取一次，之后靠 `rc-file-state` 事件）。
    ///
    /// 事件与命令返回**共用同一个形状**（`FileSnapshot`），改了要一起改。
    pub fn file_snapshot(&self) -> super::file_state::FileSnapshot {
        self.file.snapshot()
    }

    pub(super) fn emit_file_state(&self) {
        match serde_json::to_string(&self.file.snapshot()) {
            Ok(json) => self.notify.emit_file_state(&json),
            Err(e) => log::warn!("[RC] 文件状态序列化失败：{e}"),
        }
    }

    /// 这台设备是否已授权「自动接收文件」（设计稿决策 10）。
    ///
    /// B2 恒 `None`（行为 = 每次都问）；B5 接上设备记录：开了就直接收，
    /// 落点用系统下载目录。收成一个方法是为了让那次改动**只动这里**，
    /// 不必回头改连接处理流程——现在兑现了。
    ///
    /// 🔴 **它只跳「每个文件都问一次」，不跳门禁**。`handle_file_conn` 里的
    ///    `gate_inbound` 仍先跑：被禁用 / 未配对的设备照样进不来。这条别混。
    /// 🔴 **只对推送方向生效**（对方发给我）。取回方向是「我挑文件发给对方」，
    ///    没有可自动的东西——所以这里不需要区分方向参数。
    /// 🔴 落点固定在**系统下载目录**（`default_receive_dir`）。「记住接收目录」
    ///    是设计稿 P1 项，所以这里不加第二列、也不猜目录。
    /// 🔴 解析下载目录失败时**回落到人工确认**，不是静默失败也不是硬失败：
    ///    自动接收是便利，便利出问题就该退回安全的那条路。
    fn auto_accept_dir(&self, peer: &str) -> Option<PathBuf> {
        // 判据收口在 `service.rs::device_auto_accept`（与 `device_trusted` 同口径），
        // 不在这里手写一顿 `store.rc_device_get`——判据只有一个来源。
        if !self.device_auto_accept(peer) {
            return None;
        }
        match default_receive_dir() {
            Ok(d) => Some(d),
            Err(e) => {
                log::warn!("[RC] 该设备已允许自动接收，但下载目录解析失败，回落人工确认：{e}");
                None
            }
        }
    }

    /// 这条 peer 是否已有文件任务在跑（同一台设备同时只跑一条连接）。
    fn file_busy(&self, peer: &str) -> bool {
        let snap = self.file.snapshot();
        snap.asks.iter().any(|a| a.peer == peer)
            || snap
                .tasks
                .iter()
                .any(|t| t.peer == peer && !t.state.is_over())
    }

    /// 拨通对端的文件通道。
    async fn dial_file(&self, peer: &str) -> Result<Connection, String> {
        let Some((ep, presence)) = self.transport_ready() else {
            return Err("[channel_down] 远程通道未启动——先打开「允许被远程协助」".into());
        };
        let id =
            EndpointId::from_str(peer).map_err(|e| format!("[bad_node_id] node_id 解不开：{}", e))?;
        let mut addr = EndpointAddr::new(id);
        for sock in presence.addrs_of(peer, now_ms()) {
            addr = addr.with_ip_addr(sock);
        }
        // ❗ 失败要单独分档：旧版对端根本没有这条 ALPN，握手必然失败。
        //   塌缩成「连接失败」会让用户去查网络，而实际要做的是升级对方。
        // C-3：与 dial_and_request 同款超时——网络黑洞下后台任务不得无限挂。
        match tokio::time::timeout(Duration::from_secs(15), ep.connect(addr, FILE_ALPN)).await {
            Err(_) => Err(
                "[connect_timeout] 连接对方文件通道超时（对方可能离线或网络不可达）".into(),
            ),
            Ok(Err(e)) => Err(format!(
                "[file_unsupported] 对方没有响应文件通道（可能是不支持文件传输的旧版本）：{e}"
            )),
            Ok(Ok(c)) => Ok(c),
        }
    }

    /// 一批文件**串行**发完（一条连接，每个文件一条 bi-stream）。
    async fn run_send_batch(
        self: Arc<Self>,
        peer: &str,
        items: Vec<(PathBuf, String, u64)>,
    ) -> Result<(), String> {
        let conn = self.dial_file(peer).await?;
        let peer_name = self.peer_name(peer);
        // C-4：用索引循环，开流失败时把「当前 + 剩余」全部落 Failed task。
        let items = items;
        let n = items.len();
        for idx in 0..n {
            let (path, name, size) = items[idx].clone();
            let (mut send, mut recv) = match conn.open_bi().await {
                Ok(v) => v,
                Err(e) => {
                    let reason = format!("开流失败：{e}");
                    log::warn!(
                        "[RC] 批传第 {}/{} 个文件开流失败，剩余标记失败：{reason}",
                        idx + 1,
                        n
                    );
                    for (p, nm, sz) in &items[idx..] {
                        let tid = self.file.task_start(
                            peer,
                            &peer_name,
                            TaskDir::Send,
                            nm,
                            *sz,
                            0,
                            now_ms(),
                        );
                        self.file.task_note_path(&tid, p);
                        self.finish_file(&tid, TaskState::Failed, Some(reason.clone()), *sz);
                    }
                    break;
                }
            };

            let task_id = self.file.task_start(
                peer,
                &peer_name,
                TaskDir::Send,
                &name,
                size,
                0,
                now_ms(),
            );
            // 源文件绝对路径：完成态「打开所在文件夹」用（去找原件）。
            self.file.task_note_path(&task_id, &path);
            self.emit_file_state();

            let head = FileHead::Push {
                v: file_proto::VERSION,
                name: name.clone(),
                size,
            };
            let bytes = match encode_head(&head) {
                Ok(b) => b,
                Err(d) => {
                    self.finish_file(&task_id, TaskState::Failed, Some(d.reason), size);
                    continue;
                }
            };
            if let Err(e) = self.write_head(&mut send, &bytes).await {
                self.finish_file(&task_id, TaskState::Failed, Some(e), size);
                continue;
            }

            // ── 等对方点头，才动字节 ──
            let ack = match tokio::time::timeout(
                Duration::from_secs(ACK_WAIT_SECS),
                read_frame(&mut recv),
            )
            .await
            {
                Err(_) => {
                    self.finish_file(
                        &task_id,
                        TaskState::Failed,
                        Some("对方没有确认（可能没看到确认条）".into()),
                        size,
                    );
                    continue;
                }
                Ok(Err(e)) => {
                    self.finish_file(&task_id, TaskState::Failed, Some(e), size);
                    continue;
                }
                Ok(Ok(raw)) => match decode_ack(&raw) {
                    Ok(a) => a,
                    Err(e) => {
                        self.finish_file(&task_id, TaskState::Failed, Some(e), size);
                        continue;
                    }
                },
            };
            let offset = match ack {
                FileAck::Deny { reason, code } => {
                    let msg = match code.as_deref() {
                        Some(c) => format!("[{c}] {reason}"),
                        None => reason,
                    };
                    self.finish_file(&task_id, TaskState::Denied, Some(msg), size);
                    continue;
                }
                FileAck::Accept { offset, .. } => offset.min(size),
            };

            let (outcome, sent) =
                send_bytes(&self, &mut send, &path, size, offset, &task_id).await;
            let (state, err) = outcome.finish(sent, size);
            if state == TaskState::Done {
                log::info!("[RC] 已发送 {}（{} 字节）", name, size);
            } else {
                log::warn!("[RC] 发送 {name} 未完成：{state:?} {err:?}");
            }
            self.finish_file(&task_id, state, err, size);
        }
        conn.close(0u32.into(), b"done");
        Ok(())
    }

    /// 向对方要一个文件，落到 `dir`。
    async fn run_pull(self: Arc<Self>, peer: &str, dir: PathBuf) -> Result<(), String> {
        let conn = self.dial_file(peer).await?;
        let (mut send, mut recv) = conn
            .open_bi()
            .await
            .map_err(|e| format!("开流失败：{}", e))?;

        // 本机已有的未完成文件（名字 + 已收量）——**取回方向的关键**：
        // 数据由对方发，它不知道我们收了多少，不给提示就只能整包重来。
        let head = FileHead::PullReq {
            v: file_proto::VERSION,
            resume: resume_hints(&dir),
        };
        let bytes = encode_head(&head).map_err(|d| d.reason)?;
        self.write_head(&mut send, &bytes).await?;

        // 对方要先选文件（人工），超时给足
        let raw = match tokio::time::timeout(Duration::from_secs(ACK_WAIT_SECS), read_frame(&mut recv))
            .await
        {
            Err(_) => return Err("对方没有响应（可能没看到确认条）".into()),
            Ok(r) => r?,
        };
        let ack = decode_ack(&raw)?;
        let (name, size, offset) = match ack {
            FileAck::Deny { reason, code } => {
                return Err(match code.as_deref() {
                    Some(c) => format!("[{c}] {reason}"),
                    None => reason,
                })
            }
            FileAck::Accept { name, size, offset } => {
                // 名字与大小由**对端**给，落盘前必须过同一套判据（这是最容易被
                // 忽略的入口：推送方向的校验发生在收头帧时，取回方向在这里）
                let (n, s) = check_ack_accept(name.as_deref(), size).map_err(|d| d.reason)?;
                (n, s, offset.min(s))
            }
        };

        let peer_name = self.peer_name(peer);
        // 对方报的断点要与本机 part 的实际长度对得上，否则从头来——
        // 不信任对端报的数字胜过不信任自己的盘。
        let plan = prepare_recv(&dir, &name, size)?;
        let offset = if plan.offset == offset { offset } else { 0 };
        // 🔴 P1-4：回落 0 就绝不能留着旧 part——`recv_bytes` 以 append 打开，
        // 旧残余 + 全量新数据拼出来的是损坏文件，且收满即 rename 成 Done。
        // （命中场景：hints 被截掉 / 幻影 hint 对上了别的 part。）
        if offset == 0 && plan.offset > 0 {
            let _ = tokio::fs::remove_file(&plan.part).await;
            log::info!("[RC] 续传偏移对不上，已丢弃旧 part 从头接收：{}", plan.final_name);
        }

        let task_id = self
            .file
            .task_start(peer, &peer_name, TaskDir::Recv, &plan.final_name, size, offset, now_ms());
        // 实际落盘路径（收侧）：给前端展示的用**原始**路径——`plan.final_path`
        // 可能带 `\\?\` 长路径前缀（C6），explorer 打开不认那个形态。
        self.file.task_note_path(&task_id, &dir.join(&plan.final_name));
        self.emit_file_state();
        let plan = RecvPlan {
            offset,
            ..plan
        };

        let (outcome, got) = recv_bytes(&self, &mut recv, &plan, size, &task_id).await;
        let (state, err) = outcome.finish(got, size);
        self.finish_file(&task_id, state, err, size);
        conn.close(0u32.into(), b"done");
        Ok(())
    }

    // ── 接住侧（被控端 / 被请求方）─────────────────────────────────────

    /// 处理一条入站的 `rc-file/1` 连接。
    pub async fn handle_file_conn(self: &Arc<Self>, conn: Connection) {
        let peer = conn.remote_id().to_string();
        let short = peer[..8.min(peer.len())].to_string();

        // ── 门禁 ──
        // 复用会话入站那套**纯函数**判据（`rc/session::gate_inbound`），而不是在这里
        // 手写几个 if：两处各写一遍「谁被允许进来」，迟早有一条路漏掉某个判据。
        //
        // 文件通道的门禁与会话的差异只有两处，都体现在实参上：
        //   · **不要 Capability** —— 文件只需要「这台设备可信」，不关心能不能操作键鼠，
        //     所以按最低档 `View` 申请（`max_capability()` 收紧到 View 时同样放行）；
        //   · **不占会话位** —— `has_session` 恒 false，文件与会话互不排斥（决策 8）。
        //
        // 🔴 「单独禁止这台设备」必须在这里生效。它的语义是「这台设备从我这儿拿不到
        //    任何东西」——只挡画面却放它往我的磁盘写文件，等于没禁止。B2 初版漏了这条，
        //    B4 补上（`Gate::DeviceDenied` 是 gate_inbound 的既定分支，天然就能用）。
        // B-b：文件通道**只认 rc_devices**。同步配对设备必须先经会话批准
        // elevate（approve_inbound）或设备菜单允许，才获得文件准入——
        // 「只同步笔记」不应自动可写磁盘。
        let rc_paired = self.is_rc_paired(&peer);
        let gate = super::session::gate_inbound(
            self.enabled(),
            self.max_capability(),
            &self.device_deny(),
            &peer,
            rc_paired,
            super::protocol::Capability::View,
            false,
        );
        if gate != super::session::Gate::Allow {
            // 数值码只做粗分类（沿用本文件既有约定），细因在 reason 字节串里
            let code: u32 = match gate {
                super::session::Gate::DeviceDenied => 4,
                super::session::Gate::NotPaired if self.has_remote_trust(&peer) => 3,
                _ => 1,
            };
            conn.close(code.into(), gate.deny_code().as_bytes());
            if gate == super::session::Gate::NotPaired && self.has_remote_trust(&peer) {
                log::info!(
                    "[RC] {short} 文件连接被拒：仅笔记同步配对，尚未获得远程/文件权限"
                );
            } else {
                log::info!("[RC] {short} 文件连接被拒：{}", gate.deny_reason());
            }
            return;
        }
        if self.file_busy(&peer) {
            conn.close(2u32.into(), b"busy");
            log::info!("[RC] {short} 文件连接被拒：这条设备已有文件任务在跑");
            return;
        }

        // ── 流循环（P1-3 修复）──
        // 一条连接承载**一批**文件：发送端 `run_send_batch` 每个文件开一条
        // bi-stream；这里循环 accept，传完一条接下一条，连接由**发送端**收尾
        // （close/drop → accept_bi 报错 → 本循环退出）。原先接收端传完第一个
        // 文件就 `conn.close`，多文件批次从第 2 个起必然失败且 UI 无痕迹
        // （静默数据丢失）。
        loop {
            // 等对端开流（带超时：连上却不开流不能把这条连接永远吊着）
            let Ok(Ok((mut send, mut recv))) =
                tokio::time::timeout(Duration::from_secs(OPEN_STREAM_SECS), conn.accept_bi()).await
            else {
                log::info!("[RC] {short} 文件连接结束（对端收尾或未再开流）");
                conn.close(0u32.into(), b"done");
                return;
            };

            // ── 魔数 + 头帧 ──
            let mut magic = [0u8; 6];
            if recv_exact(&mut recv, &mut magic).await.is_err() || !file_proto::is_magic(&magic) {
                deny_file(&mut send, &conn, "不是文件流", code::BAD_HEAD).await;
                log::warn!("[RC] {short} 文件流魔数不对");
                return;
            }
            let raw = match read_frame(&mut recv).await {
                Ok(b) => b,
                Err(e) => {
                    log::warn!("[RC] {short} 读文件头失败：{e}");
                    return;
                }
            };
            let head = match file_proto::decode_head(&raw) {
                Ok(h) => h,
                Err(d) => {
                    deny_file(&mut send, &conn, &d.reason, d.code).await;
                    log::info!("[RC] {short} 文件头被拒：{}", d.reason);
                    return;
                }
            };

            match head {
                FileHead::Push { name, size, .. } => {
                    self.serve_push(&conn, &peer, &short, &name, size, send, recv)
                        .await
                }
                FileHead::PullReq { resume, .. } => {
                    // 取回是「一次一个文件」的会话式动作，发端收尾即整条连接结束
                    self.serve_pull(&conn, &peer, &short, &resume, send, recv)
                        .await;
                    return;
                }
            }
        }
    }

    /// 对方要发文件给我：先问人，再落盘。
    #[allow(clippy::too_many_arguments)]
    async fn serve_push(
        self: &Arc<Self>,
        conn: &Connection,
        peer: &str,
        short: &str,
        name: &str,
        size: u64,
        mut send: SendStream,
        mut recv: RecvStream,
    ) {
        let peer_name = self.peer_name(peer);

        // 先看这台设备是否已被授权自动接收（决策 10）；默认没有，走人工确认。
        let dir = match self.auto_accept_dir(peer) {
            Some(d) => d,
            None => {
                // 落点由用户在确认条上选（默认值由前端调 `rc_file_default_dir` 取），
                // 这里**不猜**目录：猜错就是往一个莫名其妙的地方写文件。
                let ask_id =
                    self.file
                        .ask(peer, &peer_name, AskKind::Push, name, size, now_ms());
                self.emit_file_state();
                let picked = loop {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    match self.file.outcome(&ask_id, now_ms()) {
                        AskOutcome::Waiting => continue,
                        AskOutcome::Accept(d) => break Some(d),
                        AskOutcome::Deny => break None,
                        AskOutcome::Timeout => {
                            log::info!("[RC] {short} 文件确认超时，按拒绝处理");
                            break None;
                        }
                        AskOutcome::Gone => {
                            // C-5：MAX_ASKS 顶掉最老 ask 时 outcome=Gone。
                            // 关整条连接会把同批后续文件全灭——只拒这一条。
                            deny_file(&mut send, conn, "确认条已失效（请让对方重试）", code::DENIED)
                                .await;
                            log::info!("[RC] {short} 文件确认条已失效，本条拒绝：{name}");
                            return;
                        }
                    }
                };
                self.file.drop_ask(&ask_id);
                self.emit_file_state();
                match picked {
                    Some(d) => d,
                    None => {
                        deny_file(&mut send, conn, "对方拒绝了这次传输", code::DENIED).await;
                        log::info!("[RC] {short} 本机用户拒收文件：{name}");
                        return;
                    }
                }
            }
        };

        // ── 落点（重名递增 + 续传）──
        let plan = match prepare_recv(&dir, name, size) {
            Ok(p) => p,
            Err(e) => {
                deny_file(&mut send, conn, &e, code::LOCAL).await;
                log::warn!("[RC] {short} 无法落盘：{e}");
                return;
            }
        };
        // 回确认：**此刻才允许对方开始灌字节**
        let ack = FileAck::Accept {
            name: None,
            size: None,
            offset: plan.offset,
        };
        // P2：编码确认帧失败也要关连接——裸 return 会让对端干等 ACK 超时
        //（75s），违背本文件「两条腿都留着」的收尾纪律。
        let Ok(bytes) = encode_ack(&ack) else {
            conn.close(5u32.into(), b"ack_encode");
            return;
        };
        if write_frame(&mut send, &bytes).await.is_err() {
            log::warn!("[RC] {short} 回确认失败");
            return;
        }
        if plan.offset > 0 {
            log::info!("[RC] {short} 续传 {}：从 {} 字节继续", plan.final_name, plan.offset);
        }

        let task_id = self.file.task_start(
            peer,
            &peer_name,
            TaskDir::Recv,
            &plan.final_name,
            size,
            plan.offset,
            now_ms(),
        );
        // 实际落盘路径（收侧）——净化过重名后的最终路径，不是对端报的那个名字。
        // 用**原始**路径：plan.final_path 可能带 `\\?\` 前缀（C6），explorer 不认。
        self.file.task_note_path(&task_id, &dir.join(&plan.final_name));
        self.emit_file_state();
        let (outcome, got) = recv_bytes(self, &mut recv, &plan, size, &task_id).await;
        let (state, err) = outcome.finish(got, size);
        if state == TaskState::Done {
            log::info!("[RC] {short} 已接收 {}（{} 字节）", plan.final_name, size);
        } else {
            log::warn!("[RC] {short} 接收 {} 未完成：{state:?} {err:?}", plan.final_name);
        }
        self.finish_file(&task_id, state, err, size);
        // P1-3：**不在这里关连接**——多文件批次里后面还有文件要接，
        // 连接由发送端收尾（run_send_batch 传完 close → 本侧 accept_bi 报错退出）。
        let _ = send.finish();
    }

    /// 对方要我发文件：先问人（选文件），再灌字节。
    async fn serve_pull(
        self: &Arc<Self>,
        conn: &Connection,
        peer: &str,
        short: &str,
        resume: &[ResumeHint],
        mut send: SendStream,
        mut recv: RecvStream,
    ) {
        let peer_name = self.peer_name(peer);
        // 文案与「对方要给你发文件」必须区分开：那个的按键是「选放哪儿」，
        // 这个的按键是「去选文件」（设计稿 11.2 的注意事项 2）。
        let ask_id = self.file.ask(peer, &peer_name, AskKind::Pull, "", 0, now_ms());
        self.emit_file_state();
        let picked = loop {
            tokio::time::sleep(Duration::from_millis(200)).await;
            match self.file.outcome(&ask_id, now_ms()) {
                AskOutcome::Waiting => continue,
                AskOutcome::Accept(p) => break Some(p),
                AskOutcome::Deny => break None,
                AskOutcome::Timeout => {
                    log::info!("[RC] {short} 「对方要文件」确认超时，按拒绝处理");
                    break None;
                }
                AskOutcome::Gone => {
                    conn.close(4u32.into(), b"canceled");
                    return;
                }
            }
        };
        self.file.drop_ask(&ask_id);
        self.emit_file_state();

        let Some(path) = picked else {
            deny_file(&mut send, conn, "对方取消了这次请求", code::DENIED).await;
            return;
        };

        // v1 只传扁平文件：目录在界面上就该被挡，这里再兜一道
        let meta = match tokio::fs::metadata(&path).await {
            Ok(m) if m.is_file() => m,
            Ok(_) => {
                deny_file(&mut send, conn, "只支持传文件，目录留到后续版本", code::LOCAL).await;
                return;
            }
            Err(e) => {
                deny_file(&mut send, conn, &format!("读不到这个文件：{e}"), code::LOCAL).await;
                return;
            }
        };
        let size = meta.len();
        if size > MAX_FILE_BYTES {
            deny_file(&mut send, conn, "文件超过上限", code::SIZE_LIMIT).await;
            return;
        }
        let raw_name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let name = match safe_file_name(&raw_name) {
            Ok(n) => n,
            Err(e) => {
                deny_file(&mut send, conn, &format!("文件名不能用：{e}"), code::BAD_NAME).await;
                return;
            }
        };

        // 续传：命中对方给的提示（同名 + 偏移不越界）就从断点灌
        let offset = resume
            .iter()
            .find(|r| r.name == name && r.offset <= size)
            .map(|r| r.offset)
            .unwrap_or(0);

        let ack = FileAck::Accept {
            name: Some(name.clone()),
            size: Some(size),
            offset,
        };
        // P2：同 serve_push——编码失败必须关连接，别让对端干等超时。
        let Ok(bytes) = encode_ack(&ack) else {
            conn.close(5u32.into(), b"ack_encode");
            return;
        };
        if write_frame(&mut send, &bytes).await.is_err() {
            log::warn!("[RC] {short} 回确认失败");
            return;
        }

        let task_id = self
            .file
            .task_start(peer, &peer_name, TaskDir::Send, &name, size, offset, now_ms());
        // 源文件绝对路径（发侧）——对方要走的那个文件在本机哪儿。
        self.file.task_note_path(&task_id, &path);
        self.emit_file_state();
        let (outcome, sent) =
            send_bytes(self, &mut send, &path, size, offset, &task_id).await;
        let (state, err) = outcome.finish(sent, size);
        if state != TaskState::Done {
            log::warn!("[RC] {short} 发送 {name} 未完成：{state:?} {err:?}");
        }
        self.finish_file(&task_id, state, err, size);
        let _ = recv.stop(0u32.into());
        // P1-3：连接由对端（run_pull）收尾，这里不关——本侧 handle_file_conn
        // 的流循环在 serve_pull 返回后统一 return。
    }

    /// 魔数 + 头帧（帧格式与 `rc/1` 的 write_frame 同款：大端长度前缀）。
    async fn write_head(&self, send: &mut SendStream, bytes: &[u8]) -> Result<(), String> {
        send.write_all(&MAGIC[..])
            .await
            .map_err(|e| format!("写流头失败：{}", e))?;
        write_frame(send, bytes).await
    }

    fn finish_file(&self, task_id: &str, state: TaskState, err: Option<String>, _size: u64) {
        if self.file.task_finish(task_id, state, err, now_ms()) {
            self.emit_file_state();
        }
    }
}

// ── 字节搬运（两个方向共用）──────────────────────────────────────────────

/// 把文件从 `offset` 起灌进流。返回 (结局, 已发字节数)。
async fn send_bytes(
    svc: &Arc<RcService>,
    send: &mut SendStream,
    path: &Path,
    size: u64,
    offset: u64,
    task_id: &str,
) -> (TxOutcome, u64) {
    let mut f = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(e) => return (TxOutcome::Io(format!("打开源文件失败：{e}")), offset),
    };
    if offset > 0 {
        if let Err(e) = f.seek(std::io::SeekFrom::Start(offset)).await {
            return (TxOutcome::Io(format!("定位断点失败：{e}")), offset);
        }
    }
    let mut buf = vec![0u8; CHUNK];
    let mut sent = offset;
    while sent < size {
        if !svc.file.is_running(task_id) {
            let _ = send.finish();
            return (TxOutcome::Canceled, sent);
        }
        let want = ((size - sent) as usize).min(CHUNK);
        let n = match f.read(&mut buf[..want]).await {
            Ok(0) => {
                return (
                    TxOutcome::Io("源文件在传输中被改短了".into()),
                    sent,
                )
            }
            Ok(n) => n,
            Err(e) => return (TxOutcome::Io(format!("读源文件失败：{e}")), sent),
        };
        // write 会被 QUIC 流控压住（对端跟不上），所以也要有 stall 判据
        match tokio::time::timeout(Duration::from_secs(STALL_SECS), send.write_all(&buf[..n])).await
        {
            Err(_) => return (TxOutcome::Stalled, sent),
            Ok(Err(e)) => {
                return (
                    TxOutcome::Io(format!("写流出错（对端可能已断开）：{e}")),
                    sent,
                )
            }
            Ok(Ok(())) => {}
        }
        sent += n as u64;
        if svc.file.task_progress(task_id, sent, now_ms()) {
            svc.emit_file_state();
        }
    }
    if send.finish().is_err() {
        return (TxOutcome::Io("关闭发送流失败".into()), sent);
    }
    (TxOutcome::Done, sent)
}

/// 把流里的字节写到 `plan.part`，收满后 `rename` 成最终名。
async fn recv_bytes(
    svc: &Arc<RcService>,
    recv: &mut RecvStream,
    plan: &RecvPlan,
    size: u64,
    task_id: &str,
) -> (TxOutcome, u64) {
    let mut f = match tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&plan.part)
        .await
    {
        Ok(f) => f,
        Err(e) => {
            return (
                TxOutcome::Io(format!("打开落盘文件失败（{}）：{e}", plan.part.display())),
                plan.offset,
            )
        }
    };
    let mut buf = vec![0u8; CHUNK];
    let mut got = plan.offset;
    while got < size {
        if !svc.file.is_running(task_id) {
            // 主动取消：**保留 `.pppart`**，下次可续（设计稿 11.4 白送的暂停/恢复）
            let _ = f.flush().await;
            return (TxOutcome::Canceled, got);
        }
        let want = ((size - got) as usize).min(CHUNK);
        let n = match tokio::time::timeout(Duration::from_secs(STALL_SECS), recv.read(&mut buf[..want]))
            .await
        {
            Err(_) => {
                let _ = f.flush().await;
                return (TxOutcome::Stalled, got);
            }
            Ok(Ok(Some(0))) | Ok(Ok(None)) => {
                let _ = f.flush().await;
                return (TxOutcome::RemoteClosed, got);
            }
            Ok(Ok(Some(n))) => n,
            Ok(Err(e)) => {
                let _ = f.flush().await;
                return (TxOutcome::Io(format!("读流出错：{e}")), got);
            }
        };
        if let Err(e) = f.write_all(&buf[..n]).await {
            return (TxOutcome::Io(format!("写盘失败（磁盘满？）：{e}")), got);
        }
        got += n as u64;
        if svc.file.task_progress(task_id, got, now_ms()) {
            svc.emit_file_state();
        }
    }
    if let Err(e) = f.flush().await {
        return (TxOutcome::Io(format!("落盘失败：{e}")), got);
    }
    drop(f);
    // 🔴 只有收满才改名。补零凑满这种事一次都不能做——那会让「完成」变成谎言。
    if let Err(e) = tokio::fs::rename(&plan.part, &plan.final_path).await {
        return (TxOutcome::Io(format!("改名失败：{e}")), got);
    }
    (TxOutcome::Done, got)
}

// ── 落点与目录 ──────────────────────────────────────────────────────────

/// 定下落点：重名递增（绝不覆盖）、`.pppart`、续传偏移。
///
/// 续传判据（设计稿决策 9）：`<name>.pppart` 存在**且**长度 ≤ `size` ⇒ 续；
/// 否则删掉旧的从头来。`Last-Modified` 不参与判断——FAT/exFAT 精度不够，
/// 比了反而误判。
/// Windows 长路径兜底（C6）：落盘路径逼近 MAX_PATH(260) 时加 `\\?\` 前缀，
/// 让 NT 命名空间接管（实际上限 32767）。触发场景：深层接收目录 + 长文件名。
/// 已带扩展前缀的、不够长的原样返回；UNC 走 `\\?\UNC\` 变体。
#[cfg(target_os = "windows")]
fn extend_long_path(p: PathBuf) -> PathBuf {
    let s = p.as_os_str().to_string_lossy();
    if s.len() < 240 || s.starts_with(r"\\?\") {
        return p;
    }
    let abs = if p.is_absolute() {
        p
    } else {
        match std::env::current_dir() {
            Ok(c) => c.join(&p),
            Err(_) => return p,
        }
    };
    let abs_s = abs.to_string_lossy().replace('/', r"\");
    if let Some(rest) = abs_s.strip_prefix(r"\\") {
        return PathBuf::from(format!(r"\\?\UNC\{rest}"));
    }
    PathBuf::from(format!(r"\\?\{abs_s}"))
}

#[cfg(not(target_os = "windows"))]
fn extend_long_path(p: PathBuf) -> PathBuf {
    p
}

fn prepare_recv(dir: &Path, name: &str, size: u64) -> Result<RecvPlan, String> {
    if !dir.is_dir() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("建目录失败（{}）：{}", dir.display(), e))?;
    }
    let final_name = file_proto::unique_name(name, |n| dir.join(n).exists())?;
    // fs 操作（append / rename / remove）走前缀化路径；给前端展示 /
    // 「打开所在文件夹」的路径保持原样（explorer 不认 `\\?\` 形态）。
    let final_path = extend_long_path(dir.join(&final_name));
    let part = extend_long_path(dir.join(part_path(&final_name)));
    let offset = match std::fs::metadata(&part) {
        Ok(m) if m.is_file() => {
            let len = m.len();
            if len <= size {
                len
            } else {
                // part 比声明的还大 ⇒ 是另一个文件留下的，删掉重来
                let _ = std::fs::remove_file(&part);
                0
            }
        }
        Ok(_) => return Err("落点上有个同名的目录，写不进去".to_string()),
        Err(_) => 0,
    };
    Ok(RecvPlan {
        final_name,
        part,
        final_path,
        offset,
    })
}

/// 扫目标目录里的 `.pppart`，供取回方向告诉对方「我这儿已经有什么」。
fn resume_hints(dir: &Path) -> Vec<ResumeHint> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in rd.flatten() {
        if out.len() >= file_proto::MAX_RESUME_HINTS {
            break;
        }
        let raw = e.file_name().to_string_lossy().to_string();
        let Some(final_name) = final_from_part(&raw) else {
            continue;
        };
        let Ok(m) = e.metadata() else { continue };
        if !m.is_file() {
            continue;
        }
        out.push(ResumeHint {
            name: final_name.to_string(),
            offset: m.len(),
        });
    }
    out
}

/// 默认接收目录：`<下载>/PastePanda 接收/`。
///
/// 🔴 **不能拼 `~/Downloads`**：中文系统那个目录叫「下载」，而且用户可能把整个
/// 下载目录重定向到别的盘。所以要问系统（`SHGetKnownFolderPath`），不能猜。
/// 系统不认（罕见）时退回 `~/Downloads`——宁可落到一个不太准的默认值，
/// 也不能没有默认值。
pub fn default_receive_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    let base = known_downloads_dir();
    #[cfg(not(target_os = "windows"))]
    let base = None;
    let base = match base {
        Some(d) => d,
        None => crate::user_paths::home_dir()?.join("Downloads"),
    };
    Ok(base.join("PastePanda 接收"))
}

#[cfg(target_os = "windows")]
fn known_downloads_dir() -> Option<PathBuf> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{FOLDERID_Downloads, KF_FLAG_DEFAULT, SHGetKnownFolderPath};
    // SAFETY: 返回的 PWSTR 由系统用 CoTaskMemAlloc 分配，取走字符串后立刻释放；
    // 中间不做任何可能 panic 的操作（`.ok()?` 失败时提前返回，会漏一次释放——
    // 代价是几十字节，换的是不在这里写 unsafe 的 drop guard）。
    unsafe {
        let p = SHGetKnownFolderPath(&FOLDERID_Downloads, KF_FLAG_DEFAULT, None).ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const core::ffi::c_void));
        s.map(PathBuf::from).filter(|d| !d.as_os_str().is_empty())
    }
}

// ── 小工具 ──────────────────────────────────────────────────────────────

/// 抢一个确认帧 / 魔数，带超时（`read_frame` 内部有自己的 stall 判据，
/// 这个用于固定长度的裸读）。
async fn recv_exact(r: &mut RecvStream, buf: &mut [u8]) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(OPEN_STREAM_SECS), r.read_exact(buf))
        .await
        .map_err(|_| "等对端数据超时".to_string())?
        .map_err(|e| format!("读流出错：{e}"))
}

/// 拒绝一条文件请求：先回 `deny` 帧、再关连接。
///
/// 照 `service.rs::deny_and_close` 的「两条腿都留着」：只关不说是「点了没反应」，
/// 只说不关会让对端流悬着。
async fn deny_file(send: &mut SendStream, conn: &Connection, reason: &str, c: &str) {
    let ack = FileAck::Deny {
        reason: reason.to_string(),
        code: Some(c.to_string()),
    };
    if let Ok(bytes) = encode_ack(&ack) {
        let _ = write_frame(send, &bytes).await;
    }
    let _ = send.finish();
    conn.close(1u32.into(), format!("[{}] {}", c, reason).as_bytes());
}
