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
    /// 七个写开关。测试靠它钉双层门。
    switches: super::gate::WriteSwitches,
    /// 真落到数据层的写调用：(方法, 目标, source)。
    ///
    /// 不真改 `notes`：本模块要钉的是 **MCP 层**（参数解析、门控、输出形状），
    /// 真写入行为由 `data_store::tests` 盖。而“到没到达数据层”恰好是门控的断言点。
    writes: std::sync::Mutex<Vec<(String, String, String)>>,
}

impl FakeKb {
    fn new() -> Self {
        Self::with_switches(super::gate::WriteSwitches::ALL_ON)
    }

    fn with_switches(switches: super::gate::WriteSwitches) -> Self {
        Self {
            notes: vec![
                fake_note(
                    "n1",
                    "Rust 并发笔记",
                    // AM-7：同时放一条真类别和两个任务复选框——
                    // 这正是真库里实测到的形状（3/3 命中全是复选框）。
                    "记了 tokio 与 spawn_blocking 的取舍。\n\n\
                     - [decision] 阻塞活儿一律丢给 spawn_blocking\n\
                     - [ ] 补一个压测\n\
                     - [x] 量过连接池上限\n",
                ),
                // 带多级标题的一篇，专供 `kb_sections` / `kb_read(section=)` 用。
                // n1 没有任何标题，它盖的是「无可寻址小节」那条路径——两者都要有。
                fake_note(
                    "n2",
                    "架构说明",
                    "开头的引言。\n\n## 架构\n\n总体分三层。\n\n### 数据流\n\n\
                     从剪贴板到库。\n\n## 部署\n\n暂无。",
                ),
                // n3 是**长篇**（> BRIEF_CHARS×2），专门盖 AM-2 的节级定位：
                // n1/n2 都太短，短篇会被阈值跳过，永远走不到那条路径。
                fake_note(
                    "n3",
                    "服务端问题汇总",
                    &format!(
                        "# 背景\n\n{}\n\n# 并发\n\n高并发下连接池会被打满，表现为请求排队。\n\
                         处理办法是限制单实例并发数并加超时。\n\n# 其它\n\n一些与本次无关的补充说明。",
                        "这一节只是填长度，不含查询词。".repeat(40)
                    ),
                ),
            ],
            switches,
            writes: std::sync::Mutex::new(Vec::new()),
        }
    }

    fn note_write(&self, method: &str, target: &str, source: &str) {
        if let Ok(mut g) = self.writes.lock() {
            g.push((method.into(), target.into(), source.into()));
        }
    }

    fn writes(&self) -> Vec<(String, String, String)> {
        self.writes.lock().map(|g| g.clone()).unwrap_or_default()
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

    fn search(
        &self,
        query: &str,
        folder: Option<&str>,
        tag: Option<&str>,
        kind: Option<&str>,
        _limit: u32,
    ) -> Result<super::source::SearchOutcome, String> {
        // 照真实取词口径的形状做：单字 = 拆不出词
        if query.chars().count() < 2 {
            return Ok(super::source::SearchOutcome::NoSearchableTerms);
        }
        // AM-1a：只认这一个文件夹 / 一个标签，其余一律报未知——
        // 目的是钉住「名字写错不得静默退化成全库搜」这条契约。
        if let Some(f) = folder {
            if f != "工作" {
                return Ok(super::source::SearchOutcome::UnknownFolder(f.to_string()));
            }
        }
        if let Some(t) = tag {
            if t != "重要" {
                return Ok(super::source::SearchOutcome::UnknownTag(t.to_string()));
            }
        }
        // AM-7：同 folder/tag 的口径——参数写错报错、筛空了要说清是「筛空的」
        // 而不是「没命中」。假源只认 decision 一个类别。
        if let Some(k) = kind {
            if !crate::markdown::annotate::is_kind_label(k) {
                return Ok(super::source::SearchOutcome::BadKind(k.to_string()));
            }
            if k != "decision" {
                return Ok(super::source::SearchOutcome::NoKindMatch {
                    kind: k.to_string(),
                    matched: self.notes.len(),
                });
            }
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

    // O-2：n2 有一条反链和一条断链，钉住 kb_read 会把两者都说出来。
    fn links_of(&self, id: &str) -> (Vec<String>, Vec<String>) {
        if id == "n2" {
            (vec!["Rust 并发笔记".into()], vec!["某个不存在的标题".into()])
        } else {
            (Vec::new(), Vec::new())
        }
    }

    // AM-8：假源里放一组真的标题近重复，钉住 kb_folders 会把它说出来。
    fn title_dups(&self) -> Vec<crate::similar::DupGroup> {
        crate::similar::find_dups(&["会议纪要模板".into(), "会议记要模板".into()])
    }

    // AM-6：假源不推库简介——那正是**默认行为**。
    // 拼接与标注的用例在 `protocol.rs` 的单测里（那里能直接喂一段文本）。
    fn library_blurb(&self) -> String {
        String::new()
    }

    fn folders(&self) -> Result<Vec<crate::data_store::NoteFolder>, String> {
        Ok(vec![serde_json::from_value(json!({
            "id": "f1", "name": "技术", "parent_id": null,
            "sort_order": 0, "created_at": "2026-09-01 10:00:00",
            "note_count": 1, "depth": 1,
        }))
        .expect("造假文件夹失败")])
    }

    fn note_tag_names(&self) -> Result<Vec<String>, String> {
        // AM-8：Java / java 是当初在真库实测到的那一组（2026-09-04）。
        //
        // ❗ 2026-09-05 更正：那一组是从**全库 38 个标签**里量出来的，
        // 而 `Java` / `java` 下一篇笔记都没有——它们是剪贴板的代码类型标签。
        // 本方法现在的语义是「笔记用到的标签」，这里仍然造这一组，
        // 为的是钉住「真有重名时 kb_folders 要报」这一支。
        Ok(vec!["Java".into(), "java".into(), "rust".into()])
    }

    fn create(
        &self,
        title: &str,
        content: &str,
        _folder: Option<&str>,
        source: &str,
    ) -> Result<crate::data_store::Note, String> {
        self.note_write("create", title, source);
        Ok(fake_note("new-1", title, content))
    }

    fn update(
        &self,
        id: &str,
        title: Option<&str>,
        _content: Option<&str>,
        source: &str,
    ) -> Result<(crate::data_store::Note, crate::data_store::NoteUpdateReport), String> {
        self.note_write("update", id, source);
        // 假实现不做链重写（O-9 落在 data_store 层，由那里的测试盖）。
        Ok((
            fake_note(id, title.unwrap_or("Rust 并发笔记"), "正文"),
            crate::data_store::NoteUpdateReport::default(),
        ))
    }

    fn append(
        &self,
        id: &str,
        _text: &str,
        source: &str,
    ) -> Result<crate::data_store::Note, String> {
        self.note_write("append", id, source);
        Ok(fake_note(id, "Rust 并发笔记", "正文"))
    }

    fn delete(&self, id: &str) -> Result<String, String> {
        self.note_write("delete", id, "");
        Ok("Rust 并发笔记".to_string())
    }

    fn restore(&self, id: &str) -> Result<String, String> {
        self.note_write("restore", id, "");
        Ok("Rust 并发笔记".to_string())
    }

    fn move_to(&self, id: &str, folder: Option<&str>) -> Result<String, String> {
        self.note_write("move", id, "");
        Ok(folder.unwrap_or("未分类").to_string())
    }

    fn edit_content(
        &self,
        id: &str,
        op: &crate::markdown::ContentEdit,
        source: &str,
    ) -> Result<(crate::data_store::Note, crate::markdown::EditReport), String> {
        self.note_write("edit", id, source);
        let old = self
            .notes
            .iter()
            .find(|n| n.id == id)
            .cloned()
            .ok_or_else(|| format!("没有 id 为 {} 的笔记（或它已在回收站里）。", id))?;
        // 真跑一遍变换：本模块要测的是「参数解析对不对、报错文案对不对」，
        // 而这两件事都依赖变换的真实结果。不落库（同本文件其它写方法的口径）。
        //
        // ❗ `edit_on` 里「内容未变则不写」那一支本假实现盖不到（它需要真库）。
        let (content, report) = crate::markdown::apply(&old.content, op)?;
        let mut fresh = old;
        fresh.content = content;
        Ok((fresh, report))
    }

    fn tag(
        &self,
        id: &str,
        add: &[String],
        remove: &[String],
    ) -> Result<(usize, usize), String> {
        self.note_write("tag", id, "");
        Ok((add.len(), remove.len()))
    }

    fn write_switches(&self) -> super::gate::WriteSwitches {
        self.switches
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

/// 带指定开关起服务，并把假数据源一并递出来——
/// 测双层门靠的就是“写调用到没到达数据层”。
async fn spawn_server_with_switches(
    switches: super::gate::WriteSwitches,
) -> (String, std::sync::Arc<FakeKb>) {
    let token = std::sync::Arc::new(std::sync::Mutex::new(TOKEN.to_string()));
    let fake = std::sync::Arc::new(FakeKb::with_switches(switches));
    let kb: std::sync::Arc<dyn super::source::KbSource> = fake.clone();
    let audit: std::sync::Arc<dyn super::audit::AuditSink> =
        std::sync::Arc::new(RecordingAudit::default());
    let router = super::server::build_router(audit, kb, token);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("绑定随机端口失败");
    let port = listener.local_addr().expect("取本地地址失败").port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    (format!("http://127.0.0.1:{}", port), fake)
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

/// 带指定 User-Agent 发。M5 靠它钉 `source_agent` 的来源（UA 而不是 clientInfo）。
async fn rpc_as(base: &str, ua: &str, body: Value) -> (u16, Value) {
    let resp = reqwest::Client::new()
        .post(format!("{}/mcp", base))
        .header("authorization", format!("Bearer {}", TOKEN))
        .header("user-agent", ua)
        .json(&body)
        .send()
        .await
        .expect("请求发送失败");
    let status = resp.status().as_u16();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    (status, v)
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

// ===== M5 写入能力 =====

/// 从 `tools/list` 应答里拿工具名。
fn tool_names(v: &Value) -> Vec<String> {
    v["result"]["tools"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|t| t["name"].as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn test_all_eleven_tools_listed_when_switches_on() {
    let (base, _) = spawn_server_with_switches(super::gate::WriteSwitches::ALL_ON).await;
    let (_, v) = rpc(&base, json!({"jsonrpc":"2.0","id":1,"method":"tools/list"})).await;
    let names = tool_names(&v);
    assert_eq!(names.len(), 16, "全开时应有 16 个工具，实际：{:?}", names);
    for expect in ["kb_folders", "kb_create", "kb_append", "kb_delete", "kb_restore"] {
        assert!(names.contains(&expect.to_string()), "丢了 {}", expect);
    }
}

#[tokio::test]
async fn test_switch_off_hides_tool_from_list() {
    let (base, _) = spawn_server_with_switches(super::gate::WriteSwitches::ALL_OFF).await;
    let (_, v) = rpc(&base, json!({"jsonrpc":"2.0","id":1,"method":"tools/list"})).await;
    let names = tool_names(&v);
    // 外层门：没开放的工具模型根本看不到。
    assert_eq!(names.len(), 5, "全关时只应剩五个只读工具，实际：{:?}", names);
    assert!(!names.iter().any(|n| n == "kb_delete"));
}

// ===== O-8 阶段 2：section 层的只读面 =====

#[tokio::test]
async fn test_sections_lists_outline_with_labels_and_child_count() {
    let base = spawn_server().await;
    let (text, is_err) = call_text(&base, "kb_sections", json!({ "id": "n2" })).await;
    assert!(!is_err, "{}", text);
    assert!(text.contains("共 4 节"), "节数不对：{}", text);
    // 序号与标题路径双写（已拍板）——两种定位方式都要能从大纲里拿到。
    assert!(text.contains("[1] 架构"), "缺序号+标题：{}", text);
    assert!(text.contains("[2] 架构 / 数据流"), "缺完整路径：{}", text);
    // 节是平的，所以必须告知子节数，否则模型以为改一节就改了整棵子树。
    assert!(text.contains("含 1 个子节"), "未告知子节：{}", text);
    // 不返正文：这是它存在的意义（省上下文）。
    assert!(!text.contains("总体分三层"), "大纲不得带正文：{}", text);
}

#[tokio::test]
async fn test_sections_on_note_without_headings_says_no_addressable_sections() {
    // 🔴 剪贴板直接存的笔记大多没标题。不明说的话，模型会以为
    // 自己接下来在做精准编辑，实际上那等于整篇覆盖。
    let base = spawn_server().await;
    let (text, is_err) = call_text(&base, "kb_sections", json!({ "id": "n1" })).await;
    assert!(!is_err, "{}", text);
    assert!(text.contains("没有可寻址的小节"), "{}", text);
}

#[tokio::test]
async fn test_read_section_by_index_and_by_path() {
    let base = spawn_server().await;

    let (by_idx, is_err) = call_text(&base, "kb_read", json!({ "id": "n2", "index": 1 })).await;
    assert!(!is_err, "{}", by_idx);
    assert!(by_idx.contains("总体分三层"), "没拿到该节正文：{}", by_idx);
    // 只取一节时必须告知这是部分内容，否则模型会当全文用。
    assert!(by_idx.contains("全篇共 4 节"), "未告知是节选：{}", by_idx);
    assert!(by_idx.contains("它还有 1 个子节"), "未告知子节未包含：{}", by_idx);
    assert!(!by_idx.contains("暂无。"), "不得把「部署」节带出来：{}", by_idx);

    let (by_path, is_err) =
        call_text(&base, "kb_read", json!({ "id": "n2", "section": "数据流" })).await;
    assert!(!is_err, "{}", by_path);
    assert!(by_path.contains("从剪贴板到库"), "按路径尾段没命中：{}", by_path);
}

#[tokio::test]
async fn test_read_rejects_both_section_and_index() {
    // 🔴 两个都给时不挑一个：挑错了就是返回了别的一节，
    // 而模型拿到的内容看起来完全正常（规则 #15.3）。
    let base = spawn_server().await;
    let (_, v) = rpc(
        &base,
        json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
               "params":{"name":"kb_read",
                         "arguments":{"id":"n2","index":1,"section":"架构"}}}),
    )
    .await;
    let msg = v["error"]["message"].as_str().unwrap_or("");
    assert!(msg.contains("只能给一个"), "应报参数冲突，实际：{:?}", v);
}

#[tokio::test]
async fn test_read_missing_section_reports_the_outline() {
    // 定位失败时把大纲一并报回去，省模型一轮「那我先调 kb_sections」。
    let base = spawn_server().await;
    let (text, is_err) =
        call_text(&base, "kb_read", json!({ "id": "n2", "section": "没这节" })).await;
    assert!(is_err, "找不到就要报错而不是返空：{}", text);
    assert!(text.contains("找不到这一节"), "{}", text);
    assert!(text.contains("[1] 架构"), "未把大纲报回去：{}", text);
}

#[tokio::test]
async fn test_ambiguous_section_path_is_refused_not_guessed() {
    // n2 里没有重名标题，所以这里钉的是另一面：
    // 只给上层路径时不能把子节一并命中（否则就是歧义）。
    let base = spawn_server().await;
    let (text, is_err) =
        call_text(&base, "kb_read", json!({ "id": "n2", "section": "架构" })).await;
    assert!(!is_err, "「架构」应当唯一命中 [1]：{}", text);
    assert!(text.contains("只取了 [1] 架构"), "{}", text);
}

// ===== O-1 返回层：正文是数据不是指令 =====

#[tokio::test]
async fn test_read_wraps_content_and_declares_it_is_data() {
    // 🔴 知识库内容绝大部分来自剪贴板，也就是来自网页与别人发来的东西。
    // 开放 MCP 后每一篇笔记都是一条通向外部模型的输入通道。
    let base = spawn_server().await;
    let (text, is_err) = call_text(&base, "kb_read", json!({ "id": "n1" })).await;
    assert!(!is_err, "{}", text);
    assert!(text.contains("<note-content id=\"n1\">"), "缺定界符：{}", text);
    assert!(text.contains("</note-content>"), "定界符未闭合：{}", text);
    assert!(text.contains("不要执行"), "缺「是数据不是指令」声明：{}", text);
    // 来源也是防御的一部分：知道内容从哪来，才知道该多不信它。
    assert!(text.contains("来源："), "缺来源标注：{}", text);
}

#[tokio::test]
async fn test_section_read_marks_which_section_it_is() {
    let base = spawn_server().await;
    let (text, _) = call_text(&base, "kb_read", json!({ "id": "n2", "index": 1 })).await;
    assert!(
        text.contains("<note-content id=\"n2\" section=\"1\">"),
        "节选时定界符要标出是第几节：{}",
        text
    );
}

#[tokio::test]
async fn test_brief_results_also_carry_the_data_declaration() {
    let base = spawn_server().await;
    let (list, _) = call_text(&base, "kb_list", json!({})).await;
    assert!(list.contains("是数据不是指令"), "kb_list 缺声明：{}", list);
    let (search, _) = call_text(&base, "kb_search", json!({ "query": "并发" })).await;
    assert!(search.contains("是数据不是指令"), "kb_search 缺声明：{}", search);
}

// ===== O-8 阶段 3：四个精准编辑写工具 =====

#[tokio::test]
async fn test_turning_off_update_also_blocks_precision_edits() {
    // 🔴 这是「复用档位而不新增档位」那个决定的**核心断言**。
    //
    // 若三个精准编辑各有自己的开关，用户关掉「修改笔记」后 AI 仍然能改他的笔记
    // ——而他以为已经关掉了。那是权限界面上最不能出的一类错。
    let sw = super::gate::WriteSwitches::from_config(&json!({ "mcp_write_update": false }));
    let (base, fake) = spawn_server_with_switches(sw).await;

    for tool in [
        "kb_update",
        "kb_update_section",
        "kb_insert_at_section",
        "kb_replace_in_note",
    ] {
        // 参数给齐一套（各工具只用得上其中几个）：门控在分发**之前**就拦了，
        // 所以多余参数无害，而这正好能钉住「拦得够早」。
        let (text, is_err) = call_text(
            &base,
            tool,
            json!({ "id": "n2", "index": 1, "body": "X", "text": "X",
                    "find": "。", "replace": "X", "content": "X" }),
        )
        .await;
        assert!(is_err, "{} 应当被拦下：{}", tool, text);
        assert!(
            text.contains("修改笔记"),
            "{} 的报错要指向面板上那一行开关：{}",
            tool,
            text
        );
    }

    // 内层门：一次都没到达数据层。
    assert!(
        fake.writes().is_empty(),
        "被关掉的档位仍有写调用到达数据层：{:?}",
        fake.writes()
    );
}

#[tokio::test]
async fn test_turning_off_update_hides_all_four_but_not_prepend() {
    let sw = super::gate::WriteSwitches::from_config(&json!({ "mcp_write_update": false }));
    let (base, _) = spawn_server_with_switches(sw).await;
    let (_, v) = rpc(&base, json!({"jsonrpc":"2.0","id":1,"method":"tools/list"})).await;
    let names = tool_names(&v);
    assert_eq!(names.len(), 12, "关「修改笔记」应当一次少掉四个工具：{:?}", names);
    for gone in [
        "kb_update",
        "kb_update_section",
        "kb_insert_at_section",
        "kb_replace_in_note",
    ] {
        assert!(!names.iter().any(|n| n == gone), "{} 还在表里", gone);
    }
    // 反面：复用档位不得**过度**门控。kb_prepend 归「追加内容」，不该被牵连。
    assert!(
        names.iter().any(|n| n == "kb_prepend"),
        "kb_prepend 归「追加内容」，不该跟着被关：{:?}",
        names
    );
}

#[tokio::test]
async fn test_prepend_goes_through_the_append_switch() {
    let sw = super::gate::WriteSwitches::from_config(&json!({ "mcp_write_append": false }));
    let (base, fake) = spawn_server_with_switches(sw).await;
    let (text, is_err) = call_text(&base, "kb_prepend", json!({ "id": "n2", "text": "X" })).await;
    assert!(is_err, "{}", text);
    assert!(text.contains("追加内容"), "报错要指向那一行开关：{}", text);
    assert!(fake.writes().is_empty());
}

#[tokio::test]
async fn test_update_section_reports_what_changed_and_what_did_not() {
    let base = spawn_server().await;
    let (text, is_err) = call_text(
        &base,
        "kb_update_section",
        json!({ "id": "n2", "index": 1, "body": "改写后的架构说明。" }),
    )
    .await;
    assert!(!is_err, "{}", text);
    assert!(text.contains("[1] 架构"), "要说清改了哪一节：{}", text);
    // 节是平的，子节没被动这件事必须说出来。
    assert!(text.contains("还有 1 个子节"), "未告知子节未被改：{}", text);
}

#[tokio::test]
async fn test_precision_edit_requires_a_locator() {
    // 🔴 不给定位符不能默认整篇：一次手误就从「改一节」变成「覆盖全文」。
    let base = spawn_server().await;
    let (_, v) = rpc(
        &base,
        json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
               "params":{"name":"kb_update_section",
                         "arguments":{"id":"n2","body":"X"}}}),
    )
    .await;
    let msg = v["error"]["message"].as_str().unwrap_or("");
    assert!(msg.contains("section"), "{:?}", v);
    assert!(msg.contains("kb_update"), "要指出想改整篇该用哪个工具：{:?}", v);
}

#[tokio::test]
async fn test_update_section_needs_body_explicitly_but_empty_string_is_allowed() {
    // 🔴 空串 = 「清空这一节」，缺参数 = 「忘了传」。
    // 混起来会让一次手误静默清掉一节正文，所以不能用 arg_str（它将两者归一）。
    let base = spawn_server().await;
    let (_, v) = rpc(
        &base,
        json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
               "params":{"name":"kb_update_section",
                         "arguments":{"id":"n2","index":1}}}),
    )
    .await;
    assert!(
        v["error"]["message"].as_str().unwrap_or("").contains("body"),
        "缺 body 要报错：{:?}",
        v
    );

    let (text, is_err) = call_text(
        &base,
        "kb_update_section",
        json!({ "id": "n2", "index": 1, "body": "" }),
    )
    .await;
    assert!(!is_err, "空串是合法的「清空」意图：{}", text);
}

#[tokio::test]
async fn test_insert_rejects_an_unknown_position() {
    // 不静默兜成默认值：模型以为插在开头、实际插在末尾，而它看不出来。
    let base = spawn_server().await;
    let (_, v) = rpc(
        &base,
        json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
               "params":{"name":"kb_insert_at_section",
                         "arguments":{"id":"n2","index":1,"text":"X","position":"top"}}}),
    )
    .await;
    assert!(
        v["error"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("before / start / end"),
        "{:?}",
        v
    );
}

#[tokio::test]
async fn test_replace_in_note_refuses_when_not_unique() {
    // n2 里有四个句号。全换或只换第一处都是模型看不出来的错。
    let base = spawn_server().await;
    let (text, is_err) = call_text(
        &base,
        "kb_replace_in_note",
        json!({ "id": "n2", "find": "。", "replace": "！" }),
    )
    .await;
    assert!(is_err, "多处命中要报错：{}", text);
    assert!(text.contains("一处也没改"), "{}", text);
}

#[tokio::test]
async fn test_stale_client_still_cannot_write_after_switch_off() {
    // 🔴 这是 M5 最重要的一条。
    //
    // 规划里说「没开放的工具模型根本不知道它存在」——但客户端会**缓存工具表**，
    // 早就 list 过的会话手里还握着旧表。所以本用例**根本不调 tools/list**，
    // 直接发 tools/call，模拟那个旧会话。
    let (base, fake) = spawn_server_with_switches(super::gate::WriteSwitches::ALL_OFF).await;
    let (status, v) = rpc(
        &base,
        json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
               "params":{"name":"kb_delete","arguments":{"id":"n1"}}}),
    )
    .await;

    assert_eq!(status, 200);
    assert_eq!(v["result"]["isError"], true, "被关的工具必须报失败");
    let text = v["result"]["content"][0]["text"].as_str().unwrap_or("");
    assert!(text.contains("关闭"), "未明说是被用户关掉了：{}", text);
    assert!(text.contains("请勿重试"), "未叫它不要重试：{}", text);
    // 真正的断言：写调用**根本没到达数据层**。
    assert!(
        fake.writes().is_empty(),
        "开关关着却真的删到了数据层：{:?}",
        fake.writes()
    );
}

#[tokio::test]
async fn test_only_the_closed_switch_is_blocked() {
    // 关「删除」不能误伤「新建」——一档开关只管一个工具。
    let sw = super::gate::WriteSwitches::from_config(&json!({ "mcp_write_delete": false }));
    let (base, fake) = spawn_server_with_switches(sw).await;

    let (_, v) = rpc(
        &base,
        json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
               "params":{"name":"kb_delete","arguments":{"id":"n1"}}}),
    )
    .await;
    assert_eq!(v["result"]["isError"], true);

    let (_, v) = rpc(
        &base,
        json!({"jsonrpc":"2.0","id":2,"method":"tools/call",
               "params":{"name":"kb_create","arguments":{"title":"新篇","content":"正文"}}}),
    )
    .await;
    assert!(v["result"].get("isError").is_none(), "新建被误伤了：{:?}", v);
    let writes = fake.writes();
    assert_eq!(writes.len(), 1, "只应有新建那一条到达数据层：{:?}", writes);
    assert_eq!(writes[0].0, "create");
}

#[tokio::test]
async fn test_write_stamps_source_from_user_agent() {
    // 🔴 来源取 User-Agent 而不是 clientInfo（A-53），并且只取名字不取版本：
    // 带版本号的话，客户端一升级，历史列表里就多出一个看似不同的来源。
    let (base, fake) = spawn_server_with_switches(super::gate::WriteSwitches::ALL_ON).await;
    rpc_as(
        &base,
        "claude-code/2.1.233 (sdk-cli)",
        json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
               "params":{"name":"kb_append","arguments":{"id":"n1","text":"补一段"}}}),
    )
    .await;
    let writes = fake.writes();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].2, "agent:claude-code");
}

#[tokio::test]
async fn test_write_source_never_empty_without_user_agent() {
    // 🔴 空串在 W2 里的语义是「人亲自改的」——传空就把锚定快照静默关掉了。
    // 没 UA 的客户端也得落一个非空来源，宁可不精确。
    let (base, fake) = spawn_server_with_switches(super::gate::WriteSwitches::ALL_ON).await;
    rpc(
        &base,
        json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
               "params":{"name":"kb_update","arguments":{"id":"n1","title":"改个名"}}}),
    )
    .await;
    let writes = fake.writes();
    assert_eq!(writes.len(), 1);
    assert!(!writes[0].2.is_empty(), "没 UA 也不能落空来源");
    assert!(writes[0].2.starts_with("agent:"));
}

#[tokio::test]
async fn test_kb_folders_lists_names_and_warns_no_autocreate() {
    // kb_folders 是选 c（全量工具集）拍板后的必需品：
    // 没它的话 kb_move / kb_tag 无从下手（模型看不到有哪些文件夹与标签）。
    let (base, _) = spawn_server_with_switches(super::gate::WriteSwitches::ALL_ON).await;
    let (_, v) = rpc(
        &base,
        json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
               "params":{"name":"kb_folders","arguments":{}}}),
    )
    .await;
    let text = v["result"]["content"][0]["text"].as_str().unwrap_or("");
    assert!(text.contains("技术"), "未列出文件夹：{}", text);
    assert!(text.contains("rust"), "未列出标签：{}", text);
    // 不告知的后果：模型自己编个名字传进 kb_move，每次都失败而不知道为何。
    assert!(
        text.contains("不会自动新建"),
        "未告知不自动新建文件夹/标签：{}",
        text
    );
}

#[tokio::test]
async fn test_kb_folders_is_available_even_with_all_writes_off() {
    // 它是**只读**工具，不占写开关。写全关时也得能用：
    // kb_list 的 folder / tag 参数本身就靠它才能填对。
    let (base, _) = spawn_server_with_switches(super::gate::WriteSwitches::ALL_OFF).await;
    let (_, v) = rpc(
        &base,
        json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
               "params":{"name":"kb_folders","arguments":{}}}),
    )
    .await;
    assert!(v["result"].get("isError").is_none(), "只读工具被写开关误伤：{:?}", v);
}

// ===== AM-2 节级命中 =====

/// 命中一篇长笔记时，要指出**最相关的那一节**，而不是只丢 200 字摘要。
///
/// 🔴 这条盯的是实测里最痛的一点：本机库平均一篇 9,043 字、中位 5,425 字，
/// 只回 200 字摘要 ≈ 什么都没给——模型要么据此瞎猜，要么再花一轮把全文拉回来。
#[tokio::test]
async fn test_kb_search_points_at_the_most_relevant_section() {
    let base = spawn_server().await;
    let (text, is_err) = call_text(&base, "kb_search", json!({ "query": "并发问题" })).await;
    assert!(!is_err, "{}", text);
    // ❗ 必须带冒号：末尾的引导语里也写了「最相关的节」，
    //   不带冒号的断言会**恒为真**——第一版就是这么写的，把真失败盖住了。
    assert!(text.contains("最相关的节："), "长笔记应给出节级定位：{}", text);
    // 序号要能直接喂给 kb_read(section=)；指错节比不指更坏，模型会拿无关正文去回答
    assert!(text.contains("· [2] 并发"), "该指到「并发」那一节（序号 2）：{}", text);
}

/// 短笔记**不该**再多给一段节级定位：它的 200 字摘要已经就是全文，再列一遍是纯噪声。
///
/// 假数据源里三篇只有 n3 是长篇，所以整段输出里「最相关的节」只该出现一次。
#[tokio::test]
async fn test_kb_search_skips_section_hits_for_short_notes() {
    let base = spawn_server().await;
    let (text, _) = call_text(&base, "kb_search", json!({ "query": "并发问题" })).await;
    assert_eq!(
        text.matches("最相关的节：").count(),
        1,
        "短笔记也被塞了节级定位：{}",
        text
    );
}

// ===== AM-1a 检索范围参数 =====

/// `folder` / `tag` 要真的传到底层，而不是像以前那样在 MCP 层被硬编码成空。
///
/// 🔴 名字写错时必须**明确报错**，绝不能静默退化成全库搜——
/// 后者会让模型把「文件夹名写错了」读成「这个文件夹里确实没有」，
/// 然后带着错结论往下走，而那个错从输出上完全看不出来（R6）。
#[tokio::test]
async fn test_kb_search_scope_is_not_silently_widened() {
    let base = spawn_server().await;

    // 认识的文件夹：正常出结果
    let (ok, is_err) =
        call_text(&base, "kb_search", json!({ "query": "并发问题", "folder": "工作" })).await;
    assert!(!is_err, "{}", ok);
    assert!(ok.contains("找到"), "范围内应当有结果：{}", ok);

    // 不认识的文件夹：报错，而不是把全库结果端上来
    let (bad, is_err) =
        call_text(&base, "kb_search", json!({ "query": "并发问题", "folder": "不存在的夹子" })).await;
    assert!(is_err, "未知文件夹必须报错，实得：{}", bad);
    assert!(!bad.contains("找到"), "报错时不能同时给出全库结果：{}", bad);

    let (badtag, is_err) =
        call_text(&base, "kb_search", json!({ "query": "并发问题", "tag": "没这个标签" })).await;
    assert!(is_err, "未知标签必须报错，实得：{}", badtag);
}

/// 零命中时要**把范围说出来**，否则模型会当成全库都没有。
#[tokio::test]
async fn test_kb_search_zero_hit_says_which_scope() {
    let base = spawn_server().await;
    // 「工作」是认识的文件夹，但查询词不含「并发」→ 假源返回 NoMatch
    let (text, _) =
        call_text(&base, "kb_search", json!({ "query": "毫不相干", "folder": "工作" })).await;
    assert!(
        text.contains("工作"),
        "零命中必须说明是在哪个范围内没找到：{}",
        text
    );
}

// ===== AM-7 行内类别 =====

/// `kind` 的三种结果必须**互相分得开**：写错了 / 筛空了 / 有结果。
///
/// 🔴 这三者混成一句「没找到」是最坏的失败模式：模型会把自己的笔误
/// 读成「库里确实没有」，然后带着错结论继续往下走，而那个错从输出上看不出来。
#[tokio::test]
async fn test_kb_search_kind_三种结果互不混淆() {
    let base = spawn_server().await;

    // ① 合法且假源认识 → 正常出结果
    let (ok, is_err) = call_text(
        &base,
        "kb_search",
        json!({ "query": "并发问题", "kind": "decision" }),
    )
    .await;
    assert!(!is_err, "{}", ok);
    assert!(ok.contains("找到"), "该有结果：{}", ok);

    // ② 类别名不合法 → 报错，且不能顺手把全库结果端上来
    let (bad, is_err) = call_text(
        &base,
        "kb_search",
        json!({ "query": "并发问题", "kind": "my note" }),
    )
    .await;
    assert!(is_err, "不合法的类别名必须报错，实得：{}", bad);
    assert!(!bad.contains("找到"), "报错时不能同时给结果：{}", bad);

    // ③ 合法但没一篇记过 → 不是报错，但要说清「是被筛掉的」
    let (none, is_err) = call_text(
        &base,
        "kb_search",
        json!({ "query": "并发问题", "kind": "todo" }),
    )
    .await;
    assert!(!is_err, "筛空不是错误：{}", none);
    assert!(
        none.contains("匹配到") && none.contains("没有一篇"),
        "必须说清是「有命中但被类别筛掉」而不是「没命中」：{}",
        none
    );
}

/// 任务复选框不能让 `kind` 报错——`x` 被排除是**设计**，错误信息要讲明白。
#[tokio::test]
async fn test_kb_search_kind_排除任务复选框且说明原因() {
    let base = spawn_server().await;
    let (text, is_err) =
        call_text(&base, "kb_search", json!({ "query": "并发问题", "kind": "x" })).await;
    assert!(is_err, "x 必须被拒：{}", text);
    assert!(
        text.contains("复选框"),
        "得说清为什么拒，否则模型只会换个写法再试一次：{}",
        text
    );
}

/// 命中结果里要带上这篇记过哪些类别——否则 `kind` 参数没人会用。
#[tokio::test]
async fn test_kb_search_命中里列出类别() {
    let base = spawn_server().await;
    let (text, _) = call_text(&base, "kb_search", json!({ "query": "并发问题" })).await;
    assert!(
        text.contains("记有类别：") && text.contains("decision"),
        "假源里那篇写了 - [decision]，结果里应当列出来：{}",
        text
    );
}

// ===== AM-8 近重复 =====

/// `kb_folders` 要把「按名字寻址会撞车」的两类都说出来：标签与标题。
///
/// 🔴 为什么放在这里而不是另开工具（AM-6 的教训）：
/// 需要人主动去点的检查最后没人点。这条只在**真有重复时**才占字，
/// 而它出现的时机正好是模型准备按名字选标签/建链的那一刻。
#[tokio::test]
async fn test_kb_folders_报告近重复的标签与标题() {
    let base = spawn_server().await;
    let (text, is_err) = call_text(&base, "kb_folders", json!({})).await;
    assert!(!is_err, "{}", text);

    assert!(
        text.contains("疑似重复的标签") && text.contains("Java / java"),
        "大小写不同的同一个标签必须报出来：{}",
        text
    );
    assert!(
        text.contains("几乎一定是同一个"),
        "强候选要说得比弱候选肯定：{}",
        text
    );
    assert!(
        text.contains("疑似重复的笔记标题") && text.contains("会议纪要模板"),
        "标题近重复也要报——[[链接]] 断了不会有任何报错：{}",
        text
    );
    assert!(
        text.contains("不要自己选一个"),
        "必须明确要求交给用户确认，否则模型会自己挑一个然后往下走：{}",
        text
    );
}

// ===== O-2 反链与断链 =====

/// `kb_read` 读整篇时要带上反链与断链——这是「反链面板」的 AI 侧等价物，不需要界面。
#[tokio::test]
async fn test_kb_read_带上反链与断链() {
    let base = spawn_server().await;
    let (text, is_err) = call_text(&base, "kb_read", json!({ "id": "n2" })).await;
    assert!(!is_err, "{}", text);

    assert!(
        text.contains("被 1 篇引用") && text.contains("Rust 并发笔记"),
        "反链没带上：{}",
        text
    );
    assert!(
        text.contains("断链") && text.contains("某个不存在的标题"),
        "断链没带上：{}",
        text
    );
    assert!(
        text.contains("不代表相关内容不存在"),
        "断链必须说清「不是库里没有，是这个标题找不到」，否则模型会当成结论：{}",
        text
    );
}

/// 读**单节**时不带链关系：那时模型要的是那一节的内容，篇级的链是噪声。
#[tokio::test]
async fn test_kb_read_读单节时不带链关系() {
    let base = spawn_server().await;
    // ❗ 数字序号那个参数叫 `index`；`section` 收的是**标题路径字串**。
    //   传错了不会报错，只是退回整篇——第一版就这么写的，当时这条断言红了。
    let (text, is_err) = call_text(&base, "kb_read", json!({ "id": "n2", "index": 1 })).await;
    assert!(!is_err, "{}", text);
    assert!(!text.contains("被 1 篇引用"), "读单节不该带反链：{}", text);
}

/// 没有链的笔记**一个字都不该多**。
#[tokio::test]
async fn test_kb_read_没有链时不占位() {
    let base = spawn_server().await;
    let (text, _) = call_text(&base, "kb_read", json!({ "id": "n1" })).await;
    assert!(!text.contains("引用"), "n1 没有链，不该出现相关字样：{}", text);
    assert!(!text.contains("断链"), "{}", text);
}
