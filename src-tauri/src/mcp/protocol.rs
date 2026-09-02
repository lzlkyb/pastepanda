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
fn server_instructions() -> &'static str {
    "PastePanda 个人知识库。提供对本机笔记的**只读**检索与读取。\n\n\
     适用时机：用户问到他自己记过的东西（方案、踩过的坑、配置、摘录），\
     或者需要他个人积累的上下文而不是通用知识时。\n\n\
     边界：仅覆盖**笔记**，不包含剪贴板历史。全部工具都不会写入或修改任何数据。"
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
pub async fn dispatch(raw: &[u8]) -> Value {
    let req: Value = match serde_json::from_slice(raw) {
        Ok(v) => v,
        Err(e) => return err(Value::Null, ERR_PARSE, format!("JSON 解析失败：{}", e)),
    };

    // 批量请求（数组）不支持。明确拒掉而不是默默当成单个请求处理。
    if req.is_array() {
        return err(
            Value::Null,
            ERR_INVALID_REQUEST,
            "不支持批量请求（JSON-RPC batch）",
        );
    }

    let id = id_of(&req);
    let Some(method) = req.get("method").and_then(|m| m.as_str()) else {
        return err(id, ERR_INVALID_REQUEST, "请求缺少 method 字段");
    };
    let params = req.get("params");

    match method {
        "initialize" => ok(id, initialize_result(params)),

        // 握手完成通知。按规范它是 notification（无 id，不需应答），
        // 但 HTTP 传输下必须回一个响应体，否则客户端会一直等。
        // 回 `id: null` 的空结果（同 cc-bridge）。
        "notifications/initialized" => ok(Value::Null, json!({})),

        "tools/list" => ok(id, json!({ "tools": super::tools::definitions() })),

        "tools/call" => match super::tools::call(params).await {
            Ok(result) => ok(id, result),
            Err(e) => err(id, e.code, e.message),
        },

        other => err(id, ERR_METHOD_NOT_FOUND, format!("不支持的方法：{}", other)),
    }
}

/// 拼 `initialize` 的应答。
fn initialize_result(params: Option<&Value>) -> Value {
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
            // listChanged: false —— 工具表是编译期写死的，运行中不会变，
            // 声明 true 就是让客户端白白监听一个永不发生的通知。
            "tools": { "listChanged": false }
        },
        "serverInfo": {
            "name": "pastepanda-knowledge",
            "version": env!("CARGO_PKG_VERSION")
        },
        "instructions": server_instructions()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initialize_echoes_client_protocol_version() {
        // 🔴 回归护栏：cc-bridge 曾把这里写死成一个不存在的版本号，
        // 客户端一升级就协商失败。这条测试就是钉住「回显而不是写死」。
        let r = initialize_result(Some(&json!({ "protocolVersion": "2099-01-01" })));
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
            let r = initialize_result(p.as_ref());
            assert_eq!(r["protocolVersion"], FALLBACK_PROTOCOL_VERSION);
        }
    }

    #[test]
    fn test_initialize_shape() {
        let r = initialize_result(None);
        assert_eq!(r["capabilities"]["tools"]["listChanged"], false);
        assert_eq!(r["serverInfo"]["name"], "pastepanda-knowledge");
        assert!(r["serverInfo"]["version"].is_string());
        let ins = r["instructions"].as_str().unwrap_or("");
        // 只读与「不含剪贴板历史」必须写在 instructions 里，
        // 否则模型会拿这个服务去试剪贴板、或以为能写入。
        assert!(ins.contains("只读"));
        assert!(ins.contains("剪贴板历史"));
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
