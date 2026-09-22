//! 回调注册（notify）与音频状态机（G3）。
//!
//! 2026-09-22 从 `service.rs` 平移（体量合规）。`use crate::rc::*` 沿用
//! `service/mod.rs` 的全部名字；方法体未改动，仅 `pub(super)` 方法
//! 升级为 `pub(in crate::rc)`（原语义就是「rc 子树可见」）。

use super::*;

impl RcService {
    /// 注入前端通知回调（lib.rs 在 manage 之后调用）。
    pub fn set_notify(&self, f: NotifyFn) {
        self.notify.set_notify(f);
    }

    /// 注入「outbox 有新帧」的回调（lib.rs 在 manage 之后调用）。
    pub fn set_frame_notify(&self, f: NotifyFn) {
        self.notify.set_frame_notify(f);
    }

    pub(in crate::rc) fn emit_changed(&self) {
        self.notify.emit_changed();
    }

    /// 注入「对端改了画面范围」的回调（lib.rs 在 manage 之后调用）。
    pub fn set_scope_notify(&self, f: ScopeNotifyFn) {
        self.notify.set_scope_notify(f);
    }

    /// 注入「远端光标形状变化」的回调（lib.rs 在 manage 之后调用）。
    pub fn set_cursor_notify(&self, f: crate::rc::notify::CursorNotifyFn) {
        self.notify.set_cursor_notify(f);
    }

    /// 注入文件传输状态回调（G6，lib.rs 在 manage 之后调用）。
    pub fn set_file_notify(&self, f: crate::rc::notify::FileNotifyFn) {
        self.notify.set_file_notify(f);
    }

    /// 被控端上报的光标形状变化 → 抛给发起端前端。
    pub(in crate::rc) fn set_remote_cursor(&self, shape: String) {
        self.notify.emit_cursor_changed(&shape);
    }

    /// 注入「会话换路了」的回调（lib.rs 在 manage 之后调用）。
    ///
    /// C：iroh 每 60s 会尝试把中继路径升级成直连（`UPGRADE_INTERVAL`），
    /// 这个自动升级不通知的话用户只会看到延迟莫名变化。
    pub fn set_path_notify(&self, f: PathNotifyFn) {
        self.notify.set_path_notify(f);
    }

    /// 被控端：告诉前端「对端把画面范围改成了 scope」。
    ///
    /// B3：观察者（**包括只看会话**）能改被观察者的采集范围，被观察者原来只有
    /// `log::info`，UI 上完全看不到——观察者因此能把画面切到另一块屏（上面可能有
    /// 隐私内容）而对方毫无察觉。这里把变更显式抛给被控端 UI。
    ///
    /// ⚠️ 只有**入站**路径（`handle_inbound_input` 收到 `SetCaptureScope`）该调它。
    /// 本机自己在设置页改范围走 `set_stream_scope`，那条路径**故意不通知**——
    /// 用户自己点的操作不需要再弹一条「有人改了你的画面范围」。
    ///
    /// `pub(crate)` 是为了让 `rc::tests` 能覆盖「回调确实收到 scope」，
    /// 不是因为需要跨模块调用。
    pub(crate) fn emit_scope_changed(&self, scope: &str) {
        self.notify.emit_scope_changed(scope);
    }

    // ── G3 音频 ─────────────────────────────────────────────────────────

    /// 被控端：登记对端的音频申请（Accept 前调用）。
    #[cfg(target_os = "windows")]
    pub(in crate::rc) fn audio_set_peer_wants(&self, wants: bool) {
        self.audio_peer_wants
            .store(wants, std::sync::atomic::Ordering::SeqCst);
    }

    /// 被控端：对端是否申请了系统声音（音频任务只看这个决定起不起）。
    #[cfg(target_os = "windows")]
    pub(in crate::rc) fn audio_peer_wants(&self) -> bool {
        self.audio_peer_wants
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 音频此刻该不该出。三因子取与，任一为否即不出声：
    /// 对端申请了（Request.audio）&& 对端没在会话里关掉 && **本机没静音**。
    /// 采集 worker 每轮读，三者会话中任意时刻翻转都即时生效（停即关流、开即重发 Cfg）。
    #[cfg(target_os = "windows")]
    pub(in crate::rc) fn audio_wanted(&self) -> bool {
        self.audio_peer_wants.load(std::sync::atomic::Ordering::SeqCst)
            && !self.audio_muted.load(std::sync::atomic::Ordering::SeqCst)
            && !self.audio_local_mute.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 被控端：**对端**的开关（只由 `InputEvent::AudioOn` 驱动，不接本机 UI）。
    #[cfg(target_os = "windows")]
    pub fn set_audio_muted(&self, muted: bool) {
        self.audio_muted
            .store(muted, std::sync::atomic::Ordering::SeqCst);
    }

    /// 被控端：**本机**静音（被控者自己关的，一票否决）。跨会话保持，见字段注释。
    ///
    /// ❗ 只改状态，**不推帧**——推送是 async，而这里是同步方法且调用方就在命令层。
    /// 命令层改完必须跟一句 [`emit_host_audio`](Self::emit_host_audio)，否则对端
    /// 只会发现「声音没了」而不知道是对方静音（G3-B 要消掉的正是这个）。
    #[cfg(target_os = "windows")]
    pub fn set_audio_local_mute(&self, muted: bool) {
        self.audio_local_mute
            .store(muted, std::sync::atomic::Ordering::SeqCst);
    }

    /// 被控端：本机是否已静音。status 上报给前端画按钮态；与字段同名同
    /// `audio_peer_wants()` 的先例。
    #[cfg(target_os = "windows")]
    pub fn audio_local_mute(&self) -> bool {
        self.audio_local_mute
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 被控端：把本机音频状态推给对端（G3-B/C，控制流上一条 JSON，与 `cursor`/`clip` 同路）。
    ///
    /// 三个时机：**会话刚建立**（给初值，见 `inbound.rs` 的 `run`）、**被控者切
    /// 「不发送声音」**、**收到 `SetHostMute` 之后**（回读回的真实值）。
    ///
    /// `err` 只在动作失败时带——对端据此提示「切换失败」，而不是点了没反应。
    /// 没有控制流（未 Accept / 已断开）时静默返回：它不是关键路径。
    ///
    /// 可见性是 `pub` 是因为**命令层也要用**（被控者切「不发送声音」后必须跟着推）。
    pub async fn emit_host_audio(&self, err: Option<&str>) {
        #[cfg(target_os = "windows")]
        {
            let spk = crate::rc::audio::spk_mute_get().unwrap_or(false);
            let local = self.audio_local_mute.load(std::sync::atomic::Ordering::SeqCst);
            let mut msg = serde_json::json!({
                "t": "host_audio",
                "local_mute": local,
                "spk_mute": spk,
            });
            if let Some(e) = err {
                msg["err"] = serde_json::Value::String(e.to_string());
            }
            let Ok(b) = serde_json::to_vec(&msg) else {
                return;
            };
            let guard = self.inbound_send.lock().await;
            if let Some(send) = guard.as_ref() {
                let mut g = send.lock().await;
                let _ = crate::sync::transport::write_frame(&mut g, &b).await;
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = err;
        }
    }

    /// 发起端：记下对端报来的主机音频状态（`outbound.rs` 解出 `host_audio` 后调用）。
    pub(in crate::rc) fn set_peer_host_audio(&self, st: PeerHostAudio) {
        *self.peer_host_audio.lock().unwrap_or_else(|p| p.into_inner()) = Some(st);
    }

    /// 发起端：对端报来的主机音频状态（快照用）。None = 旧对端不发这条帧。
    pub(in crate::rc) fn peer_host_audio(&self) -> Option<PeerHostAudio> {
        self.peer_host_audio
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// 被控端：对端静音了本机扬声器且尚未恢复（横幅提示 + 恢复入口摆不摆）。
    pub fn spk_muted_by_peer(&self) -> bool {
        self.spk_mute_by_peer.load(Ordering::SeqCst)
    }

    /// 被控端：记「对端静音了本机扬声器」。`false` = 已恢复，或本就是本机自己改的。
    pub fn set_spk_muted_by_peer(&self, on: bool) {
        self.spk_mute_by_peer.store(on, Ordering::SeqCst);
    }

    /// 被控端本机：设置主机扬声器静音，并把新状态告知对端（命令层入口）。
    ///
    /// 与「对端发 `SetHostMute`」的区别：**这是本机自己的操作**，所以顺手清掉
    /// 「对端静音的」标记（横幅提示与恢复按钮随之收起），并推一次状态帧——
    /// 否则对端那个按钮会停在一个已经不成立的状态上。返回读回的真实值。
    #[cfg(target_os = "windows")]
    pub async fn host_mute_local(&self, on: bool) -> Result<bool, String> {
        let actual = crate::rc::audio::spk_mute_set(on)?;
        self.set_spk_muted_by_peer(false);
        self.emit_host_audio(None).await;
        Ok(actual)
    }

    /// 发起端：音频流头部到了（新音频流开始）——替换缓冲。
    #[cfg(target_os = "windows")]
    pub(in crate::rc) fn audio_begin(&self, cfg: crate::rc::audio::AudioCfg) {
        self.audio_rx
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .begin(cfg);
    }

    /// 发起端：音频包入队（满则丢最旧——声音要新鲜）。
    #[cfg(target_os = "windows")]
    pub(in crate::rc) fn audio_push(&self, pts_ms: u64, data: Vec<u8>) {
        self.audio_rx
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(pts_ms, data);
    }

    /// 发起端：前端取音频（cfg 每次都带，前端按 asc 变了才重配解码器）。
    #[cfg(target_os = "windows")]
    pub fn drain_audio(&self) -> (Option<crate::rc::audio::AudioCfg>, Vec<crate::rc::audio::AudioPkt>) {
        let mut rx = self.audio_rx.lock().unwrap_or_else(|p| p.into_inner());
        (
            rx.cfg.clone(),
            rx.queue.drain(..).collect(),
        )
    }

    /// 会话收口：音频状态清零（对端申请位、对端开关、收流缓冲）。
    ///
    /// ❗ **不清 `audio_local_mute`**：它是被控者本人的隐私意愿，属于「跨会话保持」
    /// 的状态（字段注释里有理由）。会话结束顺手把它抹掉，等于每来一个人就把用户的
    /// 静音自动解开一次——隐私开关不该有这种自动回退。
    #[cfg(target_os = "windows")]
    pub(in crate::rc) fn audio_reset(&self) {
        self.audio_peer_wants
            .store(false, std::sync::atomic::Ordering::SeqCst);
        self.audio_muted
            .store(false, std::sync::atomic::Ordering::SeqCst);
        self.audio_rx
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .reset();
        // G3-B/C：两边的主机音频状态都是**本会话**的事实，会话收口即作废。
        // ❗ 唯独不动 `audio_local_mute`（被控者的隐私意愿，跨会话保持，见上）。
        *self.peer_host_audio.lock().unwrap_or_else(|p| p.into_inner()) = None;
        self.spk_mute_by_peer
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// 注入「对端改了画质/编码」的回调（lib.rs 在 manage 之后调用）。
    pub fn set_stream_notify(&self, f: crate::rc::notify::StreamNotifyFn) {
        self.notify.set_stream_notify(f);
    }

    /// 被控端：告诉前端「对端把画质/编码改成了 name」。
    ///
    /// Q10：对端（连**只看**会话都）能单方面调画质/编码，原来只有 `log::info`，
    /// 被控者看到画面突然变糊/变清却不知原因。与 `emit_scope_changed` 同一
    /// 纪律：只有入站路径（`handle_inbound_input`）该调，本机自己改的不通知。
    pub(crate) fn emit_stream_note(&self, kind: &str, name: &str) {
        self.notify.emit_stream_note(kind, name);
    }

    pub(in crate::rc) fn set_inject_err(&self, msg: String) {
        self.notify.set_inject_err(msg);
    }

    pub fn take_inject_err(&self) -> Option<String> {
        self.notify.take_inject_err()
    }

    /// 发起端：被控端回 `clip_push_err`（D11）。收口进通知层，由 lib.rs 抛
    /// `rc-clip-push-error` 事件；前端 toast 用。
    pub(in crate::rc) fn set_clip_push_err(&self, msg: String) {
        self.notify.set_clip_push_err(msg);
    }

    pub fn take_clip_push_err(&self) -> Option<String> {
        self.notify.take_clip_push_err()
    }
}
