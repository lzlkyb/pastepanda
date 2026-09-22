//! 被控侧会话建立/回滚/批准与历史清理。
//!
//! 2026-09-22 从 `service.rs` 平移（体量合规）。`use crate::rc::*` 沿用
//! `service/mod.rs` 的全部名字；方法体未改动，仅 `pub(super)` 方法
//! 升级为 `pub(in crate::rc)`（原语义就是「rc 子树可见」）。

use super::*;

impl RcService {
    /// 建立入站会话的**核心**（人工同意与方案 D 免确认共用）。
    ///
    /// 门禁在这里重查一遍：人工路径的申请与同意之间最长 120s，配置可能已变
    /// （TOCTOU）；免确认路径虽无间隔，同一套判据再走一遍成本为零。
    /// 只改 `inner.session`，**不碰 pending**——pending 的出入队由调用方负责
    /// （人工路径从 pending 里来；免确认路径压根没进过 pending）。
    pub(in crate::rc) fn establish_inbound_with(
        &self,
        inner: &mut Inner,
        peer: &str,
        peer_name: String,
        requested: Capability,
        trust: InboundTrust,
    ) -> Result<Session, String> {
        if !self.enabled() {
            return Err("本机已关闭「允许被远程协助」".into());
        }
        if self.device_deny().get(peer).copied().unwrap_or(false) {
            return Err("该设备已被禁止远程本机".into());
        }
        // 凭证路径（码 / 密码）此刻白名单行还没写（D1），所以跳过这一条；
        // 逐台禁止那一条仍在上面照跑，凭证不能替被拉黑的设备翻案。
        if trust == InboundTrust::Whitelist && !self.has_remote_trust(peer) {
            return Err("设备未配对".into());
        }
        // 本机已有进行中的会话时，不能硬覆盖（发起侧 request_session 有 [busy_local] 这道闸，
        // 被控侧之前漏了——补上。对照状态机：OutboundActive/InboundActive 都不能迁移到 InboundActive。
        if let Some(cur) = inner.session.as_ref() {
            if !can_transition(cur.phase, SessionPhase::InboundActive) {
                return Err("[busy_local] 本机已有进行中的远程会话，请先结束".into());
            }
        }
        let cap = if requested.allowed_by(self.max_capability()) {
            requested
        } else {
            self.max_capability()
        };
        let s = Session {
            id: new_session_id(now_ms()),
            peer: peer.to_string(),
            peer_name,
            capability: cap,
            phase: SessionPhase::InboundActive,
            started_ms: now_ms(),
            granted: true,
        };
        inner.session = Some(s.clone());
        // 新会话的推流所有权从头分配（上一场的标记必须清，否则第一个批准循环
        // 会误判「已有人推流」而拒绝回 Accept）。
        inner.inbound_streaming = false;
        Ok(s)
    }

    /// 回滚一次「会话已建立、但随后的准入步骤失败」的入站会话（D1）。
    ///
    /// 只清**peer 匹配且 phase 为 `InboundActive`** 的那一场——与
    /// [`Self::force_end_if_session`] 同一纪律：认领条件收得越紧越好，
    /// 不按 peer 之外的任何推测去动别人的会话。
    /// 前置事实：调用点紧跟在 `establish_inbound_with` 返回 Ok 之后，
    /// 所以此刻槽里必然是**刚刚**建立的那一场（上一个会话若存在则必然是
    /// `InboundActive`，而 `can_transition` 不允许它被顶掉，establish 会先报忙）。
    pub(in crate::rc) fn rollback_inbound(&self, peer: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let mine = inner
            .session
            .as_ref()
            .is_some_and(|s| s.peer == peer && s.phase == SessionPhase::InboundActive);
        if mine {
            inner.session = None;
            inner.inbound_streaming = false;
            log::warn!("[RC] 准入后续步骤失败，已回滚刚建立的入站会话（{peer:.8}）");
        }
    }

    pub fn approve_inbound(&self, peer: &str) -> Result<Session, String> {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let idx = inner
            .pending
            .iter()
            .position(|k| k.peer == peer)
            .ok_or("没有待确认的远程申请")?;
        let knock = inner.pending[idx].clone();
        let s = self.establish_inbound_with(
            &mut inner,
            peer,
            knock.peer_name,
            knock.capability,
            InboundTrust::Whitelist,
        )?;
        inner.pending.remove(idx);
        drop(inner);
        // B-b：人工批准 = 首次 elevate 确认。仅同步配对的设备在此写入 rc_devices，
        // 此后可开免确认/自动收文件；已是 rc 设备则幂等无操作。
        if let Err(e) = self.elevate_from_sync(peer) {
            log::warn!("[RC] 批准入站后 elevate 失败（不影响本次会话）：{e}");
        }
        self.emit_changed();
        Ok(s)
    }

    pub fn deny_inbound(&self, peer: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let before = inner.pending.len();
        inner.pending.retain(|k| k.peer != peer);
        if inner.pending.len() == before {
            return Err("没有待确认的远程申请".into());
        }
        Ok(())
    }

    /// 读最近若干条会话历史（前端展示用）。实现见 `rc/history.rs`。
    pub fn session_history(&self) -> Vec<serde_json::Value> {
        crate::rc::history::list_history(&self.store)
    }

    /// 清空全部会话历史（设置页「清空记录」）。实现见 `rc/history.rs`。
    pub fn clear_history(&self) -> Result<(), String> {
        crate::rc::history::clear_history(&self.store)
    }
}

/// 被控端任务入口：输入读取 + 画面推流（实现在 `rc/inbound.rs`）。
pub(in crate::rc) async fn spawn_inbound_video(
    peer: &str,
    send: iroh::endpoint::SendStream,
    recv: iroh::endpoint::RecvStream,
    conn: iroh::endpoint::Connection,
    peer_dgram: bool,
    peer_audio: bool,
) {
    let Some(svc) = global() else {
        return;
    };
    // G3：对端申请了系统声音 → 音频 worker 由 InboundVideo::run 启动
    svc.audio_set_peer_wants(peer_audio);
    let Some(video) =
        crate::rc::inbound::InboundVideo::try_new(svc.clone(), peer, send, conn, peer_dgram)
    else {
        svc.audio_reset();
        log::warn!("[RC] 被控推流启动前会话已结束，放弃推流");
        return;
    };
    video.run(recv).await;
}
