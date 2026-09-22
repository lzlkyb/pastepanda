//! 会话生命周期（Tier B 第 5 组：从 `service.rs` 归位到状态机文件）。
//!
//! 为什么放这里：`session.rs` 是「状态**能不能**变」（转移表 + 门禁），这一块是
//! 「状态**怎么变**」（建立后的收口/判定）。拆在两个文件里，改转移表的人看不到收口
//! 顺序，改收口的人看不到转移表——A2（重连自杀）那种 bug 正是出在这个缝里。
//!
//! 这些方法要碰的 `RcService` 字段标了 `pub(super)`（见那边的可见性说明）；
//! 四个子结构体（clip / notify / stream / pressed 的内部字段）仍然私有。
//! 2026-09-22：impl 块从 `session.rs` 平移到本子文件（体量合规），字段可见性
//! `pub(in crate::rc)` 语义不变。

use crate::rc::protocol::{Capability, RcFrame, SessionPhase};
use crate::rc::service::{now_ms, AutoReconnect, RcService};
use super::{
    is_active, Session, SESSION_TTL_MS, RECONNECT_BASE_DELAY_MS, RECONNECT_MAX_ATTEMPTS,
    RECONNECT_SETTLE_POLLS, RECONNECT_SETTLE_POLL_MS,
};
use crate::rc::history::{append_history, HistoryFacts};
use std::sync::Arc;

impl RcService {
    pub async fn end_session(&self, reason: &str) -> Result<(), String> {
        // 🔴 take 语义（2026-09-20 审计 P2：end_session 可重入）：从槽里**取出**
        // 会话而不是只读——用户点结束与断流 `force_end_if_session` 并发触发时，
        // 旧实现两次都能读到同一份快照 → 双份历史 + 双份 End 帧。改成取走后，
        // 第二个调用方在这里就拿到 None（返回「没有进行中的会话」）。
        let (peer, peer_name, cap, phase, started) = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let Some(s) = inner.session.take() else {
                return Err("没有进行中的会话".into());
            };
            log::info!("[RC] 会话结束：{reason}");
            (
                s.peer.clone(),
                s.peer_name.clone(),
                s.capability,
                s.phase,
                s.started_ms,
            )
        };
        // 尽力通知对端：发起端走 outbound_send；被控端走 inbound_send
        {
            let mut guard = self.outbound_send.lock().await;
            if let Some(send) = guard.as_mut() {
                if let Ok(b) = (RcFrame::End {
                    reason: reason.to_string(),
                })
                .encode()
                {
                    let _ = crate::sync::transport::write_frame(send, &b).await;
                }
            }
            *guard = None;
        }
        // P0-3：连接句柄一并清——留着会把下一场会话的鼠标数据报发进旧连接
        *self.outbound_conn.lock().await = None;
        {
            let ib = self.inbound_send.lock().await.take();
            if let Some(send) = ib {
                let mut g = send.lock().await;
                if let Ok(b) = (RcFrame::End {
                    reason: reason.to_string(),
                })
                .encode()
                {
                    let _ = crate::sync::transport::write_frame(&mut g, &b).await;
                }
            }
        }
        // 补发卡住的 up：对端断线/会话结束时，被按住的 Ctrl/Shift/鼠标键不会自动弹起。
        // ⚠️ 必须在清 session 之前、且直接调注入函数（release_all），不要走 handle_inbound_input——
        // 会话结束态下它的 session_capability() 返回 None，能力校验会拦掉释放。
        // `end_session_releases_pressed_keys` 单测钉住「释放确实发生了」。
        {
            let mut g = self.pressed.lock().unwrap_or_else(|p| p.into_inner());
            g.release_all();
        }
        {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            inner.session = None; // take 已清，这里兜底（快照块只 take 了 session）
            inner.pending.clear();
            // 双连接守卫的标记随会话一起收（service.rs 审计 P2-1）
            inner.inbound_streaming = false;
        }
        // 链路句柄随会话一起收掉。交回的档位写进日志——真机排查时这是
        // 「这一次到底走的是局域网、公网直连还是绕中继」的唯一记录。
        // ❗ 必须在上面那个块**之外**调：`link` 与 `inner` 是两把锁，
        //    若在持 inner 时加 link，会与 `status()` 的加锁顺序相反（ABBA 死锁）。
        let end = self.link.detach();
        if end.path != crate::sync::path_kind::PathKind::None {
            log::info!(
                "[RC] 本次会话路径：{}（RTT 均 {}/峰值 {}ms）",
                end.path.label(),
                end.rtt_avg,
                end.rtt_max
            );
        }
        // 🔴 会话结束 → 标设备离线（2026-09-21 在线状态修复）。
        //
        // 这里的历史包袱值得记一笔，别再走回头路：
        // - 最初调 `rc_device_touch(&peer, false)` → 它**顺带把 last_seen 清 0**，
        //   于是「上次在线」永远显示不出来，且设备**永远离线**（跨网/组播被拦时
        //   再也好不了）——这是第一个极端。
        // - 为了修它改成 `touch(&peer, true)` → 于是只有写 online 没有写 offline，
        //   `conn_state` 只置位不复位，产生**假在线**——这是第二个极端。
        //
        // 两个极端同源：`rc_device_touch(x, false)` 把「标离线」和「清 last_seen」
        // 耦合成一个动作。现在拆开——用 `rc_device_mark_offline`（只动 conn_state）。
        // 「上次在线：3 小时前」由 `last_seen` 保留，离线判定不再被它误导。
        let _ = self.store.rc_device_mark_offline(&peer);
        // B-5：把这次**实测**的路径落到设备行，下次打开面板就能看到
        // 「上次走的是局域网直连」——而不是靠「有没有听到组播」去猜。
        // 空串（一条路都没通）会被 `rc_device_note_path` 忽略，不会抹掉上一次的实测值。
        let _ = self.store.rc_device_note_path(&peer, end.path.as_str());
        // C-4：历史里带上路径与网速摘要（旧记录没有这几个字段，前端按「没有」处理）。
        append_history(
            &self.store,
            HistoryFacts {
                peer: &peer,
                peer_name: &peer_name,
                cap,
                phase,
                started_ms: started,
                reason,
                end,
            },
        );
        self.clear_frame();
        // 出站帧队列一并清：旧会话攒下的 H.264 P 帧 / 脏块对新会话是毒数据
        self.clear_outbox();
        self.note_rtt(0);
        // 自动档与会话同生命周期（2A）：不复位的话 `status()` 会继续报上一场
        // 停留的「生效档」，而画面早就不推了——陈旧数据比没有数据更坏。
        // ❗ 必须在这里（inner 锁已放出、link 已 detach 之后）调用，别挪进锁块。
        self.reset_stream_after_session();
        // C8(b)：作废仍在等待的剪贴板 pull，并清掉可能由迟到回包写入的文本，
        // 避免下一个会话把它当成自己的结果返回。
        self.invalidate_clipboard();
        // 🔴 音频状态随会话收口（2026-09-20 审计 P1-1）：audio_reset 本就按
        // 「会话收口」语义设计（清对端申请位 / 对端开关镜像 / 收流缓冲，
        // 刻意不动 audio_local_mute），但此前只有发起端 request 成功与
        // inbound video 失败兜底两处调用——被控端的 `audio_muted` /
        // `spk_muted_by_peer` 会跨会话残留：上一场对端关过声音，下一场
        // 换个对端申请音频也听不到，无报错无横幅。接线补在这里，与
        // `reset_stream_after_session` 同层（inner 锁已放出）。
        self.audio_reset();
        // Q6：收口顺手清自动重连状态。异常断流路径的顺序是 force_end（清）→
        // begin（重建），这里清掉不碍触发；它兜的是「用户主动结束」要清掉
        // 残留的「重连中/重连失败」横幅——用户已经自己做了决定。
        *self.auto_reconnect.lock().unwrap_or_else(|p| p.into_inner()) = None;
        // 收口时清空注入错误（已被前端看到或已无意义）
        self.notify.take_inject_err();
        *self
            .last_outbound_error
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = None;
        self.emit_changed();
        Ok(())
    }

    /// 当前会话 id 是否等于给定值（收口按 session id 判定，避免重连时被旧任务按 peer 误杀）。
    pub fn session_id_is(&self, id: &str) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        matches!(inner.session.as_ref(), Some(s) if s.id == id)
    }

    /// 流断开 / 对端消失时本地收口：只清**该 session id** 的会话，避免误杀同 peer 的新会话。
    pub async fn force_end_if_session(&self, session_id: &str, reason: &str) {
        let should = {
            let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            matches!(inner.session.as_ref(), Some(s) if s.id == session_id)
        };
        if !should {
            return;
        }
        log::info!("[RC] 强制结束会话（{session_id}）：{reason}");
        let _ = self.end_session(reason).await;
    }

    /// 该 peer 是否有一场**活跃**（Pending/Outbound/Inbound Active 任一）会话。
    /// 自动重连任务睡醒后用它判断「是不是已经不用我重连了」。
    fn has_session_with(&self, peer: &str) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        matches!(inner.session.as_ref(), Some(s) if s.peer == peer && is_active(s.phase))
    }

    /// Q6：用户手动发起时清自动重连 episode（含 gave_up 残留横幅）。
    /// `pub`：commands::rc_request_session（rc 模块外）在用户动作入口调用。
    pub fn clear_auto_reconnect(&self) {
        *self.auto_reconnect.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    /// 🔴 D12（2026-09-22 审计）：等这一轮重连**落地**，返回是否成功。
    ///
    /// # 为什么必须等
    ///
    /// [`RcService::request_session`] 是非阻塞的：它把会话落到 `OutboundPending`
    /// 就返回 `Ok`，拨号在后台任务里跑。旧实现的重试循环见 `Ok` 就 `return`，
    /// 于是——**第一次尝试永远「成功」**，循环体的第二次、第三次尝试与末尾的
    /// `gave_up` 全是死代码。真实症状是：免确认设备断线后横幅显示「重连中 1/3」，
    /// 拨号在 200ms 后失败（对端还没回来），横幅当场消失，用户以为自动重连
    /// 成功了；`gave_up`（「自动重连失败」）永远不会出现。
    ///
    /// # 判据只看会话槽位，不看 `last_outbound_error`
    ///
    /// 错误槽是全局单值、多个发起路径共用，按它归因会互相踩（用户手动发起的
    /// 失败会被误算成重连失败）。会话槽位带 id，归因是准的：
    /// - 槽里还是本 id 且 phase 已 `Active` → **成功**；
    /// - 槽里已不是本 id（被拨号失败分支清掉 / 被换成别的会话）→ 本轮结束，`false`；
    /// - 到窗口上限仍是 `OutboundPending`（拨号还在跑）→ 也回 `false`：
    ///   下一轮循环顶部的 `has_session_with` 会兜住「迟到的成功」，
    ///   而它若真的失败，那时槽已清、重试照常发生。**不存在两边都漏的组合。**
    ///
    /// 窗口参数开放给单测（生产调用走 [`RECONNECT_SETTLE_POLLS`]）。
    pub(in crate::rc) async fn reconnect_round_settled_with(
        &self,
        session_id: &str,
        polls: u32,
        poll_ms: u64,
    ) -> bool {
        for _ in 0..polls {
            tokio::time::sleep(std::time::Duration::from_millis(poll_ms)).await;
            let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            match inner.session.as_ref() {
                // 还是本场会话：只有进 Active 才算落地
                Some(s) if s.id == session_id => {
                    if is_active(s.phase) {
                        return true;
                    }
                }
                // 槽位易主或已空：本轮已经没有可等的东西了
                _ => return false,
            }
        }
        false
    }

    /// 生产口径的一轮落地等待（见 [`Self::reconnect_round_settled_with`]）。
    async fn reconnect_round_settled(&self, session_id: &str) -> bool {
        self.reconnect_round_settled_with(
            session_id,
            RECONNECT_SETTLE_POLLS,
            RECONNECT_SETTLE_POLL_MS,
        )
        .await
    }

    /// 收口前取一场会话的（能力、设备名），供自动重连发起点用。
    /// 只认 session id（与 `session_id_is` 同一纪律：不按 peer 认领）。
    pub(in crate::rc) fn session_brief_if(
        &self,
        session_id: &str,
    ) -> Option<(Capability, String)> {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.session.as_ref().filter(|s| s.id == session_id).map(|s| {
            (s.capability, s.peer_name.clone())
        })
    }

    /// Q6：免确认设备异常断流后自动重连（发起端）。
    ///
    /// 只在**异常断流**路径调用（画面流 Err）——用户主动结束 / 对端主动结束 /
    /// TTL 到期都不会走到这，那三种情况默默再敲门是骚扰。逐次确认（非免确认）
    /// 的设备也不进：每次申请都要对方点头，自动连发等于骚扰对方。
    ///
    /// episode 自带重试循环（2s/4s/6s），期间用户任何手动动作（发起/结束）都会
    /// 清状态、任务睡醒后看到状态没了就退出——不需要 AbortHandle。
    pub fn begin_auto_reconnect(self: &Arc<Self>, peer: &str, peer_name: String, cap: Capability) {
        if !self.device_trusted(peer) {
            log::debug!("[RC] 对端未开免确认，断线后不自动重连");
            return;
        }
        let epoch = self
            .reconnect_epoch
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        {
            let mut st = self.auto_reconnect.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(s) = st.as_ref() {
                if s.peer == peer && !s.gave_up {
                    // episode 已在跑（任务自己在循环重试），不叠加第二个
                    return;
                }
            }
            *st = Some(AutoReconnect {
                peer: peer.to_string(),
                peer_name,
                capability: cap,
                attempt: 0,
                max: RECONNECT_MAX_ATTEMPTS,
                gave_up: false,
                epoch,
            });
        }
        self.emit_changed();
        let svc = Arc::clone(self);
        let peer = peer.to_string();
        tauri::async_runtime::spawn(async move {
            for attempt in 1..=RECONNECT_MAX_ATTEMPTS {
                let delay = RECONNECT_BASE_DELAY_MS * attempt as u64;
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                // 睡醒先核对 episode 还归不归我管：状态被清、被换成新 episode
                //（代次不同）都算易主。只认 peer 不认代次的话，旧任务会在
                // 「手动重连成功又断流」后收养新 episode，双任务并行重试。
                let still_mine = {
                    let st = svc.auto_reconnect.lock().unwrap_or_else(|p| p.into_inner());
                    matches!(st.as_ref(), Some(s) if s.peer == peer && s.epoch == epoch && !s.gave_up)
                };
                if !still_mine {
                    return;
                }
                if svc.has_session_with(&peer) {
                    // 用户已手动重连上 → episode 完成
                    *svc.auto_reconnect.lock().unwrap_or_else(|p| p.into_inner()) = None;
                    svc.emit_changed();
                    return;
                }
                // 进度给 UI：attempt 写回状态再 emit，横幅显示「第 N/M 次」
                {
                    let mut st = svc.auto_reconnect.lock().unwrap_or_else(|p| p.into_inner());
                    if let Some(s) = st.as_mut() {
                        s.attempt = attempt;
                    }
                }
                svc.emit_changed();
                log::info!("[RC] 自动重连第 {attempt}/{RECONNECT_MAX_ATTEMPTS} 次：{peer}");
                // 自动重连只发生在「已经建立过会话」的设备上（免确认白名单成员），
                // 永远不走无人值守凭证那两条路——码是一次性的不该烧，密码是
                // 本机长期秘密、发起侧根本没有它（重连靠的是白名单信任）。
                match svc.request_session(&peer, cap, None, None).await {
                    // 🔴 D12：`Ok` 只代表**申请已受理**，拨号还在后台跑。必须等它
                    // 落地再决定——旧实现见 Ok 就 return，于是第一圈无论成败都
                    // 「成功」，第二次/第三次尝试与末尾的 gave_up 全是死代码。
                    Ok(sess) => {
                        if svc.reconnect_round_settled(&sess.id).await {
                            // 真的连上了。episode 到此交棒：之后若画面再断，
                            // 断流路径会重新 begin（attempt 重新计数——每次
                            // 「成功重连后再断」是新一轮故障，理应给满重试）。
                            log::info!("[RC] 自动重连成功（第 {attempt} 轮）：{peer}");
                            *svc.auto_reconnect.lock().unwrap_or_else(|p| p.into_inner()) = None;
                            svc.emit_changed();
                            return;
                        }
                        log::warn!(
                            "[RC] 自动重连第 {attempt}/{RECONNECT_MAX_ATTEMPTS} 轮未落地（会话未激活）"
                        );
                    }
                    Err(e) => log::warn!("[RC] 自动重连第 {attempt} 次失败：{e}"),
                }
            }
            // 次数用尽：保留 gave_up 状态给 UI「自动重连失败」，用户手动动作时清
            {
                let mut st = svc.auto_reconnect.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(s) = st.as_mut() {
                    if s.peer == peer {
                        s.gave_up = true;
                    }
                }
            }
            svc.emit_changed();
        });
    }

    /// 会话是否超过 TTL（推流循环每圈检查）。
    pub fn session_expired(&self) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        match inner.session.as_ref() {
            Some(s) if is_active(s.phase) => {
                now_ms() - s.started_ms > SESSION_TTL_MS
            }
            _ => false,
        }
    }

    pub fn require_active(&self) -> Result<Session, String> {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        match inner.session.as_ref() {
            Some(s) if is_active(s.phase) => Ok(s.clone()),
            Some(_) => Err("会话尚未建立".into()),
            None => Err("没有进行中的远程会话".into()),
        }
    }

    pub fn must_show_banner(&self) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        matches!(
            inner.session.as_ref(),
            Some(s) if s.phase == SessionPhase::InboundActive
        )
    }
}
