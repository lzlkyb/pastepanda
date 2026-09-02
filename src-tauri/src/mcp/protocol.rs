//! MCP 的 JSON-RPC 2.0 协议层。**手写，不引任何 MCP SDK crate。**
//!
//! 完整的 MCP 规范很大（resources / prompts / sampling / roots / 订阅……），
//! 但一个**只提供工具**的服务实际只需四个方法（已对照 cc-bridge 的
//! `src/mcp/http.rs` 核实，它线上跑的也就这四个）：
//!
//! | 方法 | 作用 |
//! |---|---|
//! | `initialize` | 握手，商定协议版本与能力 |
//! | `notifications/initialized` | 客户端握手完成通知 |
//! | `tools/list` | 列工具 |
//! | `tools/call` | 调工具 |
//!
//! 其余一律返 `-32601`（方法不存在），而不是假装支持。
//!
//! ⚠ 没抄 cc-bridge 的工具注册表 + `ToolSchema` derive 宏：那套是为它 **17 个工具**
//! 的重复维护痛点做的（见它的 RFC《手写 dispatch 折中重构》）；本服务起步只有 3 个
//! 只读工具，手写三件套完全可控。等真加到 6 个以上再抄那套宏。

use serde_json::{json, Value};

use super::gate::WriteSwitches;

/// 客户端没告知协议版本时的回退值。
///
/// 🔴 **不要把它当成“服务端固定版本”写进应答。** cc-bridge 在这里真撞过坑：
/// 它曾把应答的 `protocolVersion` 写成一个**根本不存在的版本号**，
/// 客户端升降级后协商直接失败。正确做法是**回显客户端请求的那个版本**，
/// 只在它没传时才用这个回退值。
const FALLBACK_PROTOCOL_VERSION: &str = "2025-06-18";

// ===== JSON-RPC 错误码（规范固定值）=====
pub const ERR_PARSE: i32 = -32700;
pub const ERR_INVALID_REQUEST: i32 = -32600;
pub const ERR_METHOD_NOT_FOUND: i32 = -32601;
pub const ERR_INVALID_PARAMS: i32 = -32602;
pub const ERR_INTERNAL: i32 = -32603;

/// 告诉模型这个服务是干什么的。
///
/// 写得具体一点是有回报的：模型靠它判「该不该查知识库」。特别要说清
/// **只读、只涵盖笔记**，否则模型会拿它当剪贴板历史的入口去试。
fn server_instructions(switches: &WriteSwitches) -> String {
    let mut s = String::from(if switches.any_on() {
        "PastePanda 个人知识库。提供对本机笔记的检索、读取与**写入**。\n\n"
    } else {
        "PastePanda 个人知识库。提供对本机笔记的**只读**检索与读取。\n\n"
    });
    s.push_str(
        "适用时机：用户问到他自己记过的东西（方案、踩过的坑、配置、摘录），\
         或者需要他个人积累的上下文而不是通用知识时。\n\n\
         边界：仅覆盖**笔记**，不包含剪贴板历史。\n\n",
    );
    if switches.any_on() {
        s.push_str(
            "写入约定：\n\
             ・每次写入都会计入用户可见的调用记录，并在笔记上标注改动来源；\n\
             ・删除只能删到**回收站**（可恢复），没有彻底删除的工具；\n\
             ・文件夹与标签是用户自己的组织方式，**不要主动帮他重排**，也不会自动新建；\n\
             ・写权限可以被用户逐项关掉。被关时工具会明确告知，\
             那时**不要重试、不要绕路**，直接告诉用户去设置里打开。\n\
             ・“今日速记”不开放写入，那是用户热键专用的。",
        );
    } else {
        s.push_str("全部工具都不会写入或修改任何数据。");
    }
    s
}

/// 从请求体里把 `id` 拿出来。
///
/// 拿不到就用 `null`——JSON-RPC 规范要求错误应答必须带 `id`，
/// 连解析都失败时它就是 `null`。
fn id_of(req: &Value) -> Value {
    req.get("id").cloned().unwrap_or(Value::Null)
}

/// 拼一个成功应答。
pub fn ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// 拼一个错误应答。
pub fn err(id: Value, code: i32, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

/// 处理一整个请求体，返回该回给客户端的 JSON。
///
/// **总是返 HTTP 200 + JSON-RPC 体**（鉴权失败除外，那在 `server.rs` 拦）：
/// JSON-RPC 的错误要走 `error` 字段，用 HTTP 状态码代替会让客户端拿不到
/// `code` 与 `message`。
/// 一次调用的审计草稿（W3）。`client` 不在这里填——它来自 HTTP 头，
/// 而本模块故意不知道 HTTP 的存在。由 server 层补上。
pub struct AuditDraft {
    pub tool: String,
    /// 参数 JSON。🔴 只有参数，**永远不包含返回的笔记正文**。
    pub args: String,
    pub ok: bool,
    pub note_ids: Vec<String>,
}

/// `dispatch` 的返回：应答 + （若需要）审计草稿。
///
/// 只有 `tools/call` 会产生审计。`initialize` / `tools/list` 不记：
/// 它们不碰笔记数据，记了只会把真正重要的那几条淡化在握手噪声里。
pub struct Dispatched {
    pub response: Value,
    pub audit: Option<AuditDraft>,
}

impl From<Value> for Dispatched {
    fn from(response: Value) -> Self {
        Self {
            response,
            audit: None,
        }
    }
}

/// 读一次写开关快照。
///
/// 读配置要拿 SQLite 锁，所以必须进 `spawn_blocking`（R2）。
///
/// join 失败（panic / 被取消）时**全关**，而不是全开：
/// 「默认全开」适用的是「配置里没这个键」，而这里是**读不到、不知道用户意愿**。
/// 权限门在不知道时得往保守那边倒。不静默（规则 #15.3）。
async fn load_switches(kb: &std::sync::Arc<dyn super::source::KbSource>) -> WriteSwitches {
    let kb2 = kb.clone();
    match tokio::task::spawn_blocking(move || kb2.write_switches()).await {
        Ok(s) => s,
        Err(e) => {
            log::error!("[MCP] 读写开关失败，本次按全关处理：{}", e);
            WriteSwitches::ALL_OFF
        }
    }
}

/// 处理一整个请求体。`client` 是请求的 User-Agent（由 server 层传入）。
pub async fn dispatch(
    kb: &std::sync::Arc<dyn super::source::KbSource>,
    client: &str,
    raw: &[u8],
) -> Dispatched {
    let req: Value = match serde_json::from_slice(raw) {
        Ok(v) => v,
        Err(e) => return err(Value::Null, ERR_PARSE, format!("JSON 解析失败：{}", e)).into(),
    };

    // 批量请求（数组）不支持。明确拒掉而不是默默当成单个请求处理。
    if req.is_array() {
        return err(
            Value::Null,
            ERR_INVALID_REQUEST,
            "不支持批量请求（JSON-RPC batch）",
        )
        .into();
    }

    let id = id_of(&req);
    let Some(method) = req.get("method").and_then(|m| m.as_str()) else {
        return err(id, ERR_INVALID_REQUEST, "请求缺少 method 字段").into();
    };
    let params = req.get("params");

    match method {
        "initialize" => {
            let switches = load_switches(kb).await;
            ok(id, initialize_result(params, &switches)).into()
        }

        // 握手完成通知。按规范它是 notification（无 id，不需应答），
        // 但 HTTP 传输下必须回一个响应体，否则客户端会一直等。
        // 回 `id: null` 的空结果（同 cc-bridge）。
        "notifications/initialized" => ok(Value::Null, json!({})).into(),

        // 开关每次现读：所以客户端重连后看到的就是当前的工具表。
        // （我们发不了 listChanged 通知，原因见 `gate.rs`。）
        "tools/list" => {
            let switches = load_switches(kb).await;
            ok(id, json!({ "tools": super::tools::definitions(&switches) })).into()
        }

        // 唯一会产生审计的分支。工具名与参数从 `params` 里取，
        // 即使调用失败也要记（`ok: false`）——「试图读但没读成」也是信息。
        "tools/call" => {
            let tool = params
                .and_then(|p| p.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let args = params
                .and_then(|p| p.get("arguments"))
                .map(|v| v.to_string())
                .unwrap_or_default();
            let ctx = super::tools::CallCtx {
                kb: kb.clone(),
                switches: load_switches(kb).await,
                source: super::source_agent_from_ua(client),
            };
            match super::tools::call(&ctx, params).await {
                Ok(out) => Dispatched {
                    response: ok(id, out.value),
                    audit: Some(AuditDraft {
                        tool,
                        args,
                        ok: true,
                        note_ids: out.note_ids,
                    }),
                },
                Err(e) => Dispatched {
                    response: err(id, e.code, e.message),
                    audit: Some(AuditDraft {
                        tool,
                        args,
                        ok: false,
                        note_ids: Vec::new(),
                    }),
                },
            }
        }

        other => err(id, ERR_METHOD_NOT_FOUND, format!("不支持的方法：{}", other)).into(),
    }
}

/// 拼 `initialize` 的应答。
fn initialize_result(params: Option<&Value>, switches: &WriteSwitches) -> Value {
    // 🔴 回显客户端请求的版本。写死一个版本号是 cc-bridge 撞过的真 bug，
    // 详见 FALLBACK_PROTOCOL_VERSION 的注释。
    let version = params
        .and_then(|p| p.get("protocolVersion"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(FALLBACK_PROTOCOL_VERSION);

    json!({
        "protocolVersion": version,
        "capabilities": {
            // listChanged: false。
            //
            // ⚠ M5 后工具表**不再是编译期写死的**（七个写开关一改它就变），
            // 但仍然声明 false，因为本服务的传输层只有 `POST /mcp` 与
            // `GET /health`，**没有任何 server→client 通道**，通知根本发不出去。
            // 声明 true 却永远不发，是另一种形式的说谎。
            //
            // 没重连不会变成安全洞：`tools/call` 那一层拦截是即时生效的（见 gate.rs）。
            "tools": { "listChanged": false }
        },
        "serverInfo": {
            "name": "pastepanda-knowledge",
            "version": env!("CARGO_PKG_VERSION")
        },
        "instructions": server_instructions(switches)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initialize_echoes_client_protocol_version() {
        // 🔴 回归护栏：cc-bridge 曾把这里写死成一个不存在的版本号，
        // 客户端一升级就协商失败。这条测试就是钉住「回显而不是写死」。
        let r = initialize_result(
            Some(&json!({ "protocolVersion": "2099-01-01" })),
            &WriteSwitches::ALL_ON,
        );
        assert_eq!(r["protocolVersion"], "2099-01-01");
    }

    #[test]
    fn test_initialize_falls_back_when_client_omits_version() {
        for p in [
            None,
            Some(json!({})),
            Some(json!({ "protocolVersion": "" })),
            Some(json!({ "protocolVersion": "   " })),
            Some(json!({ "protocolVersion": 123 })),
        ] {
            let r = initialize_result(p.as_ref(), &WriteSwitches::ALL_ON);
            assert_eq!(r["protocolVersion"], FALLBACK_PROTOCOL_VERSION);
        }
    }

    #[test]
    fn test_initialize_shape() {
        let r = initialize_result(None, &WriteSwitches::ALL_OFF);
        assert_eq!(r["capabilities"]["tools"]["listChanged"], false);
        assert_eq!(r["serverInfo"]["name"], "pastepanda-knowledge");
        assert!(r["serverInfo"]["version"].is_string());
        let ins = r["instructions"].as_str().unwrap_or("");
        // 「不含剪贴板历史」不论开关都得写：不写模型会拿这个服务去试剪贴板。
        assert!(ins.contains("剪贴板历史"));
        // 全关时才能自称只读
        assert!(ins.contains("只读"));
        assert!(ins.contains("不会写入或修改"));
    }

    #[test]
    fn test_instructions_stop_claiming_read_only_once_writes_are_on() {
        // 🔴 回归护栏：M5 之后这段话再写「只读」就是谎话，
        // 而模型会照着它拒给用户写（“这个服务只能读”）——用户明明开了权限。
        let ins = initialize_result(None, &WriteSwitches::ALL_ON)["instructions"]
            .as_str()
            .unwrap_or("")
            .to_string();
        assert!(!ins.contains("只读"), "开了写权限还自称只读");
        assert!(ins.contains("写入"), "未告知模型可以写");
        assert!(ins.contains("回收站"), "未告知删除只进回收站");
        assert!(ins.contains("调用记录"), "未告知写入会留痕");
        assert!(ins.contains("不要重试"), "未告知被关时不要重试");
    }

    #[test]
    fn test_source_agent_never_empty() {
        // 🔴 空串在 W2 里的语义是「人亲自改的」，会让锚定快照静默失效。
        for ua in ["", "   ", "claude-code/2.1.233 (sdk-cli)", "/1.0"] {
            let s = super::super::source_agent_from_ua(ua);
            assert!(!s.is_empty(), "UA={:?} 算出空来源", ua);
            assert!(s.starts_with("agent:"), "UA={:?} 没带 agent: 前缀", ua);
        }
        assert_eq!(
            super::super::source_agent_from_ua("claude-code/2.1.233 (sdk-cli)"),
            "agent:claude-code",
            "应只取名字不取版本——否则客户端一升级就多出一个看似不同的来源"
        );
    }

    #[test]
    fn test_error_and_ok_envelope_shape() {
        let e = err(json!(7), ERR_METHOD_NOT_FOUND, "nope");
        assert_eq!(e["jsonrpc"], "2.0");
        assert_eq!(e["id"], 7);
        assert_eq!(e["error"]["code"], -32601);
        assert!(e.get("result").is_none(), "错误应答不得同时带 result");

        let o = ok(json!("abc"), json!({ "x": 1 }));
        assert_eq!(o["id"], "abc");
        assert!(o.get("error").is_none(), "成功应答不得同时带 error");
    }
}
