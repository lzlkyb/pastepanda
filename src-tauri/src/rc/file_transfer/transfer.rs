//! 批传输跑批：run_send_batch / run_pull。

use super::*;

impl RcService {
    /// 一批文件**串行**发完（一条连接，每个文件一条 bi-stream）。
    pub(in crate::rc) async fn run_send_batch(
        self: Arc<Self>,
        peer: &str,
        items: Vec<(PathBuf, String, u64)>,
    ) -> Result<(), String> {
        // C1（2026-09-23 复审）：连不上是最常见的失败，过去只有一行 log——
        // 用户点完「发送」传输面板毫无动静（静默失败）。现在与下面
        // 「开流失败」同一处理：整批各落一条 Failed task，面板看得见原因。
        let conn = match self.dial_file(peer).await {
            Ok(c) => c,
            Err(e) => {
                let peer_name = self.peer_name(peer);
                let reason = format!("连不上对方，未发送：{e}");
                for (p, nm, sz) in &items {
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
                return Err(e);
            }
        };
        let peer_name = self.peer_name(peer);
        // C-4：用索引循环，开流失败时把「当前 + 剩余」全部落 Failed task。
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
    ///
    /// C1（2026-09-23 复审）：inner 里所有 `?` 都发生在**建任务行之前**
    /// （连不上 / 开流失败 / 对方没响应 / 头帧坏）——这类失败过去只留一行
    /// 日志，传输面板静悄悄。外层兜底补一条 Failed 任务，让失败看得见。
    pub(in crate::rc) async fn run_pull(self: Arc<Self>, peer: &str, dir: PathBuf) -> Result<(), String> {
        let err = match self.clone().run_pull_inner(peer, dir).await {
            Ok(()) => return Ok(()),
            Err(e) => e,
        };
        let peer_name = self.peer_name(peer);
        let tid = self
            .file
            .task_start(peer, &peer_name, TaskDir::Recv, "取回文件", 0, 0, now_ms());
        self.finish_file(&tid, TaskState::Failed, Some(err.clone()), 0);
        Err(err)
    }

    async fn run_pull_inner(self: Arc<Self>, peer: &str, dir: PathBuf) -> Result<(), String> {
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
                conn.close(1u32.into(), b"denied");
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
        let plan = prepare_recv(&dir, &name, size, &self.file)?;
        let _part_slot = PartSlotGuard {
            file: &self.file,
            key: plan.part_key.clone(),
        };
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
}
