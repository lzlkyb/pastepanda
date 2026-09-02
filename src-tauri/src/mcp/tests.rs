//! MCP 服务的**过线**测试：真起 axum server（端口 0 随机），真发 HTTP 请求。
//!
//! **为何不直接调 `protocol::dispatch`**：那样测不到中间件与鉴权。
//! 本模块要钉的正是那些“接线处”：中间件到底挂上了没、鉴权会不会被绕、
//! 状态码对不对——它们全部只存在于请求真的跑一遍的时候。参照 cc-bridge 的做法。

use serde_json::{json, Value};

const TOKEN: &str = "test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/// 可控的假数据源。
///
/// 这正是把 `KbSource` 抽成 trait 的收益：不用造 Tauri App（那条路在本机不通，
/// 见 `source.rs` 头部），也不用建临时库——**本模块要测的是 MCP 层**
/// （参数解析、R6 不退化、输出形状），查询本身已由 `data_store::tests_qa` 盖住。
struct FakeKb {
    notes: Vec<crate::data_store::Note>,
}

impl FakeKb {
    fn new() -> Self {
        Self {
            notes: vec![fake_note(
                "n1",
                "Rust 并发笔记",
                "记了 tokio 与 spawn_blocking 的取舍。",
            )],
        }
    }
}

fn fake_note(id: &str, title: &str, content: &str) -> crate::data_store::Note {
    // 用 JSON 反序列化造：`Note` 字段很多且会增，手写构造会频繁被新字段撞坏。
    // `#[serde(default)]` 的字段自动补齐。
    serde_json::from_value(serde_json::json!({
        "id": id,
        "title": title,
        "content": content,
        "created_at": "2026-09-01 10:00:00",
        "updated_at": "2026-09-02 11:00:00",
        "tags": [],
    }))
    .expect("造假笔记失败（Note 的必填字段变了？）")
}

impl super::source::KbSource for FakeKb {
    fn read(&self, id: &str) -> Result<Option<crate::data_store::Note>, String> {
        Ok(self.notes.iter().find(|n| n.id == id).cloned())
    }

    fn list(
        &self,
        folder: Option<&str>,
        tag: Option<&str>,
        _limit: u32,
        _offset: u32,
    ) -> Result<super::source::ListOutcome, String> {
        // 假实现里只认一个文件夹与一个标签，其余一律当未知——正好用来钉 R6。
        if let Some(f) = folder {
            if f != "技术" {
                return Ok(super::source::ListOutcome::UnknownFolder(f.to_string()));
            }
        }
        if let Some(t) = tag {
            if t != "rust" {
                return Ok(super::source::ListOutcome::UnknownTag(t.to_string()));
            }
        }
        Ok(super::source::ListOutcome::Ok(self.notes.clone()))
    }

    fn search(&self, query: &str, _limit: u32) -> Result<super::source::SearchOutcome, String> {
        // 照真实取词口径的形状做：单字 = 拆不出词
        if query.chars().count() < 2 {
            return Ok(super::source::SearchOutcome::NoSearchableTerms);
        }
        if query.contains("并发") {
            Ok(super::source::SearchOutcome::Hits(self.notes.clone()))
        } else {
            Ok(super::source::SearchOutcome::NoMatch)
        }
    }

    fn folder_name(&self, _folder_id: &str) -> Option<String> {
        None
    }
}

/// 起一个监听随机端口的真 server，返回 base URL。
///
/// 端口用 0 而不是 17650：测试不能与用户真在跑的服务抢端口。
///
/// ⚠ **不用 `tauri::test::mock_app()`**。它看上去是正规做法，但它需要的
/// `tauri = { features = ["test"] }` 会让 getrandom 0.3 的 Windows 后端变成可达代码，
/// 于是 lib test 二进制静态导入 `bcryptprimitives.dll!ProcessPrng`——
/// 本机 Windows 11 build 22000 没这个导出（已用 dumpbin 核实），
/// 结果是**整个测试二进制启动即挂、一条测试都跑不了**（0xc0000139）。
/// 好在协议层本来也不需要 App：去掉它反而把 Ctx 简化了。
/// 假审计出口。W3 把审计接进 `build_router` 时，正是为了不破掉这批过线测试
/// 才把它做成 trait（直接持 `AppHandle` 的话，这里就构造不出 Router 了）。
/// 记下每一次 `record`，供断言「谁被记了、记了什么」。
#[derive(Default)]
struct RecordingAudit {
    /// (tool, args, ok, note_ids)
    calls: std::sync::Mutex<Vec<(String, String, bool, Vec<String>)>>,
}

impl super::audit::AuditSink for RecordingAudit {
    fn record(&self, _client: &str, tool: &str, args: &str, ok: bool, ids: &[String]) {
        if let Ok(mut g) = self.calls.lock() {
            g.push((tool.into(), args.into(), ok, ids.to_vec()));
        }
    }
}

async fn spawn_server() -> String {
    spawn_server_with_audit().await.0
}

async fn spawn_server_with_audit() -> (String, std::sync::Arc<RecordingAudit>) {
    let token = std::sync::Arc::new(std::sync::Mutex::new(TOKEN.to_string()));
    let kb: std::sync::Arc<dyn super::source::KbSource> = std::sync::Arc::new(FakeKb::new());
    let recorder = std::sync::Arc::new(RecordingAudit::default());
    let audit: std::sync::Arc<dyn super::audit::AuditSink> = recorder.clone();
    let router = super::server::build_router(audit, kb, token);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("绑定随机端口失败");
    let port = listener.local_addr().expect("取本地地址失败").port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    (format!("http://127.0.0.1:{}", port), recorder)
}

// ===== W3 审计 =====

#[tokio::test]
async fn test_audit_records_tool_calls_but_not_handshake() {
    let (base, rec) = spawn_server_with_audit().await;

    // 握手与工具表不碰笔记数据，记了只会把真正重要的那几条淡化在噪声里。
    rpc(&base, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}})).await;
    rpc(&base, json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})).await;
    assert!(
        rec.calls.lock().unwrap().is_empty(),
        "initialize / tools/list 不该进审计"
    );

    rpc(
        &base,
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call",
               "params":{"name":"kb_read","arguments":{"id":"n1"}}}),
    )
    .await;

    let calls = rec.calls.lock().unwrap();
    assert_eq!(calls.len(), 1, "只有 tools/call 产生审计");
    let (tool, args, ok, ids) = &calls[0];
    assert_eq!(tool, "kb_read");
    assert!(*ok);
    assert_eq!(ids, &vec!["n1".to_string()], "要记下读走的是哪一篇");
    // 🔴 W3 的根本约束：参数里只有参数，**永远不包含返回的笔记正文**。
    assert!(
        !args.contains("spawn_blocking"),
        "审计的 args 里不得出现笔记正文，实际: {}",
        args
    );
    assert!(args.contains("n1"), "但要保留参数本身");
}

#[tokio::test]
async fn test_audit_also_records_failed_tool_calls() {
    // 「试图读但没读成」也是信息——只记成功的等于把探测行为隐掉了。
    let (base, rec) = spawn_server_with_audit().await;
    rpc(
        &base,
        json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
               "params":{"name":"kb_nonexistent","arguments":{}}}),
    )
    .await;

    let calls = rec.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "kb_nonexistent");
    assert!(!calls[0].2, "未知工具应该记成 ok=false");
}

/// 发一个带正确令牌的 JSON-RPC 请求，返回（状态码，应答体）。
async fn rpc(base: &str, body: Value) -> (u16, Value) {
    let resp = reqwest::Client::new()
        .post(format!("{}/mcp", base))
        .header("authorization", format!("Bearer {}", TOKEN))
        .json(&body)
        .send()
        .await
        .expect("请求发送失败");
    let status = resp.status().as_u16();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    (status, v)
}

#[tokio::test]
async fn test_health_needs_no_token() {
    // /health 故意不鉴权：它存在的意义就是分清「服务没跑」与「令牌错」。
    let base = spawn_server().await;
    let resp = reqwest::get(format!("{}/health", base))
        .await
        .expect("请求失败");
    assert_eq!(resp.status(), 200);
    let v: Value = resp.json().await.expect("应为 JSON");
    assert_eq!(v["status"], "ok");
    assert_eq!(v["service"], "pastepanda-knowledge");
}

#[tokio::test]
async fn test_mcp_requires_token() {
    let base = spawn_server().await;
    let client = reqwest::Client::new();

    // 无令牌
    let r = client
        .post(format!("{}/mcp", base))
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .send()
        .await
        .expect("请求失败");
    assert_eq!(r.status(), 401, "无令牌必须 401");

    // 错令牌
    let r = client
        .post(format!("{}/mcp", base))
        .header("authorization", "Bearer wrong-token")
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .send()
        .await
        .expect("请求失败");
    assert_eq!(r.status(), 401, "错令牌必须 401");
}

#[tokio::test]
async fn test_foreign_origin_is_rejected_even_with_valid_token() {
    // 🔴 这条钉的是「两道门而不是一道」：外网网页里的 JS 能 fetch 本机端口，
    // 绑 127.0.0.1 拦不住它。假如令牌不小心泄了（比如用户把配置贴到了网上），
    // Origin 这道门就是最后一道。
    let base = spawn_server().await;
    let r = reqwest::Client::new()
        .post(format!("{}/mcp", base))
        .header("authorization", format!("Bearer {}", TOKEN))
        .header("origin", "https://evil.example.com")
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .send()
        .await
        .expect("请求失败");
    assert_eq!(r.status(), 403, "外网 Origin 必须 403，即使令牌是对的");
}

#[tokio::test]
async fn test_local_origin_passes() {
    // 反面例：本机页面（如 dev server）不能被误伤
    let base = spawn_server().await;
    let r = reqwest::Client::new()
        .post(format!("{}/mcp", base))
        .header("authorization", format!("Bearer {}", TOKEN))
        .header("origin", "http://localhost:1420")
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .send()
        .await
        .expect("请求失败");
    assert_eq!(r.status(), 200);
}

#[tokio::test]
async fn test_initialize_over_the_wire_echoes_version() {
    let base = spawn_server().await;
    let (status, v) = rpc(
        &base,
        json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-03-26", "clientInfo": { "name": "t", "version": "1" } }
        }),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(v["jsonrpc"], "2.0");
    assert_eq!(v["id"], 1);
    assert_eq!(v["result"]["protocolVersion"], "2025-03-26");
    assert_eq!(v["result"]["capabilities"]["tools"]["listChanged"], false);
}

#[tokio::test]
async fn test_tools_list_over_the_wire() {
    let base = spawn_server().await;
    let (status, v) = rpc(
        &base,
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
    )
    .await;
    assert_eq!(status, 200);
    let tools = v["result"]["tools"].as_array().cloned().unwrap_or_default();
    let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
    assert!(names.contains(&"kb_search"), "缺 kb_search：{:?}", names);
    assert!(names.contains(&"kb_read"), "缺 kb_read：{:?}", names);
    assert!(names.contains(&"kb_list"), "缺 kb_list：{:?}", names);
}

#[tokio::test]
async fn test_notifications_initialized_answers_with_null_id() {
    // HTTP 传输下必须回一个体，否则客户端会卡在握手第二步。
    let base = spawn_server().await;
    let (status, v) = rpc(
        &base,
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
    )
    .await;
    assert_eq!(status, 200);
    assert!(v["id"].is_null());
    assert!(v["result"].is_object());
}

#[tokio::test]
async fn test_unknown_method_and_bad_json() {
    let base = spawn_server().await;

    let (_, v) = rpc(
        &base,
        json!({ "jsonrpc": "2.0", "id": 9, "method": "resources/list" }),
    )
    .await;
    assert_eq!(v["error"]["code"], super::protocol::ERR_METHOD_NOT_FOUND);

    // 坏 JSON → -32700，而不是 400/500：客户端要能从 JSON-RPC 体里读到原因
    let r = reqwest::Client::new()
        .post(format!("{}/mcp", base))
        .header("authorization", format!("Bearer {}", TOKEN))
        .header("content-type", "application/json")
        .body("{not json")
        .send()
        .await
        .expect("请求失败");
    assert_eq!(r.status(), 200);
    let v: Value = r.json().await.expect("应为 JSON");
    assert_eq!(v["error"]["code"], super::protocol::ERR_PARSE);
}

#[tokio::test]
async fn test_tools_call_unknown_vs_placeholder() {
    let base = spawn_server().await;

    // 未知工具 = 协议层错误（JSON-RPC error）
    let (_, v) = rpc(
        &base,
        json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": { "name": "kb_delete_everything", "arguments": {} } }),
    )
    .await;
    assert_eq!(v["error"]["code"], super::protocol::ERR_INVALID_PARAMS);

    // 已知工具缺必填参数 = 仍然是协议层错误（参数不合法，不是执行失败）
    let (_, v) = rpc(
        &base,
        json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call",
                "params": { "name": "kb_search", "arguments": {} } }),
    )
    .await;
    assert_eq!(v["error"]["code"], super::protocol::ERR_INVALID_PARAMS);
}

/// 取一次 tools/call 的纯文本结果（方便断言）。
async fn call_text(base: &str, name: &str, args: Value) -> (String, bool) {
    let (_, v) = rpc(
        base,
        json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": { "name": name, "arguments": args } }),
    )
    .await;
    let text = v["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let is_error = v["result"]["isError"].as_bool().unwrap_or(false);
    (text, is_error)
}

#[tokio::test]
async fn test_kb_read_hit_and_miss() {
    let base = spawn_server().await;

    let (text, is_err) = call_text(&base, "kb_read", json!({ "id": "n1" })).await;
    assert!(!is_err);
    assert!(text.contains("Rust 并发笔记"), "全文里应有标题：{}", text);
    assert!(text.contains("spawn_blocking"), "全文里应有正文：{}", text);

    // 不存在的 id 要明说，不能假装成空内容
    let (text, is_err) = call_text(&base, "kb_read", json!({ "id": "不存在" })).await;
    assert!(is_err);
    assert!(text.contains("没有 id"), "{}", text);
}

#[tokio::test]
async fn test_kb_list_unknown_filter_does_not_degrade() {
    // 🔴 R6 的护栏：未知标签/文件夹必须明说，绝不能静默退化成
    // 「不筛，返回全库第一页」——那种退化对模型是隐形的，
    // 它会把无关的笔记当成符合条件的证据给用户。
    let base = spawn_server().await;

    let (text, is_err) = call_text(&base, "kb_list", json!({ "tag": "不存在的标签" })).await;
    assert!(is_err, "未知标签必须报错而不是返全库");
    assert!(text.contains("并未返回"), "要明说结果未返回：{}", text);
    assert!(
        !text.contains("Rust 并发笔记"),
        "不得顺手把笔记列出来：{}",
        text
    );

    let (text, is_err) = call_text(&base, "kb_list", json!({ "folder": "没这文件夹" })).await;
    assert!(is_err);
    assert!(!text.contains("Rust 并发笔记"), "{}", text);

    // 已知标签正常返回，且带 id（模型接下来要拿它调 kb_read）
    let (text, is_err) = call_text(&base, "kb_list", json!({ "tag": "rust" })).await;
    assert!(!is_err);
    assert!(text.contains("id=n1"), "列表里必须带 id：{}", text);
}

#[tokio::test]
async fn test_kb_search_distinguishes_two_kinds_of_empty() {
    // 🔴 两种「没结果」对模型的下一步完全不同，合并成空数组就只能让它猜，
    // 而它猜错的后果是告诉用户「你库里没记过」。
    let base = spawn_server().await;

    let (hit, is_err) = call_text(&base, "kb_search", json!({ "query": "并发" })).await;
    assert!(!is_err);
    assert!(hit.contains("id=n1"), "{}", hit);

    // 搜了但没命中
    let (miss, _) = call_text(&base, "kb_search", json!({ "query": "烤鱼" })).await;
    assert!(
        miss.contains("零命中不等于"),
        "要提醒模型别当成「库里没有」：{}",
        miss
    );

    // 问题里压根没拆出词（单字）——文案必须与上面不同，否则白分了
    let (no_terms, _) = call_text(&base, "kb_search", json!({ "query": "钱" })).await;
    assert!(no_terms.contains("没有可检索的词"), "{}", no_terms);
    assert_ne!(no_terms, miss, "两种空结果的文案不得相同");
}

#[tokio::test]
async fn test_batch_request_is_refused() {
    let base = spawn_server().await;
    let (_, v) = rpc(
        &base,
        json!([{ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }]),
    )
    .await;
    assert_eq!(v["error"]["code"], super::protocol::ERR_INVALID_REQUEST);
}

#[tokio::test]
async fn test_body_limit_layer_is_actually_wired() {
    // 中间件最容易出的错就是「写了但没生效」。超限请求必须被拦，
    // 而不是带着一个大体跑到 handler 里去。
    //
    // 断言得宽一点：服务器还在接体时就拒绝并关连接，客户端可能根本读不到
    // 413，而是看到一个连接中断（实测 Windows 上就是 ConnectionAborted）。
    // 两者都是「被拦住了」，只有拿到 200 才是真失败——那意味着层没生效。
    let base = spawn_server().await;
    let big = "a".repeat(2 * 1024 * 1024); // 2 MB > 1 MB 上限
    let sent = reqwest::Client::new()
        .post(format!("{}/mcp", base))
        .header("authorization", format!("Bearer {}", TOKEN))
        .header("content-type", "application/json")
        .body(big)
        .send()
        .await;
    match sent {
        Ok(r) => assert_ne!(r.status(), 200, "超过体上限的请求不应被正常处理"),
        Err(_) => { /* 连接被服务器提前断开，同样说明体上限生效了 */ }
    }
}

#[tokio::test]
async fn test_normal_sized_body_is_not_blocked_by_the_limit() {
    // 上一条的反面：体上限不能把正常请求也误伤。
    // 没这条的话，把上限设成 0 也能让上一条继续绿。
    let base = spawn_server().await;
    let (status, v) = rpc(
        &base,
        json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call",
                "params": { "name": "kb_search",
                            "arguments": { "query": "x".repeat(4096) } } }),
    )
    .await;
    assert_eq!(status, 200, "4 KB 的正常请求不得被体上限拦住");
    assert!(v["result"].is_object());
}
