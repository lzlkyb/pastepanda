//! 状态投影（status）、通道启停（start/stop）、附近设备与历史。
//!
//! 2026-09-22 从 `service.rs` 平移（体量合规）。`use crate::rc::*` 沿用
//! `service/mod.rs` 的全部名字；方法体未改动，仅 `pub(super)` 方法
//! 升级为 `pub(in crate::rc)`（原语义就是「rc 子树可见」）。

use super::*;

impl RcService {
    pub fn status(&self) -> RcStatus {
        // C：路径自动切换（relay ↔ 直连）主动通知一次。
        // 放在取 `inner` 锁之前：通知会跑前端回调，不该在持锁期间做。
        // `take_path_change` 自带去重，多处 useRc 并发轮询时只会被消费一次。
        if let Some((from, to)) = self.link.take_path_change() {
            self.notify.emit_path_changed(from.as_str(), to.as_str());
        }
        // 🔴 D6（2026-09-22 审计）：显式把 `inner` 放掉，别依赖 NLL 的隐式丢弃点。
        //
        // 本函数在构造 `RcStatus` 的字段时要调 `self.link.*`（路径档位 / 最后 pong
        // / 帧率），而 link 侧存在「持 link 锁再取 inner」的路径（收口链 / emit 链）。
        // 现在 NLL 恰好在 `session` / `pending` 两个 clone 之后就不再需要 `inner`，
        // 顺序侥幸是 link→inner，暂无 ABBA；但「最后一次使用点」会随下一次编辑移动
        // ——只要有人往字段里多取一个 inner 的东西，或把 link 调用挪到 clone 之前，
        // 就变成持 inner 取 link。用作用域把顺序写成**显式**的，不再靠推断。
        let (session, pending, streaming) = {
            let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            (
                inner.session.clone(),
                inner.pending.clone(),
                // 自动档的「真实档位」只有**正在推流**时才存在：换档发生在推流
                // 循环里，会话没跑（或已结束）时 `tier` 只是上一场的残留。所以
                // 除了 auto_enabled，还必须要求本机正处在 inbound_active（本机推流）
                // ——否则界面会报一个早就不存在的档位，比不报还坏。
                inner
                    .session
                    .as_ref()
                    .is_some_and(|s| s.phase == SessionPhase::InboundActive),
            )
        };
        let running = self
            .running
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some();
        let quality = self
            .cfg()
            .get(CFG_QUALITY)
            .and_then(|v| v.as_str())
            .unwrap_or("auto")
            .to_string();
        let active_quality = if streaming && self.auto_enabled() {
            self.auto_tier_name()
        } else {
            quality.clone()
        };
        RcStatus {
            enabled: self.enabled(),
            capability: self.max_capability().as_str().to_string(),
            session,
            pending,
            joins: self.joins.list(now_ms()),
            uno: self.uno.active(now_ms()),
            uno_pass: unop::cfg_from(&self.cfg()).map(Into::into),
            device_deny: self.device_deny(),
            running,
            quality,
            active_quality,
            capture_scope: self
                .cfg()
                .get(CFG_CAPTURE_SCOPE)
                .and_then(|v| v.as_str())
                .unwrap_or("virtual")
                .to_string(),
            bitrate_pct: self.user_bitrate_pct_from_cfg(),
            rtt_ms: self.last_rtt_ms(),
            loss_permille: self
                .remote_loss_permille
                .load(std::sync::atomic::Ordering::Relaxed),
            path_kind: self.link.path_kind_str(),
            clock_skew_ms: self.clock_skew_ms(),
            peer_fps120: self.peer_fps120(),
            peer_hevc: self.peer_hevc(),
            peer_dgram_input: self.peer_dgram_input(),
            peer_refresh_hz: self.peer_refresh_hz(),
            peer_monitors: self
                .peer_monitors
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone(),
            last_pong_ms: self.link.last_pong_ms(),
            // clone 而非 take：Overlay/对话框/设置多处 useRc 并发轮询，take 会只有一处看见
            outbound_error: self
                .last_outbound_error
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone(),
            reconnecting: self.auto_reconnect.lock().unwrap_or_else(|p| p.into_inner()).as_ref().map(
                |s| RcReconnectInfo {
                    peer: s.peer.clone(),
                    peer_name: s.peer_name.clone(),
                    capability: s.capability.as_str().to_string(),
                    attempt: s.attempt,
                    max: s.max,
                    gave_up: s.gave_up,
                },
            ),
            // G3：本机静音。字段本身不带 cfg（与 peer_hevc 同例，跨平台可编译），
            // 非 Windows 上没有音频链路，恒 false。
            audio_local_mute: {
                #[cfg(target_os = "windows")]
                {
                    self.audio_local_mute()
                }
                #[cfg(not(target_os = "windows"))]
                {
                    false
                }
            },
            // G3-B/C：**对端**报来的主机音频状态（发起端才有；被控端侧恒 None）。
            // `None` = 旧对端不发这条帧 → 前端不摆「对方已静音」那类断言。
            peer_audio: {
                #[cfg(target_os = "windows")]
                {
                    self.peer_host_audio()
                }
                #[cfg(not(target_os = "windows"))]
                {
                    None
                }
            },
            // G3-C：被控端视角——对端静音了本机扬声器（提示 + 恢复入口）。
            spk_muted_by_peer: self.spk_muted_by_peer(),
        }
    }

    pub fn is_running(&self) -> bool {
        self.running
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some()
    }

    /// 正在开会话的对端 node_id（无会话时 `None`）。在线判定用。
    pub fn active_session_peer(&self) -> Option<String> {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.session.as_ref().map(|s| s.peer.clone())
    }

    /// 是否需要通道：允许被控 **或** 已有远程配对（要发起）。
    /// 两者语义不同：`rc_enabled` 只管「别人能不能控你」；发起只要配对过。
    pub fn needs_channel(&self) -> bool {
        if self.enabled() {
            return true;
        }
        if matches!(self.store.rc_device_list(), Ok(list) if !list.is_empty()) {
            return true;
        }
        // 方案 A：仅同步配对的设备也可直接发起远程（同一 iroh 身份/端点），必须让通道起来，
        // 否则用户看得见设备（source="sync"）却发不起（B9）。
        matches!(self.store.device_list(), Ok(list) if !list.is_empty())
    }

    /// 启动独立通道。幂等。
    ///
    /// 🔴 **不再要求 `rc_enabled`**（方案 A）：发起远程的人往往从未打开过
    /// 「允许被远程」——那开关只应挡住**别人控你**，不该挡住你去控别人。
    /// 入站仍由 `gate_inbound` 看 `rc_enabled` 拒掉。
    pub async fn start(&self, app_dir: &Path, relay: bool) -> Result<(), String> {
        {
            let guard = self.running.lock().unwrap_or_else(|p| p.into_inner());
            if guard.is_some() {
                return Ok(());
            }
        }
        let me = Arc::new(NodeIdentity::load_or_create(app_dir)?);
        let endpoint = bind_rc_endpoint(&me, relay).await?;
        let port = endpoint
            .bound_sockets()
            .first()
            .map(|s| s.port())
            .ok_or("远程端点没有绑到任何端口")?;
        // 表与 `spawn` 用同一个 `PresenceApp::Rc`：表按它判串台、广播按它打标识，
        // 两处不一致会变成「自己拒自己」（收不到任何 RC 地址公告）。
        let presence = Arc::new(PresenceTable::new(PresenceApp::Rc));
        let stop = Arc::new(AtomicBool::new(false));
        let presence_running = Arc::new(AtomicBool::new(false));

        {
            let mut g = self.running.lock().unwrap_or_else(|p| p.into_inner());
            // C-7：双开竞态——两次 start 都看到 None 时，后到者不得覆盖先写入的
            // Running（会泄漏端点与 accept 循环）。写槽前再判一次。
            if g.is_some() {
                log::info!("[RC] start 并发：另一请求已完成绑定，本次丢弃");
                return Ok(());
            }
            *g = Some(Running {
                endpoint: endpoint.clone(),
                presence: presence.clone(),
                stop: stop.clone(),
                presence_running: presence_running.clone(),
                identity: me.clone(),
            });
        }

        let known = self.store.rc_device_list()?;
        log::info!(
            "[RC] 远程通道已启动，端口 {}，远程已配对 {} 台（允许被控={})",
            port,
            known.len(),
            self.enabled()
        );

        // accept 循环
        {
            let svc = global().ok_or("RcService 未安装到 global")?;
            let ep = endpoint.clone();
            let stop2 = stop.clone();
            tauri::async_runtime::spawn(async move {
                accept_loop(svc, ep, stop2).await;
            });
        }

        // 本机设备名**只取一次**：`spawn`（招呼包随包自报）与 `arm`（配对握手包
        // 自报）用的是同一份。两处各调一次 `hostname::get()` 就是两个数据源。
        let my_name = crate::rc::local_device_name();

        // presence：宣告 RC 端口；is_paired 用**远程信任**（rc ∪ 同步），
        // 否则仅同步配对的对端收不到本机 RC 地址，局域网发现会失败。
        {
            let store_online = self.store.clone();
            // 明文包（附近招呼 + 配对握手）交给 `discovery`。
            // ❗ 不注册的话它们只会留一条 debug（`spawn` 里有兜底日志），
            //   表现是「附近设备永远是空的」，且从界面上完全看不出为什么。
            let disc = self.discovery.clone();
            presence.on_plain(Arc::new(move |p: &presence::PlainPacket| {
                disc.handle_plain(p);
            }));
            presence::spawn(presence::PresenceStart {
                enabled: true,
                app: PresenceApp::Rc,
                table: presence,
                me: me.clone(),
                endpoint_port: port,
                is_paired: rc_paired_fn(&self.store),
                // 听见对端「回来」→ 刷 rc_devices 在线（修纯 RC 配对永远 offline）
                on_fresh: Arc::new(move |id: &str| {
                    let _ = store_online.rc_device_touch(id, true);
                }),
                running: presence_running,
                port: RC_PRESENCE_PORT,
                // 「附近的设备」全靠这一条：周期发招呼包，把名字自报给同网段
                // **还没配对**的邻居。少了它，那块列表永远是空的
                // （2026-09-17 首版就是这样——收包侧写好了，发的那侧没接上）。
                hello_name: Some(my_name.clone()),
            });
        }

        // 挂上「怎么发」：局域网配对的握手包发往 rc 那套 presence 的端口。
        // 必须在 presence 起来之后做——`arm` 之前发的包会被 `send` 拒掉。
        self.discovery.arm(me, port, RC_PRESENCE_PORT, my_name);

        Ok(())
    }

    /// 局域网配对：附近的设备（未配对的邻居）。
    ///
    /// ❗ 已配对的不在列表里（判据与 presence 收包侧**同一个** `rc_paired_fn`）——
    /// 否则设备列表与附近列表会同时显示同一台机器，用户分不清该点哪个。
    pub fn nearby_neighbors(&self, now_ms: i64) -> Vec<crate::sync::presence::Neighbor> {
        self.discovery.neighbors(now_ms)
    }

    /// 局域网配对：当前那一轮（没有就是 `None`）。
    ///
    /// ❗ 顺带重传该重传的包（`discovery.tick`）：**界面开着的时候**才有必要重传，
    /// 而没有界面在读状态时也就不该有配对的包在路上（用户已经走开了）。
    pub fn nearby_prompt(&self, now_ms: i64) -> Option<crate::rc::pin::PairPrompt> {
        let p = self.discovery.prompt(now_ms);
        if p.is_some() {
            self.discovery.tick(now_ms);
        }
        p
    }

    /// 局域网配对：刚成功的那一台（读完即清）。
    pub fn nearby_take_done(&self) -> Option<crate::rc::pin::Done> {
        self.discovery.take_done()
    }

    pub fn nearby_pair_start(
        &self,
        peer_id: &str,
        now_ms: i64,
    ) -> Result<crate::rc::pin::PairPrompt, String> {
        let r = self.discovery.pair_start(peer_id, now_ms);
        if r.is_ok() {
            self.emit_pair_changed();
        }
        r
    }

    pub fn nearby_confirm(&self, now_ms: i64) -> Result<crate::rc::pin::Confirmed, String> {
        let r = self.discovery.confirm(now_ms);
        self.emit_pair_changed();
        r
    }

    pub fn nearby_cancel(&self, now_ms: i64) -> bool {
        let ok = self.discovery.cancel(now_ms);
        if ok {
            self.emit_pair_changed();
        }
        ok
    }

    /// 局域网配对状态变了 → 通知前端。
    ///
    /// 与 `notify.emit_changed` 是同一件事（同一个 `rc-session-changed` 事件），
    /// 收成一个方法是为了不让 `discovery.rs` 直接碰 `notify` 这个内部字段。
    pub fn emit_pair_changed(&self) {
        self.notify.emit_changed();
    }

    /// presence 里当前还听得见的对端（局域网在线）。
    pub fn presence_live_ids(&self) -> Vec<String> {
        let g = self.running.lock().unwrap_or_else(|p| p.into_inner());
        let Some(r) = g.as_ref() else {
            return Vec::new();
        };
        r.presence.live(now_ms())
    }

    pub async fn stop(&self) {
        // 先收口会话（发 End / 清帧），再关通道，避免留下「可控」假状态
        {
            let has = {
                let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
                inner.session.is_some()
            };
            if has {
                let _ = self.end_session("远程通道关闭").await;
            }
        }
        let running = {
            let mut g = self.running.lock().unwrap_or_else(|p| p.into_inner());
            g.take()
        };
        if let Some(r) = running {
            r.stop.store(true, Ordering::SeqCst);
            r.presence_running.store(false, Ordering::SeqCst);
            r.endpoint.close().await;
            // 局域网配对：摘掉「怎么发」并清掉会话与附近表。
            // ❗ **不清 `rc_devices`** —— 那是落库的配对结果，与通道起停无关。
            //   清掉的话用户会发现「重启一次配对全没了」。
            self.discovery.disarm();
            self.joins.clear();
            {
                let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
                inner.session = None;
                inner.pending.clear();
            }
            *self.outbound_send.lock().await = None;
            *self.outbound_conn.lock().await = None;
            *self.inbound_send.lock().await = None;
            // Q2/Q6：通道停了，接入码全部作废（它们只活在内存里），
            // 自动重连 episode 也失去意义——继续重试只会拿到 [channel_down]，
            // 三次用尽再给用户挂一条「自动重连失败」横幅纯属误导。
            let revoked = self.uno.revoke_all();
            if revoked > 0 {
                log::info!("[RC] 通道停止，已作废 {revoked} 个无人值守接入码");
            }
            *self.auto_reconnect.lock().unwrap_or_else(|p| p.into_inner()) = None;
            log::info!("[RC] 远程通道已停止");
        }
    }

    pub fn pending_joins(&self) -> Vec<join::RcJoinRequest> {
        self.joins.list(now_ms())
    }

    pub fn approve_join(&self, node_id: &str, name: &str) -> Result<(), String> {
        if !self.joins.take(node_id) && !self.is_rc_paired(node_id) {
            // 已配对再点一次也允许（幂等刷新名字）
            if !self.is_rc_paired(node_id) {
                return Err("没有待确认的远程配对请求".into());
            }
        }
        let n = if name.trim().is_empty() {
            "新设备".to_string()
        } else {
            name.trim().to_string()
        };
        self.store.rc_device_pair(node_id, &n)?;
        // 🔴 **配对成功即关门**（2026-09-17 补，`sync::join` 早就是这个做法）。
        //   码里带的是「node_id + 名字」、**不是一次性 nonce** ⇒ 同一份码在窗口内
        //   可以被反复使用。「配完就关门」比「把窗口调短」更管用，也更符合直觉：
        //   一次配对只该消耗一份邀请。
        //   关门失败不阻断配对本身——设备已经写进白名单了，报错会让用户以为
        //   白配一场；但也不能静默（规则 #15.3）。
        if let Err(e) = join::close_door(&self.store) {
            log::warn!("[RC] 配对成功后关闭邀请窗口失败：{e}——这份码在本轮窗口内仍可使用");
        }
        Ok(())
    }

    pub fn deny_join(&self, node_id: &str) {
        self.joins.deny(node_id, now_ms());
    }

    /// 拿「已启动的端点 + presence 表」。`pub(super)` 是因为文件通道（G6）
    /// 要自己拨号——它独立于 RC 会话，不复用会话的连接。
    pub(in crate::rc) fn transport_ready(&self) -> Option<(Endpoint, Arc<PresenceTable>)> {
        let g = self.running.lock().unwrap_or_else(|p| p.into_inner());
        g.as_ref().map(|r| (r.endpoint.clone(), r.presence.clone()))
    }
}
