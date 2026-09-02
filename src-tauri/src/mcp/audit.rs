//! 审计出口（W3）。
//!
//! ❗ **为什么是 trait 而不是直接持 `AppHandle`**：
//! `build_router` 必须能在测试里构造出来（它的注释就写着「抽成函数是为了
//! 测试能直接拿到真 Router」），而本机**用不了 `tauri::test::mock_app()`**
//! ——它会把 lib test 二进制链到不存在的 `ProcessPrng`，整个测试二进制
//! 启动即挂（见 Cargo.toml 里那段警告）。
//! 直接塞 `AppHandle` 会让那批过线测试全部构造不出 Router。

use tauri::{Emitter, Manager};

/// 一次调用的审计落盘。实现方**不得因为失败而恐慌**：
/// 已拍板 fail-open，这个接口故意不返回 `Result`。
pub(super) trait AuditSink: Send + Sync + 'static {
    fn record(&self, client: &str, tool: &str, args: &str, ok: bool, note_ids: &[String]);
}

/// 生产实现：写库 + 写不下时发事件让界面能报「审计断过」。
pub(super) struct AppAuditSink {
    app: tauri::AppHandle,
}

impl AppAuditSink {
    pub(super) fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl AuditSink for AppAuditSink {
    fn record(&self, client: &str, tool: &str, args: &str, ok: bool, note_ids: &[String]) {
        // `try_state` 而不是 `state`：后者拿不到会 panic，而本项目 `panic = "abort"`
        // ——为了写一条审计把整个应用弄死是荒唐的。
        let Some(store) = self.app.try_state::<crate::data_store::DataStore>() else {
            log::warn!("[MCP] 拿不到 DataStore，本次调用未记审计");
            return;
        };
        let Err(e) = store.mcp_audit_log(client, tool, args, ok, note_ids.len() as i64, note_ids)
        else {
            return;
        };
        // 🔴 fail-open（已拍板）：写不下也照常服务——磁盘满/库锁时拒绝读服务
        // 对用户没好处。但**必须让用户看见**：静默地丢审计等于审计不可信，
        // 而不可信的审计比没有审计更糟。
        log::warn!("[MCP] 审计写入失败（本次调用仍已执行）: {}", e);
        if let Err(emit_err) = self.app.emit("mcp-audit-failed", e) {
            log::warn!("[MCP] 审计失败事件发送失败: {}", emit_err);
        }
    }
}
