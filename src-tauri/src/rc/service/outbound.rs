//! 发起侧：request_session / probe / dial_and_request。
//!
//! 2026-09-22 从 `service.rs` 平移（体量合规）。`use crate::rc::*` 沿用
//! `service/mod.rs` 的全部名字；方法体未改动，仅 `pub(super)` 方法
//! 升级为 `pub(in crate::rc)`（原语义就是「rc 子树可见」）。

use super::*;

impl RcService {
    /// 非阻塞发起远程：立刻落 OutboundPending 并返回，dial 在后台跑。
    /// 前端可立即展示等待 UI 并取消；结果经 `rc-session-changed` / `outbound_error` 回传。
    pub async fn request_session(
        &self,
        peer: &str,
        capability: Capability,
        uno_code: Option<String>,
        uno_pass: Option<String>,
    ) -> Result<Session, String> {
        // 无人值守（Q2 方案 B 码 / 方案 C 密码）：带凭证发起就是「未配对机器」
        // 的路径，白名单前置检查必须让位；空串视同没带。
        let uno_code = uno_code
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let uno_pass = uno_pass
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let with_cred = uno_code.is_some() || uno_pass.is_some();
        let (session_id, pending_sess) = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            if gate_outbound(inner.session.is_some()) == Gate::Busy {
                return Err("[busy_local] 已有进行中的远程会话，请先结束".into());
            }
            if !with_cred && !self.has_remote_trust(peer) {
                return Err(
                    "[not_paired] 尚未完成远程配对：请先在远程电脑设置里配对这台设备".into(),
                );
            }
            if !self.is_running() {
                return Err("[channel_down] 远程通道未启动：请先开启远程通道或完成远程配对".into());
            }
            // 同步设备首次发起远程 → 写入 rc_devices（方案 A）
            if !with_cred {
                if let Err(e) = self.elevate_from_sync(peer) {
                    log::warn!("[RC] 从同步配对提升到远程失败：{e}");
                }
            }
            let id = new_session_id(now_ms());
            let sess = Session {
                id: id.clone(),
                peer: peer.to_string(),
                peer_name: self.peer_name(peer),
                // display_name 由 status() 投影时从配对表回填，构造处留空。
                display_name: String::new(),
                capability,
                phase: SessionPhase::OutboundPending,
                started_ms: now_ms(),
                started_mono: crate::rc::mono::mono_ms(),
                granted: false,
            };
            inner.session = Some(sess.clone());
            (id, sess)
        };
        {
            // 🔴 P1-4（2026-09-23 审计）：只清**同一台设备**的旧失败。无条件清会让「去点 B」把 A 的
            // 失败横幅抹掉——A 的错误用户还没看到就没了，而它跟 B 这次申请无关。
            let mut g = self
                .last_outbound_error
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if g.as_ref().is_some_and(|e| e.peer == peer) {
                *g = None;
            }
        }
        // 立刻让前端看到 Pending，取消按钮才能点
        self.emit_changed();

        let peer = peer.to_string();
        tauri::async_runtime::spawn(async move {
            let Some(svc) = global() else { return };
            match svc
                .dial_and_request(&peer, capability, uno_code.clone(), uno_pass.clone())
                .await
            {
                Ok((accepted_cap, conn, send, recv)) => {
                    // 会话是否已经不在（用户点了取消，或已被换成了另一场会话）。
                    // ❗ 这里**不能**在持 inner 锁的块里 return 并顺手 detach：
                    //    `link.detach()` 与 `status()` 的加锁顺序相反，会构成 ABBA 死锁。
                    let cancelled = {
                        let mut inner = svc.inner.lock().unwrap_or_else(|p| p.into_inner());
                        match inner.session.as_mut() {
                            Some(sess) if sess.id == session_id => {
                                sess.phase = SessionPhase::OutboundActive;
                                sess.capability = accepted_cap;
                                sess.granted = true;
                                false
                            }
                            _ => true,
                        }
                    };
                    if cancelled {
                        // 用户已取消：先把链路句柄收掉，再关掉刚建好的流。
                        // 交回的路径/网速在这里没有意义（会话根本没成立），显式丢弃。
                        let _ = svc.link.detach();
                        drop(send);
                        drop(recv);
                        // conn 同旧版为等价处理：没人再持有它（连接悬着由会话收口兜底），
                        // 没有显式 close 是刻意的——close 理由会进对端日志，别在「本端取消」
                        // 这条路径上给对端制造一条需要解释的关闭帧。
                        drop(conn);
                        return;
                    }
                    // B-b：会话在对端获批 = 首次远程信任确认。发起侧同步写入
                    // rc_devices（对端 approve 时也会 elevate 它自己那份），
                    // 之后双向文件通道与免确认才都有行可查。
                    if let Err(e) = svc.elevate_from_sync(&peer) {
                        log::warn!("[RC] 发起侧 elevate 失败：{e}");
                    }
                    let _ = svc.store.rc_device_touch(&peer, true);
                    // Q2：无人值守接入成功（码或密码）= 发起侧也把这台写进自己的
                    // rc_devices（被控侧在验凭证时已经写了它那份）。之后这台设备
                    // 就是普通配对设备：改名 / 免确认 / 遗忘都走既有管理面。
                    if with_cred {
                        let name = {
                            let n = svc.peer_name(&peer);
                            if n.is_empty() { "新设备".to_string() } else { n }
                        };
                        if let Err(e) = svc.store.rc_device_pair(&peer, &name) {
                            log::warn!("[RC] 接入码连入成功，但发起侧写设备列表失败：{e}");
                        }
                    }
                    svc.clear_frame();
                    svc.clear_outbox();
                    #[cfg(target_os = "windows")]
                    svc.audio_reset();
                    svc.note_rtt(0);
                    // 🔴 取消竞态收口（2026-09-20 审计 P2-3）：从 cancelled 判定到
                    // 写槽之间隔着 store 写盘等 await 点，用户恰好取消时——
                    // end_session 写 End 时槽位还是 None（对端收不到 End），
                    // 随后句柄仍被写回成僵尸。写槽前再查一次会话 id；
                    // 仍存在的残余窗口（查完到写完之间收口）不足 1ms，
                    // 且僵尸句柄会被下一场会话的写槽覆盖、end_session 也会清。
                    if svc.session_id_is(&session_id) {
                        *svc.outbound_send.lock().await = Some(send);
                        *svc.outbound_conn.lock().await = Some(conn.clone());
                        svc.spawn_outbound_video(&peer, recv, conn);
                    } else {
                        log::info!("[RC] 会话在建立途中已被取消，丢弃刚建好的流句柄");
                        drop(send);
                        drop(recv);
                        drop(conn);
                    }
                    svc.emit_changed();
                }
                Err(e) => {
                    {
                        let mut inner = svc.inner.lock().unwrap_or_else(|p| p.into_inner());
                        if let Some(s) = inner.session.as_ref() {
                            if s.id == session_id {
                                inner.session = None;
                            }
                        }
                    }
                    // `dial_and_request` 在连接通了之后就已经 attach（那时才可能走到
                    // Request 被拒），会话没建成 → 必须清掉，否则路径标签挂在死连接上。
                    // 交回的路径同样丢弃：一次失败的发起不该被记成「上次走的哪条路」。
                    let _ = svc.link.detach();
                    {
                        // 🔴 被拒 ≠ 通道故障（2026-09-23 复审）：Deny 是正当结局，
                        // 已有 requestEndNotice 的「拒绝了这个申请」toast 报过一次；
                        // 再写错误槽就是双重反馈，而且那条带着「重新发起」按钮——
                        // 刚被拒绝就怂恿用户重试，是错的引导。网络类失败照旧进槽。
                        let is_rejection = e.contains("拒绝");
                        if !is_rejection {
                            let mut g = svc
                                .last_outbound_error
                                .lock()
                                .unwrap_or_else(|p| p.into_inner());
                            // 🔴 P1-4：写进槽的一刻就把「是谁、哪一场」一起写进去。
                            // 归因只能在这里做——这是唯一同时握着 peer 与 session_id
                            // 的地方；到 status() 投影时只剩一句文案，谁都说不清是谁的失败。
                            *g = Some(RcOutboundError {
                                peer: peer.clone(),
                                session_id: session_id.clone(),
                                error: e,
                            });
                        }
                    }
                    svc.emit_changed();
                }
            }
        });

        Ok(pending_sess)
    }

    /// 前端显式确认过错误横幅 → 清掉它。
    ///
    /// 🔴 P1-4 之后槽里带归因，但**这个入口仍然全清**：它是「用户已经看到了」的
    /// 回执（`rc_clear_outbound_error`），不是某台设备的生命周期动作。按 peer 条件
    /// 清的是 `request_session` 与 `end_session` 那两处。
    pub fn clear_outbound_error(&self) {
        let mut g = self
            .last_outbound_error
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        *g = None;
    }

    /// 发起端：收 JPEG / 脏矩形 / 控制帧（实现在 `rc/outbound.rs`）。
    ///
    /// 🔴 **不再合成再编码**：整帧与脏块 JPEG 原样交给前端画布合成，
    /// 避免「网络传脏矩形、本机却整帧 clone + 二次 JPEG」的白做功。
    fn spawn_outbound_video(
        &self,
        peer: &str,
        recv: iroh::endpoint::RecvStream,
        conn: iroh::endpoint::Connection,
    ) {
        let Some(svc) = global() else { return };
        let Some(video) = crate::rc::outbound::OutboundVideo::try_new(svc, peer, recv, conn) else {
            log::warn!("[RC] 发起端画面流启动前会话已结束，放弃推流");
            return;
        };
        tauri::async_runtime::spawn(video.run());
    }

    /// 轻量探活：拨通即认为可达，立刻断开（不建会话、不发 Request）。
    ///
    /// # 🔴 2026-09-21：本方法**不再写任何库状态**
    ///
    /// 旧实现拨通后 `rc_device_touch(peer, true)`——这是「在线状态不准」的主因之一：
    /// - 探测结果是**「这一刻可达」的瞬时事实**，不是「在线」这个持久状态；
    /// - 它写的 `last_seen` 语义是「最后一次**在线**是什么时候」，
    ///   被探测刷新后，「上次在线：3 小时前」会变成「刚刚」，污染历史语义；
    /// - 用户点一下刷新 → 所有能拨通的设备集体续命 → 表现为「点一下就变在线」。
    ///
    /// 现在的结果**只回传给调用方**（`probe_peers` 的 `HashMap` → IPC → 前端），
    /// 由前端渲染成「本次探测可达」的**独立标记**，与在线状态分开显示。
    ///
    /// ❗ 别在这里"顺手"把 touch 加回来。在线状态的真源是三条证据
    /// （见 `session::is_rc_online_for`），不是探测结果。
    pub async fn probe_peer(&self, peer: &str) -> Result<(), String> {
        let Some((ep, presence)) = self.transport_ready() else {
            return Err("远程通道未启动".into());
        };
        let id = iroh::EndpointId::from_str(peer).map_err(|e| format!("node_id 解不开：{}", e))?;
        let mut addr = EndpointAddr::new(id);
        for sock in presence.addrs_of(peer, now_ms()) {
            addr = addr.with_ip_addr(sock);
        }
        let conn = tokio::time::timeout(std::time::Duration::from_secs(3), ep.connect(addr, ALPN))
            .await
            .map_err(|_| "探测超时".to_string())?
            .map_err(|e| format!("连不上：{}", e))?;
        // 探通立刻收：不占对端 accept 槽，也不进入 Request 流程
        conn.close(0u32.into(), b"probe");
        // ❗ 到这里**故意什么库都不写**：探测是瞬时事实，不是在线状态。
        //    写 last_seen 会污染「上次在线」语义并制造假在线（见上面 doc）。
        Ok(())
    }

    /// 批量探活：并发短超时拨，结果 node_id → 是否可达。
    /// 上限 8 台并行——自有设备列表远小于此；再大也是用户自己配的，超时仍 3s/台。
    pub async fn probe_peers(&self, peers: &[String]) -> std::collections::HashMap<String, bool> {
        use std::collections::HashMap;
        let mut out = HashMap::new();
        if peers.is_empty() {
            return out;
        }
        let chunk = 8usize;
        for batch in peers.chunks(chunk) {
            let mut futs = Vec::with_capacity(batch.len());
            for p in batch {
                let p = p.clone();
                // probe_peer 只借用 self；spawn 不了（要 'static），直接并发 future
                futs.push(async move { (p.clone(), self.probe_peer(&p).await.is_ok()) });
            }
            let results = futures_util::future::join_all(futs).await;
            for (id, ok) in results {
                out.insert(id, ok);
            }
        }
        out
    }

    async fn dial_and_request(
        &self,
        peer: &str,
        capability: Capability,
        uno_code: Option<String>,
        uno_pass: Option<String>,
    ) -> Result<
        (
            Capability,
            // 🔴 连接句柄必须交出去：发起端收流循环（`outbound.rs`）断流时要用
            //   `conn.close_reason()` 把「对端为什么关」拼回错误（见 `explain`）。
            //   原先它只在函数内活着，返回即 drop——收流侧只剩 `connection lost`。
            iroh::endpoint::Connection,
            iroh::endpoint::SendStream,
            iroh::endpoint::RecvStream,
        ),
        String,
    > {
        let Some((ep, presence)) = self.transport_ready() else {
            return Err("[channel_down] 远程通道未启动".into());
        };
        let id = iroh::EndpointId::from_str(peer)
            .map_err(|e| format!("[bad_node_id] node_id 解不开：{}", e))?;
        let mut addr = EndpointAddr::new(id);
        for sock in presence.addrs_of(peer, now_ms()) {
            addr = addr.with_ip_addr(sock);
        }

        // 🔴 拨号必须带超时（2026-09-20 审计 P2-4）：裸等在网络黑洞下会让
        // OutboundPending 挂死、占住 busy 闸，用户只能手动取消。15 秒对
        // 「绕中继 + 国内网络」是宽松上限（probe_peer 的 3 秒是给探测用的，
        // 正式拨号放一倍以上余量）。
        let conn = tokio::time::timeout(std::time::Duration::from_secs(15), ep.connect(addr, ALPN))
            .await
            .map_err(|_| "[connect_failed] 连接对端超时（15 秒）：对方可能不在线".to_string())?
            .map_err(|e| format!("[connect_failed] 连接对端失败：{}", e))?;
        let (mut send, mut recv) = conn
            .open_bi()
            .await
            .map_err(|e| format!("开流失败：{}", e))?;

        // 连接已通，先把句柄登记进去：会话进入 Active 之前界面就能报出路径档位
        // （「是不是绕中继」恰恰是用户连上之前最想知道的）。
        // 若随后 Request 被拒，调用方的错误分支会 `link.detach()` 清掉——
        // 那一处不能漏，漏了会残留一条僵尸连接的路径标签。
        self.link.attach(&conn);

        let req = RcFrame::Request {
            capability,
            uno_code,
            uno_pass,
            // 本端支持视频数据报；旧对端 serde 忽略未知字段，照常受理
            vid_dgram: Some(true),
            // G3：本端支持音频。会话中由 AudioOn 开关；被控端无渲染设备时自动无声
            audio: Some(true),
        };
        // ❗ 这一对读写的失败必须过 `explain`：对端要是以「未配对 / 忙 / 被禁」为由
        //   关掉连接，原始错误只会是 `读帧长度失败：connection lost`（见 `explain`）。
        crate::sync::transport::write_frame(&mut send, &req.encode()?)
            .await
            .map_err(|e| explain(&conn, e))?;
        let raw = crate::sync::transport::read_frame(&mut recv)
            .await
            .map_err(|e| explain(&conn, e))?;
        let resp = RcFrame::decode(&raw)?;
        match resp {
            RcFrame::Accept { capability, os } => {
                // 对端**自报的系统**：写进设备行，设备详情显示「在线 · Windows 11 · …」。
                // None / 空串（旧对端没这个字段，或它采不到）不覆盖已有值——
                // 升级前最后一次会话不该把设备行这一格抹白（同 `last_path` 的判据）。
                if let Some(os) = os {
                    let _ = self.store.rc_device_note_os(peer, &os);
                }
                Ok((capability, conn, send, recv))
            }
            RcFrame::Deny { reason, code } => {
                let code = code.unwrap_or_default();
                if code.is_empty() {
                    Err(reason)
                } else {
                    Err(format!("[{code}] {reason}"))
                }
            }
            other => Err(format!("对端回了意外的帧：{other:?}")),
        }
    }
}
