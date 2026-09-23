//! 被控侧连接主循环：handle_inbound_conn / clear_pending。
//!
//! 2026-09-22 从 `service.rs` 平移（体量合规）。`use crate::rc::*` 沿用
//! `service/mod.rs` 的全部名字；方法体未改动，仅 `pub(super)` 方法
//! 升级为 `pub(in crate::rc)`（原语义就是「rc 子树可见」）。

use super::*;

impl RcService {
    /// 入站连接（本模块 accept_loop 调用）。
    pub async fn handle_inbound_conn(&self, conn: iroh::endpoint::Connection) {
        use crate::sync::transport::{read_frame, write_frame};

        let peer = conn.remote_id().to_string();
        let short = peer[..8.min(peer.len())].to_string();
        let Ok(w) = crate::sync::transport::accept_streams(conn).await else {
            log::warn!("[RC] {short} 开流失败");
            return;
        };
        // 留一份连接 handle：批准之后要拿它读「对方是从哪条路进来的」（`link.rs`）。
        // 必须在解构之前 clone——`w.send` / `w.recv` 一旦移出就不能再碰 `w`。
        let link_conn = w.conn.clone();
        let mut send = w.send;
        let mut recv = w.recv;

        let Ok(bytes) = read_frame(&mut recv).await else {
            // 连接已断，写 Deny 也到不了——只能记日志，不能静默（规则 #15.3）
            log::warn!("[RC] {short} 读申请帧失败，连接已断");
            return;
        };
        // 对端把 Request 送到了 = 它在线。刷 last_seen，跨网时设备列表才亮得起来。
        let _ = self.store.rc_device_touch(&peer, true);
        let (requested, uno_code, uno_pass, peer_dgram, peer_audio) = match RcFrame::decode(&bytes) {
            Ok(RcFrame::Request {
                capability,
                uno_code,
                uno_pass,
                vid_dgram,
                audio,
            }) => (
                capability,
                uno_code,
                uno_pass,
                vid_dgram == Some(true),
                audio == Some(true),
            ),
            Ok(_) => {
                deny_and_close(&link_conn, &mut send, "期望 Request 帧", "not_request").await;
                return;
            }
            Err(e) => {
                log::warn!("[RC] {short} 帧解码失败：{e}");
                deny_and_close(&link_conn, &mut send, "对端协议帧无法识别", "bad_request").await;
                return;
            }
        };

        let mut uno_admitted = false;
        // 未配对（远程/同步都没有）：
        // 带了无人值守接入码（Q2 方案 B）→ 验码，通过 = 自动配对 + 自动同意；
        // 带了固定密码（Q2 方案 C）→ 验密 + 限速闸，通过 = 同上；
        // 都没带 → 走邀请门/敲门老路，等人核对指纹。
        if !self.has_remote_trust(&peer) {
            let now = now_ms();
            match (uno_code.as_deref(), uno_pass.as_deref()) {
                (Some(code), _) => match self.uno_admit(&peer, requested, code, now) {
                    UnoAdmit::Admitted => uno_admitted = true,
                    UnoAdmit::Denied(reason, deny_code) => {
                        deny_and_close(&link_conn, &mut send, &reason, &deny_code).await;
                        log::info!("[RC] {short} 无人值守接入被拒：{reason}");
                        return;
                    }
                },
                (None, Some(pass)) => {
                    // 局域网判定在这里做（函数要拿连接），准入逻辑收进纯函数可测的
                    // `pass_admit`（`rc/tests.rs` 直接打它）。
                    let is_lan =
                        crate::sync::path_kind::of_conn(&link_conn) == crate::sync::path_kind::PathKind::Lan;
                    match self.pass_admit(&peer, requested, pass, is_lan, now) {
                        UnoAdmit::Admitted => uno_admitted = true,
                        UnoAdmit::Denied(reason, deny_code) => {
                            deny_and_close(&link_conn, &mut send, &reason, &deny_code).await;
                            log::info!("[RC] {short} 固定密码接入被拒：{reason}");
                            return;
                        }
                    }
                }
                (None, None) => {
                    // 🔴 **判据交给纯函数**（[`join::deny_unpaired`]），因为「几种成因的区分」
                    //   正是 2026-09-17 修的那个 bug：原先除「门开着且敲门成功」外全部塌缩成一句
                    //   `not_paired`（「尚未远程配对」），而用户实际撞到的**几乎总是窗口过期**——
                    //   那句话指不到「回去重新生成一个」这个唯一正确的动作，
                    //   于是他只能反复重试同一个已经失效的窗口。
                    //   而 accept 循环（网络）在单测里跑不起来 ⇒ 判据必须抽出去才测得动。
                    //
                    //   文案由 `KnockDenial::reason()` 提供，**一律站在收到这句话的人的立场**
                    //   （他是发起方 B，对面是生成方 A），与 `Gate::deny_reason` 的既有约定一致。
                    //
                    // 红线「未启用 = 零可见零请求零费用」：rc_enabled 关闭时，即便邀请门开着，
                    // 也不记入 pending、不 emit，只回 deny（门禁在下方 gate_inbound 也会拦，
                    // 但这里先挡住，避免禁用期间出现可见的配对请求）。
                    match join::deny_unpaired(
                        self.enabled(),
                        join::door_open(&self.store, now),
                        self.joins.is_denied(&peer, now),
                    ) {
                        Some(d) => {
                            deny_and_close(&link_conn, &mut send, d.reason(), d.code()).await;
                            log::info!("[RC] {short} 敲门被拒：{}", d.log_label());
                        }
                        None => {
                            self.joins.knock(&peer, now);
                            deny_and_close(
                                &link_conn,
                                &mut send,
                                "等待对方确认配对",
                                "await_pair_confirm",
                            )
                            .await;
                            log::info!("[RC] {short} 敲门配对，已记入待确认");
                            self.emit_changed();
                        }
                    }
                    return;
                }
            }
        }

        if !uno_admitted {
            let gate = {
                let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
                gate_inbound(
                    self.enabled(),
                    self.max_capability(),
                    &self.device_deny(),
                    &peer,
                    self.has_remote_trust(&peer),
                    requested,
                    inner.session.is_some(),
                )
            };
            if gate != Gate::Allow {
                deny_and_close(&link_conn, &mut send, gate.deny_reason(), gate.deny_code()).await;
                log::info!("[RC] 拒绝 {short}：{}", gate.deny_reason());
                return;
            }

            // 方案 D「免确认直连」：门禁全绿（含 deny 检查——DeviceDenied 根本到不了
            // Allow）且这台设备开了免确认 ⇒ 直接落会话。下面的等待循环 200ms 内
            // 看到 `InboundActive` 就回 Accept，对端体感是「连上就进」。
            // 自动接受失败（唯一现实成因是并发下本机已有会话）不静默，
            // 也不硬拒——落回人工确认，让人看见再说。
            let auto_accepted = if self.device_trusted(&peer) {
                let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
                match self.establish_inbound_with(
                    &mut inner,
                    &peer,
                    self.peer_name(&peer),
                    requested,
                    InboundTrust::Whitelist,
                ) {
                    Ok(_) => {
                        log::info!("[RC] {short} 来自免确认设备，自动接受");
                        true
                    }
                    Err(e) => {
                        log::warn!("[RC] {short} 免确认自动接受失败（{e}），转入人工确认");
                        false
                    }
                }
            } else {
                false
            };

            if !auto_accepted {
                let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
                if !inner.pending.iter().any(|k| k.peer == peer) {
                    // 🔴 D10（2026-09-22 审计）：待确认表是**无上限**的。灌它的前提
                    // 是「已配对设备」（`gate_inbound` 的 paired 那条），而按 peer
                    // 去重又挡住同一台设备连发，所以现实中要撑爆得先凑够一批已配对
                    // 的 id——是个假想面，不是当前可达的攻击面。但「无上限」这件事
                    // 不该留在代码里靠推理成立，加一道硬闸。
                    //
                    // 满了丢**最早**那条而不是拒新的：拒新的会让用户看到「我点了
                    // 确认却什么都没发生」；而最早那条按 120s 窗口本来也已经快失效、
                    // 用户多半不会去点了。
                    if inner.pending.len() >= PENDING_KNOCK_MAX {
                        let dropped = inner.pending.remove(0);
                        log::warn!(
                            "[RC] {short} 待确认申请已满（{PENDING_KNOCK_MAX}），丢弃最早一条"
                        );
                        log::debug!("[RC] 被丢弃的待确认申请来自 {}", dropped.peer);
                    }
                    inner.pending.push(InboundKnock {
                        peer: peer.clone(),
                        peer_name: self.peer_name(&peer),
                        // display_name 由 status() 投影时从配对表回填，构造处留空。
                        display_name: String::new(),
                        capability: requested,
                        first_seen_ms: now_ms(),
                    });
                }
            }
        }
        // 有申请进来立刻通知前端（窗口隐藏时也能 toast）
        self.emit_changed();

        let deadline = now_ms() + 120_000;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            // 🔴 超时判定必须放在 decision **之后**（2026-09-20 审计 P1-2）：
            // 原先超时检查在读取会话之前，批准落在最后 <200ms 窗口时——
            // approve_inbound 已建会话、pending 已删，这里却先按超时把连接
            // deny_and_close 掉：会话槽是活跃态但推流任务永不执行，且这个
            // 僵尸会话没有任何看门者（TTL 检查只存在于视频循环里），
            // 横幅卡「被控中」直到手动结束。
            let decision = {
                let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
                // 先在不可变借用里判状态、出借后再写标记（推流所有权的
                // 判定与置位必须在同一把锁里完成，否则双循环都能抢到）。
                let verdict = match inner.session.as_ref() {
                    Some(s) if s.peer == peer && s.phase == SessionPhase::InboundActive => {
                        if inner.inbound_streaming {
                            Some(Err("already_streaming"))
                        } else {
                            Some(Ok(s.capability))
                        }
                    }
                    Some(s) if s.peer != peer => Some(Err("busy")),
                    Some(_) => None,
                    None => {
                        if !inner.pending.iter().any(|k| k.peer == peer) {
                            Some(Err("denied"))
                        } else {
                            None
                        }
                    }
                };
                // 抢到推流所有权：出借结束后置位（P2-1 双连接守卫）
                if matches!(verdict, Some(Ok(_))) {
                    inner.inbound_streaming = true;
                }
                verdict
            };
            match decision {
                Some(Ok(cap)) => {
                    // 自报本机系统：控制端记进设备行，它的设备详情才说得出
                    // 「Windows 11」。采不到时 `local_os_label` 返回空串，
                    // 对端按「没带」处理、不覆盖它已有的值。
                    let accept = RcFrame::Accept {
                        capability: cap,
                        os: Some(crate::rc::local_os_label()),
                    };
                    if let Ok(b) = accept.encode() {
                        let _ = write_frame(&mut send, &b).await;
                    }
                    // 用户批准、会话真的建立：登记连接，被控端也能看到「对方是从
                    // 局域网还是绕中继进来的」。此处不持有 inner 锁（上面那个
                    // decision 块已结束），与 `status()` 的加锁顺序一致。
                    self.link.attach(&link_conn);
                    // R1：推 JPEG 画面直到会话结束（conn 一并交给推流任务：
                    // 鼠标数据报读取 + stats 采样都挂在它身上）
                    super::inbound_accept::spawn_inbound_video(&peer, send, recv, link_conn, peer_dgram, peer_audio).await;
                    return;
                }
                Some(Err("already_streaming")) => {
                    // 输掉推流所有权的重复连接：安静收掉即可，不算拒绝。
                    // 对端若在这条连接上等 Accept，收到的关闭理由是会话已被
                    // 另一条连接接管——它的真实会话仍然活着。
                    log::info!("[RC] {short} 重复连接：会话已由另一条连接接管，关闭本条");
                    let _ = send.finish();
                    link_conn.close(0u32.into(), b"session taken");
                    self.clear_pending(&peer);
                    return;
                }
                Some(Err(_)) => {
                    deny_and_close(
                        &link_conn,
                        &mut send,
                        "对方拒绝或会话被占用",
                        "rejected_or_busy",
                    )
                    .await;
                    self.clear_pending(&peer);
                    return;
                }
                None => {
                    // 只有「还在等」才允许超时（P1-2 修正：超时判定移到 decision 之后）
                    if now_ms() > deadline {
                        self.clear_pending(&peer);
                        deny_and_close(&link_conn, &mut send, "等待确认超时", "confirm_timeout")
                            .await;
                        return;
                    }
                    continue;
                }
            }
        }
    }

    fn clear_pending(&self, peer: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.pending.retain(|k| k.peer != peer);
    }
}
