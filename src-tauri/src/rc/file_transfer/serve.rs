//! 接收侧：handle_file_conn / serve_push / serve_pull / finish_file。

use super::*;

impl RcService {
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
        let gate = crate::rc::session::gate_inbound(
            self.enabled(),
            self.max_capability(),
            &self.device_deny(),
            &peer,
            rc_paired,
            crate::rc::protocol::Capability::View,
            false,
        );
        if gate != crate::rc::session::Gate::Allow {
            // 数值码只做粗分类（沿用本文件既有约定），细因在 reason 字节串里
            let code: u32 = match gate {
                crate::rc::session::Gate::DeviceDenied => 4,
                crate::rc::session::Gate::NotPaired if self.has_remote_trust(&peer) => 3,
                _ => 1,
            };
            conn.close(code.into(), gate.deny_code().as_bytes());
            if gate == crate::rc::session::Gate::NotPaired && self.has_remote_trust(&peer) {
                log::info!(
                    "[RC] {short} 文件连接被拒：仅笔记同步配对，尚未获得远程/文件权限"
                );
            } else {
                log::info!("[RC] {short} 文件连接被拒：{}", gate.deny_reason());
            }
            return;
        }
        if !self.file.try_reserve_peer(&peer) {
            conn.close(2u32.into(), b"busy");
            log::info!("[RC] {short} 文件连接被拒：这条设备已有文件任务在跑");
            return;
        }
        // P2-6: hold the peer slot for the whole connection; drop releases it.
        let _peer_slot = PeerSlotGuard {
            file: &self.file,
            peer: peer.clone(),
        };

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
                deny_file(&mut send, "不是文件流", code::BAD_HEAD).await;
                log::warn!("[RC] {short} 文件流魔数不对");
                conn.close(1u32.into(), b"bad_head");
                return;
            }
            let raw = match read_frame(&mut recv).await {
                Ok(b) => b,
                Err(e) => {
                    log::warn!("[RC] {short} 读文件头失败：{e}");
                    conn.close(1u32.into(), b"bad_head");
                    return;
                }
            };
            let head = match file_proto::decode_head(&raw) {
                Ok(h) => h,
                Err(d) => {
                    deny_file(&mut send, &d.reason, d.code).await;
                    log::info!("[RC] {short} 文件头被拒：{}", d.reason);
                    conn.close(1u32.into(), b"bad_head");
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
                    conn.close(0u32.into(), b"done");
                    return;
                }
            }
        }
    }

    /// 对方要发文件给我：先问人，再落盘。
    #[allow(clippy::too_many_arguments)]
    pub(in crate::rc) async fn serve_push(
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
                            deny_file(&mut send, "确认条已失效（请让对方重试）", code::DENIED)
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
                        deny_file(&mut send, "对方拒绝了这次传输", code::DENIED).await;
                        log::info!("[RC] {short} 本机用户拒收文件：{name}");
                        return;
                    }
                }
            }
        };

        // ── 落点（重名递增 + 续传）──
        let plan = match prepare_recv(&dir, name, size, &self.file) {
            Ok(p) => p,
            Err(e) => {
                deny_file(&mut send, &e, code::LOCAL).await;
                log::warn!("[RC] {short} 无法落盘：{e}");
                return;
            }
        };
        let _part_slot = PartSlotGuard {
            file: &self.file,
            key: plan.part_key.clone(),
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
    pub(in crate::rc) async fn serve_pull(
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
            deny_file(&mut send, "对方取消了这次请求", code::DENIED).await;
            return;
        };

        // v1 只传扁平文件：目录在界面上就该被挡，这里再兜一道
        let meta = match tokio::fs::metadata(&path).await {
            Ok(m) if m.is_file() => m,
            Ok(_) => {
                deny_file(&mut send, "只支持传文件，目录留到后续版本", code::LOCAL).await;
                return;
            }
            Err(e) => {
                deny_file(&mut send, &format!("读不到这个文件：{e}"), code::LOCAL).await;
                return;
            }
        };
        let size = meta.len();
        if size > MAX_FILE_BYTES {
            deny_file(&mut send, "文件超过上限", code::SIZE_LIMIT).await;
            return;
        }
        let raw_name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let name = match safe_file_name(&raw_name) {
            Ok(n) => n,
            Err(e) => {
                deny_file(&mut send, &format!("文件名不能用：{e}"), code::BAD_NAME).await;
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
    pub(in crate::rc) async fn write_head(&self, send: &mut SendStream, bytes: &[u8]) -> Result<(), String> {
        send.write_all(&MAGIC[..])
            .await
            .map_err(|e| format!("写流头失败：{}", e))?;
        write_frame(send, bytes).await
    }

    pub(in crate::rc) fn finish_file(&self, task_id: &str, state: TaskState, err: Option<String>, _size: u64) {
        if self.file.task_finish(task_id, state, err, now_ms()) {
            self.emit_file_state();
        }
    }
}
