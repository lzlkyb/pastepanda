//! 发起侧入口：file_send / file_pull / 应答 / 取消 / 快照 / dial_file。

use super::*;

impl RcService {
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
    pub fn file_snapshot(&self) -> crate::rc::file_state::FileSnapshot {
        self.file.snapshot()
    }

    pub(in crate::rc) fn emit_file_state(&self) {
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
    pub(in crate::rc) fn auto_accept_dir(&self, peer: &str) -> Option<PathBuf> {
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
    /// P2-6: real claim is `FileState::try_reserve_peer` (atomic). This remains
    /// a cheap snapshot for logs/diagnostics.
    /// Snapshot busy check (logs/diagnostics). Real claim is `try_reserve_peer`.
    #[allow(dead_code)]
    pub(in crate::rc) fn file_busy(&self, peer: &str) -> bool {
        let snap = self.file.snapshot();
        snap.asks.iter().any(|a| a.peer == peer)
            || snap
                .tasks
                .iter()
                .any(|t| t.peer == peer && !t.state.is_over())
    }

    /// 拨通对端的文件通道。
    pub(in crate::rc) async fn dial_file(&self, peer: &str) -> Result<Connection, String> {
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
}
