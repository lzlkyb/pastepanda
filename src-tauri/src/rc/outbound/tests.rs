//! `outbound.rs` 的单元测试（原样平移）。

/// 🔴 守卫：收流断开的错误**真的**过了 `explain`，且理由带进了会话结束原因。
///
/// 这条治的是 09-17 那类「工具写好了、没人接」：`service::explain` 早已存在
/// （同步侧 09-06 就有），但本文件的收流 Err 分支一直裸报——对端以
/// 「未配对 / 忙 / 被禁」关连接时，用户只看到 `connection lost`，分档全失效。
#[test]
fn test_守卫_收流断开的理由真的过了explain() {
    let src = include_str!("../outbound.rs");
    assert!(
        src.contains("super::service::explain(&self.conn, e)"),
        "收流 Err 分支没过 `explain`——对端关连接的理由会退化成 `connection lost`"
    );
    assert!(
        src.contains("let reason = self")
            && src.contains("peer_end_reason"),
        "对端 End 帧的理由要带进 `force_end_if_session`（P2-10：否则历史记成「画面流中断」）"
    );
    // 连接句柄必须从 `dial_and_request` 交出来——没有它，收流侧拿不到 `close_reason`。
    let svc = include_str!("../service/outbound.rs");
    assert!(
        svc.contains("Ok((capability, conn, send, recv))"),
        "`dial_and_request` 不再返回连接句柄了——收流侧的 `explain` 会拿不到 `close_reason`"
    );
}
