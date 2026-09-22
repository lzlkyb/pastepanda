//! 帧缓冲、输入注入、剪贴板推送/拉取与会话快照。
//!
//! 2026-09-22 从 `service.rs` 平移（体量合规）。`use crate::rc::*` 沿用
//! `service/mod.rs` 的全部名字；方法体未改动，仅 `pub(super)` 方法
//! 升级为 `pub(in crate::rc)`（原语义就是「rc 子树可见」）。

use super::*;

impl RcService {
    /// 发起端取最近一帧（JPEG bytes）。无画面返 None。
    pub fn latest_frame(&self) -> Option<crate::rc::video::VideoFrame> {
        self.last_frame
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    pub(in crate::rc) fn set_frame(&self, f: crate::rc::video::VideoFrame) {
        *self.last_frame.lock().unwrap_or_else(|p| p.into_inner()) = Some(f);
    }

    pub(in crate::rc) fn clear_frame(&self) {
        *self.last_frame.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    /// 发起端：一帧入队（收流循环调用），并唤醒前端来取。
    pub(in crate::rc) fn push_outbox(&self, f: crate::rc::video::VideoFrame) {
        {
            let mut g = self.frame_outbox.lock().unwrap_or_else(|p| p.into_inner());
            g.push(f);
        }
        self.notify.emit_frame_ready(now_ms());
    }

    /// 前端批量取走全部待显示帧（`rc_drain_frames` 命令）。取走即清。
    pub fn drain_frames(&self) -> Vec<crate::rc::video::VideoFrame> {
        self.frame_outbox
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .drain()
    }

    pub(in crate::rc) fn clear_outbox(&self) {
        self.frame_outbox
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
    }

    pub(in crate::rc) fn session_is(&self, phase: SessionPhase, peer: &str) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        matches!(inner.session.as_ref(), Some(s) if s.phase == phase && s.peer == peer)
    }

    pub(in crate::rc) fn session_capability(&self) -> Option<Capability> {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.session.as_ref().map(|s| s.capability)
    }

    /// 一次加锁取出「这个 peer 的当前会话」快照（P1-2）。
    ///
    /// 🔴 入口判定与能力校验必须用**同一快照**，不要再拆成
    /// `session_is` + `session_capability` 两次加锁——中间会话可被换掉，
    /// 旧 peer 的迟到输入会挂到新会话的能力上。
    pub(in crate::rc) fn session_snapshot_for(&self, peer: &str) -> Option<SessionSnapshot> {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let s = inner.session.as_ref()?;
        if s.peer != peer {
            return None;
        }
        Some(s.snapshot())
    }

    /// 注入/写主机前复核：快照对应的会话是否还是同一条（P1-2）。
    ///
    /// 快照到真正注入之间仍有窗口；键鼠与剪贴板这类主机副作用前再比一次
    /// `peer/phase/capability`，变了就丢弃这次迟到输入。
    pub(in crate::rc) fn session_peer_unchanged(&self, snap: &SessionSnapshot) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        matches!(
            inner.session.as_ref(),
            Some(s) if s.peer == snap.peer && s.phase == snap.phase && s.capability == snap.capability
        )
    }

    /// 发起端发送输入/剪贴板/流控帧。会话必须 OutboundActive。
    ///
    /// 免 Control 白名单（2026-09-20 二次审查拍板）：
    /// - **Ping / NetHint / SetBitratePct / SetQuality / SetCodec / RequestKey**：
    ///   只看会话的流控与自愈——否则 View 发不出心跳会误暂停推流。
    /// - **AudioOn**：只看可收系统声音（收声不改主机环境）。
    /// - **SetCaptureScope 要求 Control**：改采集范围会切到对方其它屏，属于
    ///   改主机可观测内容，只看不得改（与 SetHostMute 同级）。
    pub async fn send_input(&self, ev: &crate::rc::input::InputEvent) -> Result<(), String> {
        use crate::rc::input::InputEvent;
        let needs_control = !matches!(
            ev,
            InputEvent::Ping { .. }
                | InputEvent::NetHint { .. }
                | InputEvent::SetBitratePct { .. }
                | InputEvent::SetQuality { .. }
                | InputEvent::SetCodec { .. }
                | InputEvent::AudioOn { .. }
                | InputEvent::RequestKey
        );
        if needs_control {
            let cap = self.session_capability().ok_or("没有进行中的会话")?;
            crate::rc::input::assert_control_allowed(cap)?;
        }
        {
            let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let s = inner.session.as_ref().ok_or("没有进行中的会话")?;
            if s.phase != SessionPhase::OutboundActive {
                return Err("会话尚未建立".into());
            }
        }
        // P0-3：鼠标移动走 QUIC 数据报——不可靠但免队头阻塞，视频大帧堵住
        // 可靠流时鼠标照样每拍都到。绝对坐标 latest-wins：丢一帧被下一帧校正。
        // 数据报不支持/发送失败 → 回退可靠流（原路）。
        if matches!(ev, crate::rc::input::InputEvent::MouseMove { .. }) {
            let json = serde_json::to_vec(ev).map_err(|e| e.to_string())?;
            let conn = self.outbound_conn.lock().await.clone();
            if let Some(conn) = conn {
                if conn.datagram_send_buffer_space() >= json.len()
                    && conn.send_datagram(json.into()).is_ok()
                {
                    return Ok(());
                }
            }
        }
        let mut guard = self.outbound_send.lock().await;
        let Some(send) = guard.as_mut() else {
            return Err("发送通道不可用".into());
        };
        let json = serde_json::to_vec(ev).map_err(|e| e.to_string())?;
        crate::sync::transport::write_frame(send, &json).await
    }

    /// 发起端会话链路统一收口：发送半流 + 连接句柄一起清。
    /// 🔴 连接句柄不清，下一场会话的鼠标数据报会发进旧连接（黑洞）。
    pub(in crate::rc) async fn clear_outbound_link(&self) {
        *self.outbound_send.lock().await = None;
        *self.outbound_conn.lock().await = None;
        self.remote_loss_permille
            .store(0, std::sync::atomic::Ordering::Relaxed);
        self.peer_fps120
            .store(false, std::sync::atomic::Ordering::Relaxed);
        self.peer_refresh_hz
            .store(0, std::sync::atomic::Ordering::Relaxed);
        self.peer_hevc
            .store(false, std::sync::atomic::Ordering::Relaxed);
        self.peer_dgram_input
            .store(false, std::sync::atomic::Ordering::Relaxed);
        // Q7：对端屏列表是上一场会话的残留——不清的话，断连后 UI 还能
        // 「切到」一个早已不在场的显示器。
        self.peer_monitors
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
    }

    /// 发起端：把本地剪贴板文本推给被控端（R3 文本优先）。
    /// 按 **JSON 帧字节**卡上限，避免中文字符数过了但 write_frame 超 64KB。
    /// 量纲与入站校验同源（[`clip_payload_ok`]）。
    pub async fn push_clipboard(&self, text: &str) -> Result<(), String> {
        let ev = crate::rc::input::InputEvent::ClipboardPush {
            text: text.to_string(),
        };
        let json = serde_json::to_vec(&ev).map_err(|e| e.to_string())?;
        if !clip_payload_ok(json.len()) {
            return Err(format!(
                "剪贴板过大（约 {} KB，上限约 {} KB），请改用文件或其他方式传输",
                json.len() / 1024,
                CLIPBOARD_MAX_JSON_BYTES / 1024
            ));
        }
        self.send_input(&ev).await
    }

    /// 发起端请求拉回对方剪贴板，并等回包（修「立刻 take 必空」竞态）。
    /// 超时或对方无回包时返回 `Ok(None)`。
    ///
    /// C8(b) 的两处串扰防线（并发 pull 共用一个序号 / 上个会话迟到的回包）
    /// 全部收在 `clipboard.rs` 里：这里只负责编排顺序 —— **先**拿串行化守卫、
    /// **再**取起点值、**然后**才发请求。顺序反了会漏掉请求发出后立刻到的回包。
    /// 判决策与取内容都走 `ClipboardState`，别再在这里直接读序号。
    pub async fn pull_clipboard(&self) -> Result<Option<String>, String> {
        let _serial = self.clip.lock_pull().await;
        let (epoch, before) = self.clip.snapshot();
        self.send_input(&crate::rc::input::InputEvent::ClipboardPull)
            .await?;
        let deadline = now_ms() + CLIPBOARD_PULL_TIMEOUT_MS;
        while now_ms() < deadline {
            match self.clip.decision(epoch, before) {
                ClipWait::Take => {
                    // P2-5：先看是不是失败回包——失败转 Err 报给用户，
                    // 绝不折叠成空串（空串与「对方剪贴板是空的」不可区分）。
                    if let Some(e) = self.clip.take_pull_error() {
                        return Err(e);
                    }
                    return Ok(self.clip.take());
                }
                ClipWait::Abandon => return Ok(None),
                ClipWait::KeepWaiting => {}
            }
            tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        }
        Ok(None)
    }

    /// 接收循环：对端回了 `clip_err`（P2-5）。记失败原因并唤醒等待循环，
    /// 让 `pull_clipboard` 以 Err 收场。
    pub(in crate::rc) fn clip_pull_failed(&self, e: String) {
        self.clip.set_pull_error(e);
    }

    /// 会话收口时调用：作废仍在等待的 pull，并丢掉可能由迟到回包写入的文本。
    pub(in crate::rc) fn invalidate_clipboard(&self) {
        self.clip.invalidate();
    }

    pub(in crate::rc) fn set_remote_clipboard(&self, t: String) {
        self.clip.set_from_peer(t);
    }
}
