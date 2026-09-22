//! 通知 / 注入错误状态（Tier B 从 `service.rs` 拆出的子结构体）。
//!
//! 只碰四个字段 `notify` / `notify_scope` / `notify_path` / `last_inject_err`
//! 以及只调它们的方法。前三个是纯搬位置 + 收口（逻辑、时序、文案、锁粒度
//! 一律不变）；`notify_path` 是 2026-09-17 新增的路径切换通知。

use std::sync::{Arc, Mutex};

/// 会话状态变化时通知前端（由 lib.rs 注入，避免 RcService 依赖 AppHandle）。
pub(super) type NotifyFn = Arc<dyn Fn() + Send + Sync>;
/// 被控端画面范围被对端改动时的回调（参数为新的 scope 串）。
pub(super) type ScopeNotifyFn = Arc<dyn Fn(&str) + Send + Sync>;
/// 远端光标形状变化时的回调（参数为形状串，见 input::CursorShape）。
pub(super) type CursorNotifyFn = Arc<dyn Fn(&str) + Send + Sync>;
/// 会话路径自动切换时的回调（参数为 from / to 的档位串）。
///
/// iroh 每 60s 会尝试把中继路径升级成直连（`UPGRADE_INTERVAL`），
/// 这个升级不加通知的话用户永远看不到——延迟突然变了却不知道为什么。
pub(super) type PathNotifyFn = Arc<dyn Fn(&str, &str) + Send + Sync>;
/// 被控端画质/编码被对端改动时的回调（kind = "quality" | "codec"，name 为原始值串）。
pub(super) type StreamNotifyFn = Arc<dyn Fn(&str, &str) + Send + Sync>;
/// 文件传输状态变化时的回调（参数是完整快照的 JSON 串）。
///
/// 传 JSON 而不是结构体：这一层的调用者是 `lib.rs` 注入的闭包，它只该
/// `emit` 一次；把序列化放在这里，前端拿到的事件 payload 与
/// `rc_file_snapshot` 命令的返回**天然是同一个形状**。
pub(super) type FileNotifyFn = Arc<dyn Fn(&str) + Send + Sync>;

/// 两次「有新帧」事件的最小间隔（毫秒）。帧率上限 30fps（33ms），
/// 5ms 节流只防异常风暴；被节流掉的唤醒由前端的兜底短轮询补上。
const FRAME_READY_MIN_GAP_MS: i64 = 5;

/// 「状态变化 / 画面范围变化 / 注入错误 / 新帧就绪」四类前端通知的收口。
pub(super) struct NotifyState {
    /// 状态变化通知（emit `rc-session-changed` / inject-error）。
    notify: Mutex<Option<NotifyFn>>,
    /// 被控端：对端改了画面范围时的通知（带 scope 参数）。
    /// 与 `notify` 分开是因为 payload 不同——`notify` 是无参「有事变了」，
    /// 这个要告诉前端「被改成了哪个范围」，前端才能给出具体提示。
    notify_scope: Mutex<Option<ScopeNotifyFn>>,
    /// 被控端：对端改了画质/编码档时的通知（kind + 原始值串）。
    notify_stream: Mutex<Option<StreamNotifyFn>>,
    /// 会话路径自动切换（relay ↔ 直连）时的通知。
    notify_path: Mutex<Option<PathNotifyFn>>,
    /// 远端光标形状变化（P1-6）。
    notify_cursor: Mutex<Option<CursorNotifyFn>>,
    /// 文件传输状态（G6）：待响应请求 + 任务进度。
    notify_file: Mutex<Option<FileNotifyFn>>,
    /// 发起端：outbox 有新帧时的唤醒通知（emit `rc-frame-ready`，无 payload）。
    notify_frame: Mutex<Option<NotifyFn>>,
    /// 上次 emit_frame_ready 的时刻（epoch ms），节流用。
    last_frame_emit_ms: std::sync::atomic::AtomicI64,
    /// 最近一次注入失败（UIPI 等），供发起端展示。
    last_inject_err: Mutex<Option<String>>,
    /// 最近一次**推送剪贴板失败**（D11）：被控端明确拒绝或写不进去时带回的原因。
    ///
    /// 与 `last_inject_err` 分开而不是复用：两者的 toast 文案与用户动作都不同
    /// （一个是「对方未能注入输入」，一个是「你推过去的剪贴板没写进去」），
    /// 合成一条会让用户拿到一句指向错误动作的话。
    last_clip_push_err: Mutex<Option<String>>,
}

impl NotifyState {
    pub(super) fn new() -> Self {
        Self {
            notify: Mutex::new(None),
            notify_scope: Mutex::new(None),
            notify_stream: Mutex::new(None),
            notify_path: Mutex::new(None),
            notify_cursor: Mutex::new(None),
            notify_file: Mutex::new(None),
            notify_frame: Mutex::new(None),
            last_frame_emit_ms: std::sync::atomic::AtomicI64::new(0),
            last_inject_err: Mutex::new(None),
            last_clip_push_err: Mutex::new(None),
        }
    }

    /// 注入前端通知回调（lib.rs 在 manage 之后调用）。
    pub(super) fn set_notify(&self, f: NotifyFn) {
        *self.notify.lock().unwrap_or_else(|p| p.into_inner()) = Some(f);
    }

    /// 注入文件状态回调（lib.rs 在 manage 之后调用）。
    pub(super) fn set_file_notify(&self, f: FileNotifyFn) {
        *self.notify_file.lock().unwrap_or_else(|p| p.into_inner()) = Some(f);
    }

    /// 文件传输状态变了（待响应请求增删 / 进度推进 / 落终态）。
    ///
    /// ⚠️ 调用方负责节流：进度按 1 MiB 分块，一秒能推几十块，而**画面流走的是
    /// 同一个事件通道**——不节流会把视频挤卡（节流判据在 `file_state::should_emit`）。
    pub(super) fn emit_file_state(&self, json: &str) {
        let f = self
            .notify_file
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if let Some(f) = f {
            f(json);
        }
    }

    /// 状态变化通知前端（emit `rc-session-changed` / inject-error）。
    pub(super) fn emit_changed(&self) {
        let f = self
            .notify
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if let Some(f) = f {
            f();
        }
    }

    /// 注入「对端改了画面范围」的回调（lib.rs 在 manage 之后调用）。
    pub(super) fn set_scope_notify(&self, f: ScopeNotifyFn) {
        *self.notify_scope.lock().unwrap_or_else(|p| p.into_inner()) = Some(f);
    }

    /// 被控端：告诉前端「对端把画面范围改成了 scope」。
    ///
    /// ⚠️ 只有**入站**路径（`handle_inbound_input` 收到 `SetCaptureScope`）该调它。
    /// 本机自己在设置页改范围走 `set_stream_scope`，那条路径**故意不通知**——
    /// 用户自己点的操作不需要再弹一条「有人改了你的画面范围」。
    pub(super) fn emit_scope_changed(&self, scope: &str) {
        let f = self
            .notify_scope
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if let Some(f) = f {
            f(scope);
        }
    }

    /// 注入「对端改了画质/编码」的回调（lib.rs 在 manage 之后调用）。
    pub(super) fn set_stream_notify(&self, f: StreamNotifyFn) {
        *self.notify_stream.lock().unwrap_or_else(|p| p.into_inner()) = Some(f);
    }

    /// 被控端：告诉前端「对端把画质/编码改成了 name」。
    ///
    /// ⚠️ 只有**入站**路径（`handle_inbound_input` 收到 `SetQuality`/`SetCodec`）
    /// 该调它；与 `emit_scope_changed` 同一条纪律——本机自己改的不通知。
    pub(super) fn emit_stream_note(&self, kind: &str, name: &str) {
        let f = self
            .notify_stream
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if let Some(f) = f {
            f(kind, name);
        }
    }

    /// 注入「远端光标形状变化」的回调（lib.rs 在 manage 之后调用）。
    pub(super) fn set_cursor_notify(&self, f: CursorNotifyFn) {
        *self.notify_cursor.lock().unwrap_or_else(|p| p.into_inner()) = Some(f);
    }

    /// 远端光标形状变了 → 告诉发起端前端（形状只在变化时发，无需节流）。
    pub(super) fn emit_cursor_changed(&self, shape: &str) {
        let f = self
            .notify_cursor
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if let Some(f) = f {
            f(shape);
        }
    }

    /// 注入「会话换路了」的回调（lib.rs 在 manage 之后调用）。
    pub(super) fn set_path_notify(&self, f: PathNotifyFn) {
        *self.notify_path.lock().unwrap_or_else(|p| p.into_inner()) = Some(f);
    }

    /// 会话路径变了（relay ↔ 直连）：告诉前端 from → to。
    ///
    /// 与 `emit_changed` 分开是因为 payload 不同：那个是「有事变了」，
    /// 这个要说清「从哪条路换到了哪条路」，前端才能给出可读提示。
    pub(super) fn emit_path_changed(&self, from: &str, to: &str) {
        let f = self
            .notify_path
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if let Some(f) = f {
            f(from, to);
        }
    }

    /// 注入「outbox 有新帧」的回调（lib.rs 在 manage 之后调用）。
    pub(super) fn set_frame_notify(&self, f: NotifyFn) {
        *self.notify_frame.lock().unwrap_or_else(|p| p.into_inner()) = Some(f);
    }

    /// outbox 有新帧：唤醒前端来 `rc_drain_frames`。带 5ms 节流。
    pub(super) fn emit_frame_ready(&self, now_ms: i64) {
        use std::sync::atomic::Ordering;
        let last = self.last_frame_emit_ms.load(Ordering::Relaxed);
        if now_ms - last < FRAME_READY_MIN_GAP_MS {
            return;
        }
        self.last_frame_emit_ms
            .store(now_ms, Ordering::Relaxed);
        let f = self
            .notify_frame
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if let Some(f) = f {
            f();
        }
    }

    /// 记录注入失败；同时通知前端（UIPI 等失败要让发起端看见，不能只写日志）。
    pub(super) fn set_inject_err(&self, msg: String) {
        *self
            .last_inject_err
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(msg);
        self.emit_changed();
    }

    /// 取出并清空最近一次注入失败（前端展示后应调）。
    pub(super) fn take_inject_err(&self) -> Option<String> {
        self.last_inject_err
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
    }

    /// 记录「推给对方的剪贴板没写进去」；同时通知前端。
    ///
    /// 🔴 D11（2026-09-22 审计）：被控端过去在「只看会话 / 超限 / 写剪贴板失败」
    /// 三种情况下只写日志、不回帧，发起端界面照样报「已推送 · N 字符」——
    /// 用户到对端粘贴才发现是旧内容。这条与 [`Self::set_inject_err`] 同一纪律：
    /// 失败必须走到用户眼前（项目规则 15.3）。
    pub(super) fn set_clip_push_err(&self, msg: String) {
        *self
            .last_clip_push_err
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(msg);
        self.emit_changed();
    }

    /// 取出并清空最近一次推送剪贴板失败。
    pub(super) fn take_clip_push_err(&self) -> Option<String> {
        self.last_clip_push_err
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emit_changed_calls_registered_fn() {
        let s = NotifyState::new();
        let hit = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let hit2 = hit.clone();
        s.set_notify(Arc::new(move || {
            hit2.store(true, std::sync::atomic::Ordering::SeqCst);
        }));
        // 未注册时不 panic
        s.emit_changed();
        assert!(hit.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn set_inject_err_records_and_emit_changed_fires() {
        let s = NotifyState::new();
        let hit = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let hit2 = hit.clone();
        s.set_notify(Arc::new(move || {
            hit2.store(true, std::sync::atomic::Ordering::SeqCst);
        }));
        s.set_inject_err("UIPI blocked".to_string());
        // 记录下来了
        assert_eq!(s.take_inject_err().as_deref(), Some("UIPI blocked"));
        // 且顺带通知了前端
        assert!(hit.load(std::sync::atomic::Ordering::SeqCst));
        // take 之后清空
        assert_eq!(s.take_inject_err(), None);
    }

    #[test]
    fn set_clip_push_err_records_and_emit_changed_fires() {
        let s = NotifyState::new();
        let hit = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let hit2 = hit.clone();
        s.set_notify(Arc::new(move || {
            hit2.store(true, std::sync::atomic::Ordering::SeqCst);
        }));
        s.set_clip_push_err("剪贴板内容约 60 KB，超过 48 KB 上限".to_string());
        assert_eq!(
            s.take_clip_push_err().as_deref(),
            Some("剪贴板内容约 60 KB，超过 48 KB 上限")
        );
        assert!(hit.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(s.take_clip_push_err(), None, "take 之后清空");
        // 与 inject_err 互不串台：两条通知各有各的槽
        assert_eq!(s.take_inject_err(), None);
    }

    #[test]
    fn emit_scope_changed_passes_scope_string() {
        let s = NotifyState::new();
        let got = Arc::new(std::sync::Mutex::new(None));
        let got2 = got.clone();
        s.set_scope_notify(Arc::new(move |scope: &str| {
            *got2.lock().unwrap() = Some(scope.to_string());
        }));
        s.emit_scope_changed("primary");
        assert_eq!(got.lock().unwrap().as_deref(), Some("primary"));
    }

    #[test]
    fn emit_stream_note_passes_kind_and_value() {
        let s = NotifyState::new();
        let got: Arc<std::sync::Mutex<Option<(String, String)>>> =
            Arc::new(std::sync::Mutex::new(None));
        let got2 = got.clone();
        s.set_stream_notify(Arc::new(move |kind: &str, name: &str| {
            *got2.lock().unwrap() = Some((kind.to_string(), name.to_string()));
        }));
        // 未注册时不 panic；注册后 kind 与原始值都要原样送达
        s.emit_stream_note("quality", "ultra");
        assert_eq!(
            got.lock()
                .unwrap()
                .as_ref()
                .map(|(k, n)| (k.as_str(), n.as_str())),
            Some(("quality", "ultra"))
        );
    }

    #[test]
    fn emit_path_changed_passes_both_ends() {
        let s = NotifyState::new();
        let got: Arc<std::sync::Mutex<Option<(String, String)>>> =
            Arc::new(std::sync::Mutex::new(None));
        let got2 = got.clone();
        s.set_path_notify(Arc::new(move |from: &str, to: &str| {
            *got2.lock().unwrap() = Some((from.to_string(), to.to_string()));
        }));
        s.emit_path_changed("relay", "direct");
        assert_eq!(
            got.lock().unwrap().clone(),
            Some(("relay".to_string(), "direct".to_string())),
            "两个端点都要传，前端才能说清「从哪换到哪」"
        );
    }

    #[test]
    fn emit_path_changed_未注册时不panic() {
        let s = NotifyState::new();
        s.emit_path_changed("relay", "direct");
    }
}
