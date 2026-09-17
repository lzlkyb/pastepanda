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
/// 会话路径自动切换时的回调（参数为 from / to 的档位串）。
///
/// iroh 每 60s 会尝试把中继路径升级成直连（`UPGRADE_INTERVAL`），
/// 这个升级不加通知的话用户永远看不到——延迟突然变了却不知道为什么。
pub(super) type PathNotifyFn = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// 「状态变化 / 画面范围变化 / 注入错误」三类前端通知的收口。
pub(super) struct NotifyState {
    /// 状态变化通知（emit `rc-session-changed` / inject-error）。
    notify: Mutex<Option<NotifyFn>>,
    /// 被控端：对端改了画面范围时的通知（带 scope 参数）。
    /// 与 `notify` 分开是因为 payload 不同——`notify` 是无参「有事变了」，
    /// 这个要告诉前端「被改成了哪个范围」，前端才能给出具体提示。
    notify_scope: Mutex<Option<ScopeNotifyFn>>,
    /// 会话路径自动切换（relay ↔ 直连）时的通知。
    notify_path: Mutex<Option<PathNotifyFn>>,
    /// 最近一次注入失败（UIPI 等），供发起端展示。
    last_inject_err: Mutex<Option<String>>,
}

impl NotifyState {
    pub(super) fn new() -> Self {
        Self {
            notify: Mutex::new(None),
            notify_scope: Mutex::new(None),
            notify_path: Mutex::new(None),
            last_inject_err: Mutex::new(None),
        }
    }

    /// 注入前端通知回调（lib.rs 在 manage 之后调用）。
    pub(super) fn set_notify(&self, f: NotifyFn) {
        *self.notify.lock().unwrap_or_else(|p| p.into_inner()) = Some(f);
    }

    /// 状态变化通知前端（emit `rc-session-changed` / inject-error）。
    pub(super) fn emit_changed(&self) {
        let f = self.notify.lock().unwrap_or_else(|p| p.into_inner()).clone();
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

    /// 记录注入失败；同时通知前端（UIPI 等失败要让发起端看见，不能只写日志）。
    pub(super) fn set_inject_err(&self, msg: String) {
        *self.last_inject_err.lock().unwrap_or_else(|p| p.into_inner()) = Some(msg);
        self.emit_changed();
    }

    /// 取出并清空最近一次注入失败（前端展示后应调）。
    pub(super) fn take_inject_err(&self) -> Option<String> {
        self.last_inject_err
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
