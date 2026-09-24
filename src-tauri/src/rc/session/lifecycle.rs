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
use crate::rc::service::{AutoReconnect, RcService};
use super::{
    is_active, Session, RECONNECT_BASE_DELAY_MS, RECONNECT_MAX_ATTEMPTS,
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
        // 🔴 P1-3：返回值不再丢掉——重试一次仍失败的项要走到用户眼前（见下面上报处）。
        let release_failures = {
            let mut g = self.pressed.lock().unwrap_or_else(|p| p.into_inner());
            g.release_all()
        };
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
        // 🔴 P1-3（2026-09-23 审计）：释放「被按住的输入」失败的兜底上报。
        //
        // 顺序有讲究：必须排在上面那行 `take_inject_err()` **之后**。`set_inject_err`
        // 走的是同一条 `rc-inject-error` 通道（lib.rs 的回调取走即清），排在前面
        // 会被这一句顺手清掉——失败又变成只有日志看得见。
        //
        // 为什么这值得弹一条 toast：up 注入失败 = 本机 Ctrl/Shift/鼠标键**卡在
        // 按下态**，用户接下来的每一次本地操作都是错的，而且没有任何自动恢复路径。
        if !release_failures.is_empty() {
            let list = release_failures
                .iter()
                .map(|f| format!("{}（{}）", f.what, f.error))
                .collect::<Vec<_>>()
                .join("、");
            log::error!("[RC] 会话收口时释放按住的输入失败：{list}");
            self.notify.set_inject_err(format!(
                "释放被按住的输入失败：{list}（已重试一次仍未成功，若本机键鼠手感异常，请手动按一下对应键）"
            ));
        }
        // 🔴 P1-4：清失败槽按 **peer** 条件化。无条件清会让「结束 A 的会话」把
        // B 的发起失败横幅一起抹掉——那是另一台设备、另一场申请的失败。
        {
            let mut g = self
                .last_outbound_error
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if g.as_ref().is_some_and(|e| e.peer == peer) {
                *g = None;
            }
        }
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

    /// 🔴 P1-1（2026-09-23 审计）：本机**正在被远程控制**时返回那场会话的 id。
    ///
    /// 为什么只看 `InboundActive`：关「允许被远程」这个开关要收掉的是
    /// 「别人正在控我」这条入站会话。用户自己发起的出站会话（我在控别人）
    /// 与这个开关无关——拨过去关自己这边的开关，不该把对方的画面断掉。
    ///
    /// 为什么交 id 而不是直接在服务层收口：收口必须按 session id 认领
    /// （见 [`Self::force_end_if_session`] 的 A2 教训），命令入口拿到 id 之后
    /// 会话可能已经换了，那时 force_end 自己会 no-op。
    pub fn inbound_active_session_id(&self) -> Option<String> {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner
            .session
            .as_ref()
            .filter(|s| s.phase == SessionPhase::InboundActive)
            .map(|s| s.id.clone())
    }

    /// 🔴 P1-1：某台设备**占着会话槽**时返回它的 id（**不看 phase**，含未激活的
    /// `OutboundPending`）。
    ///
    /// 为什么这里要放宽到 Pending（与上面的 `inbound_active_session_id` 相反）：
    /// 调用方是「忘记这台设备」——撤销信任后，**正在拨的那一通也不该继续**，
    /// 否则会出现「表里已经没这台机器、画面却连上了」。而 `end_session` 对
    /// Pending 同样成立（发 End、清句柄、落历史），收口没有phase要求。
    /// 拨号任务那边靠 `session_id_is` 自查，会自己把迟到的流句柄丢掉。
    pub fn session_id_for_peer(&self, peer: &str) -> Option<String> {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner
            .session
            .as_ref()
            .filter(|s| s.peer == peer)
            .map(|s| s.id.clone())
    }

    /// 🔴 P1-5（2026-09-23 审计）：被控端 — 发起端是否已经失联（半开链路）。
    ///
    /// 证据是 `StreamCfg` 的 `last_activity_ms`（经 `RcService::last_activity_ms`
    /// 读出）：每一条入站输入/心跳都会刷它。注意这与
    /// `should_pause_stream`（3.5s）不是同一件事——那个只是**省带宽**的暂停，
    /// 这一条才是收口：半开连接（对端进程被杀、拔网线、笔记本合盖）下
    /// QUIC 不会立刻报错，此前只有 2 小时的 TTL 兜底，横幅能挂两个小时。
    ///
    /// 🔴 C3：三个时间全是单调钟口径（`mono_ms`）——证据锚、会话起点、现在。
    /// 混墙钟会让系统时间一跳就把在用会话判死（或反向让死链永不断）。
    ///
    /// 锁序 stream → inner（与 `status()` 一致，见那边 D6 的 ABBA 说明）。
    pub fn inbound_heartbeat_stale(&self) -> bool {
        let evidence = self.last_activity_ms();
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        match inner.session.as_ref() {
            Some(s) if s.phase == SessionPhase::InboundActive => {
                crate::rc::link::link_stale_kick(
                    s.started_mono,
                    evidence,
                    crate::rc::mono::mono_ms(),
                    crate::rc::link::LINK_STALE_KICK_MS,
                )
            }
            _ => false,
        }
    }

    /// 🔴 P1-5：发起端 — 被控端是否已经失联（同一判据的镜像侧）。
    ///
    /// 证据取 `max(attached_ms, last_pong_ms)`：pong 是链路活性的唯一证据，
    /// 而一条 pong 都还没收到时用「连接登记时刻」当锚点（不用 `started_ms`——
    /// 拨号本身最长 15 秒，拿申请时刻当锚点会让慢连接刚建好就被踢）。
    ///
    /// 🔴 C3：attached/pong 已在 link.rs 内改存单调时刻，与会话的 `started_mono`
    /// 同基座，无需换算。
    ///
    /// 锁序 link → inner，同上。
    pub fn outbound_heartbeat_stale(&self) -> bool {
        // 活性证据取三个来源的**最大值**（任一成立即算活着）：
        // - `attached_ms`：连接刚登记（会话建好但还没收到任何东西）的宽限期；
        // - `last_pong_ms`：心跳往返——**依赖发起端前端 UI 每秒发 ping**；
        // - `last_inbound_ms`：任何入站帧（画面/控制帧）——**不依赖前端**。
        //
        // 🔴 2026-09-23（v7.2.5 回归修复）：原先只有前两个。`last_pong_ms` 被
        //    `RcFrame` 里同 tag 的死变体吞掉后恒为 0（详见 `protocol.rs` 尾注），
        //    而 `attached_ms` 只在拨号时写一次——于是这场会话的"证据"在建立后
        //    就静止了，15 秒后必然判失联。补第三个来源同时堵住了另一条同类路径：
        //    ping 由前端发，UI 一旦停摆就会再次误踢真活着的会话。
        let evidence = crate::rc::link::heartbeat_evidence(
            self.link.attached_ms(),
            self.link.last_pong_ms(),
            self.link.last_inbound_ms(),
        );
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        match inner.session.as_ref() {
            Some(s) if s.phase == SessionPhase::OutboundActive => crate::rc::link::link_stale_kick(
                s.started_mono,
                evidence,
                crate::rc::mono::mono_ms(),
                crate::rc::link::LINK_STALE_KICK_MS,
            ),
            _ => false,
        }
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
    ///
    /// 🔴 C3：判据收口到 [`ttl_expired`]，两个时间都是单调口径——
    /// 墙钟跳变不再能把 2 小时的 TTL 变成秒级误杀或永久豁免。
    pub fn session_expired(&self) -> bool {
        self.session_expired_with(crate::rc::mono::mono_ms())
    }

    /// 假时钟入口（单测注入「现在」）；生产走 [`Self::session_expired`]。
    pub(in crate::rc) fn session_expired_with(&self, now_mono: i64) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        match inner.session.as_ref() {
            Some(s) if is_active(s.phase) => super::ttl_expired(s.started_mono, now_mono),
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
