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

use super::gate::{WriteScope, WriteSwitches};

/// 本服务**真正实现了**的协议版本，新在前。
///
/// 🔴 **为何不能一律回显客户端给的版本**。规范（2025-06-18
/// §Version Negotiation）原文：
///
/// > If the server supports the requested protocol version, it MUST respond with
/// > the same version. **Otherwise, the server MUST respond with another protocol
/// > version it supports.**
///
/// 一律回显等于宣称支持一个自己没实现的版本，而客户端会照着那个版本
/// 的规则往下走。cc-bridge 那个教训（把应答写死成一个**根本不存在的**
/// 版本号）的正解是「支持就回显，不支持就回自己最新的」——
/// 而不是「一律回显」；后者只是从一个坑跳进对面那个坑。
///
/// 名单里只放**握手式协商**且与本服务线上形状兼容的三代。
/// 故意不放 `2026-07-28`：它把协商改成了**每请求**带
/// `MCP-Protocol-Version` / `_meta`，还多了一个**强制**的 `server/discover`，
/// 本服务两样都没有。也不放 `2025-11-25`：没核实过差异，
/// **没核实就不该声称支持**。
const SUPPORTED_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

/// 客户端没传、或传了一个我们不支持的版本时，应答里给的值。
///
/// 按规范它 SHOULD 是服务端支持的**最新**版本，所以取名单第一个——
/// 而不是另写一个字面量（那就又多一处能与名单对不上的地方）。
const LATEST_PROTOCOL_VERSION: &str = SUPPORTED_VERSIONS[0];

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
fn server_instructions(switches: &WriteSwitches, blurb: &str) -> String {
    let mut s = String::from(if switches.any_on() {
        "PastePanda 个人知识库。提供对本机笔记的检索、读取与**写入**。\n\n"
    } else {
        "PastePanda 个人知识库。提供对本机笔记的**只读**检索与读取。\n\n"
    });
    // 🔴 2026-09-15 补「开场自检」：这一段是模型判断**要不要用这个服务**的主开关
    // （见 `test_instructions_answer_what_is_worth_recording` 末尾那条断言）。
    //
    // 依据是审计表：14 天里真实客户端只有两次会话开局来过（`kb_folders` +
    // `kb_list`，相隔 0–9 秒），此后整场不碰。它**自己会来摸底**，只是没被告知
    // 「来了该看什么、看完该做什么」——所以把这一步写成契约的一部分。
    //
    // ❗ 这半句**在开关判断之外**：让它先看一眼再决定是「读」还是「写」，
    //    只读模式下这一步照样成立（那时它是「别重复造轮子」）。
    s.push_str(
        "适用时机：接到与用户项目/环境有关的活时，先 kb_folders 看一眼有没有现成笔记，\
         别从零重推；用户问到他自己记过的东西（方案、踩过的坑、配置、摘录），\
         或需要他个人积累的上下文时也用它",
    );
    // 🔴 写入那半句**只在不全关时发**：全关时模型根本写不了，
    // 叫它「主动记进去」是在让它做一件做不到的事——与下面「什么值得记」段
    // 只在写开关开启时才发的理由完全相同。
    // （第一版漏了这条，实测全关从 361 涨到 464 才发现；见 `test_initialize_shape`。）
    s.push_str(if switches.any_on() {
        "；**反过来，你刚得出结论或踩到项目特有的坑时，主动记进去——\
         当轮就写，别等到会话结束**（判据见下）。\n\n"
    } else {
        "。\n\n"
    });
    s.push_str("边界：仅覆盖**笔记**，不包含剪贴板历史。\n\n");
    if switches.any_on() {
        // ①甲：写入判据。
        //
        // 🔴 为何必须有这一段：下面那些「写入约定」全是**不许做什么**，
        // 工具描述回答的是**用哪个工具**，而一直没人回答「什么值得记」。
        // 后果是可量的：2026-09-09 实测库里 26 篇活笔记，
        // 由 AI 写的 **0 篇**；`- [kind]` 行命中 **0 条**（而任务复选框有 70 行）。
        // 也就是说 `kb_search` 的 `kind` 筛选当时是个**死参数**——
        // 它只能匹配到没人被要求写的东西。
        //
        // 🔴 2026-09-15 补「授权」这一层，并把判断顺序倒过来。
        //
        // 原先的标题是「什么值得记（用户开了写入，但**不要把对话流水往里倒**）」——
        // 那两个半句分别是一句**权限陈述**和一句**约束**，都不是行动授权。
        // 而「用户可以写入」并不等于「所以我该写」：对模型来说写一篇笔记是一次
        // **没人要求的额外工具调用**，缺一句正面授权它就不会做。
        // 这是「26 篇 0 篇」里那个「0」的另一半原因——①甲 当年买到的是判据的
        // 精细度，没买到授权。
        //
        // 同一次改动还做了两件事：
        //   ・把**总开关判据提到第 1 条**——它能否掉后面三条，原先却排在最末；
        //   ・把「别倒流水」挪到末尾并给出量感。原文只说「别倒」，没说多少算倒，
        //     模型在「可能写错」的压力下只能选最保守的做法：不写。
        //
        // 🔴 只在写开关至少开一档时发：全关时推一段「什么值得记」
        // 等于叫模型去做一件它做不了的事，而且那些 token 白付。
        s.push_str(
            "什么值得记——**判断值得就直接记，不用先问用户**：\n\
             ・**下次会重新推导一遍的东西**——这条是判据的总开关：\
             如果下一个会话要花力气重新弄清它，那就该记；\n\
             ・**结论，不是过程**——定下来的方案、选型理由，不是推导它的那几轮；\n\
             ・**踩过的坑**——这台机器/这个项目特有的坑，不是能从文档里查到的通用知识；\n\
             ・**用户纠正你的地方**——尤其是带理由的纠正。\n\
             🔴 别把对话流水往里倒（一次会话记一两篇是正常，每轮都记就是噪音）；\
             也别等用户开口——他看不到你的工作过程，你没记的下个会话就得从头再来。\n\n\
             记的时候在正文里加行内标记（形如 `- [decision] 一句话`），\
             `kb_search` 的 `kind` 靠它筛；只往**正文**里加，别去改用户已有的句子。\n\n",
        );
        s.push_str(
            "写入约定：\n\
             ・每次写入都计入用户可见的调用记录并标注来源；\n\
             ・改笔记会自动留版本快照，用户随时可恢复；\n\
             ・删除只能删到**回收站**（可恢复），没有彻底删除的工具；\n\
             ・整理文件夹与标签时**只动你自己写的**，用户手工建的一律不碰；\n\
             ・写权限可以被用户逐项关掉。被关时工具会告知，\
             那时**不要重试、不要绕路**，让用户去设置里开。\n\
             ・“今日速记”不开放写入，那是用户热键专用的。\n\n\
             写文本有七个入口，按**动的范围**选（别都用 kb_update）：\n\
             ・新开一篇 → kb_create；重写整篇 → kb_update（**覆盖全文**，最后才考虑）\n\
             ・接在末尾 → kb_append；插到开头 → kb_prepend\n\
             ・只改某一节 → kb_update_section；在某节前后插一段 → kb_insert_at_section\n\
             ・改一句话/错字 → kb_replace_in_note（要全文唯一命中）\n\
             拿不准就选**动得最少**的那个：范围大的用错，用户写的东西就没了。",
        );
    } else {
        s.push_str("全部工具都不会写入或修改任何数据。");
    }
    // AM-6：用户手写的库简介接在**最后**。
    // 放末尾而不是开头：前面那些是我们对自己服务的硬约定（只读/边界/写入约定），
    // 不该被一段用户文本隔开或推远。
    // nonce 现生成（O-1）：定界符固定的话，这段文本自己就能把包裹提前闭上。
    s.push_str(&super::blurb::framed(blurb, &super::delim_nonce()));
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

/// 读一次可写入范围（项目②）。
///
/// join 失败时返回**一篇都不可写**（`WriteScope::only([])`）而不是不限制，
/// 理由同 [`load_switches`]：「不限制」适用的是「配置里没这个键」，
/// 而这里是**读不到、不知道用户意愿** —— 权限门在不知道时得往保守那边倒。
async fn load_scope(kb: &std::sync::Arc<dyn super::source::KbSource>) -> WriteScope {
    let kb2 = kb.clone();
    match tokio::task::spawn_blocking(move || kb2.write_scope()).await {
        Ok(s) => s,
        Err(e) => {
            log::error!("[MCP] 读可写范围失败，本次按「一篇都不可写」处理：{}", e);
            WriteScope::only(Vec::<String>::new())
        }
    }
}

/// 读用户手写的库简介（AM-6）。读失败**就不推**，不阻断握手：
/// 这一段是锦上添花，不能因为它读不出来就让整个服务连不上。
async fn load_blurb(kb: &std::sync::Arc<dyn super::source::KbSource>) -> String {
    let kb2 = kb.clone();
    match tokio::task::spawn_blocking(move || kb2.library_blurb()).await {
        Ok(s) => s,
        Err(e) => {
            log::error!("[MCP] 读库简介失败，本次不推：{}", e);
            String::new()
        }
    }
}

/// 读回收站保留天数（`kb_delete` 的描述要拿**真值**去拼）。
///
/// 🔴 为何不在描述里写死「30 天」：`note_trash_days` 是用户可改的（设置
/// → 常规）。写死的话，用户改成 7 天后模型会继续向他保证「30 天内都能恢复」
/// ——然后第八天东西没了。这是整份工具描述里唯一一条方向指向数据丢失的不实陈述。
///
/// join 失败时不写字面量，而是拿一个空配置去问
/// [`crate::auto_cleanup::trash_days`]：默认值只能留在那一处（规则 #11）。
async fn load_trash_days(kb: &std::sync::Arc<dyn super::source::KbSource>) -> i64 {
    let kb2 = kb.clone();
    match tokio::task::spawn_blocking(move || kb2.trash_days()).await {
        Ok(d) => d,
        Err(e) => {
            log::error!("[MCP] 读回收站保留天数失败，本次按默认值报：{}", e);
            crate::auto_cleanup::trash_days(&Value::Null)
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
            let blurb = load_blurb(kb).await;
            ok(id, initialize_result(params, &switches, &blurb)).into()
        }

        // 握手完成通知。按规范它是 notification（无 id，不需应答），
        // 但 HTTP 传输下必须回一个响应体，否则客户端会一直等。
        // 回 `id: null` 的空结果（同 cc-bridge）。
        "notifications/initialized" => ok(Value::Null, json!({})).into(),

        // 开关每次现读：所以客户端重连后看到的就是当前的工具表。
        // （我们发不了 listChanged 通知，原因见 `gate.rs`。）
        "tools/list" => {
            let switches = load_switches(kb).await;
            let trash_days = load_trash_days(kb).await;
            ok(
                id,
                json!({ "tools": super::tools::definitions(&switches, trash_days) }),
            )
            .into()
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
                scope: load_scope(kb).await,
                source: super::source_agent_from_ua(client),
            };
            match super::tools::call(&ctx, params).await {
                Ok(out) => {
                    // 🔴 `ok` 要反映**模型实际看到的结果**，而不是「这次调用有没有
                    // 走到底」。工具内部的失败走的是 `Ok(error_result(..))`（带
                    // `isError: true` 的成功应答），以前一律记成 `ok: true`。
                    //
                    // 实测后果（2026-09-07）：面板渲染的是
                    // `r.ok ? "返回 N 篇" : "失败"`，于是
                    //   ・ AI 往不存在的文件夹建笔记被拒 → 显示「返回 0 篇」
                    //   🔴 用户关掉写权限后，AI 试图删笔记被门控拦下 → 也显示「返回 0 篇」
                    // 而「AI 想干什么、被我拦下了」正是这个面板最该回答的问题。
                    let succeeded = out.value.get("isError") != Some(&Value::Bool(true));
                    Dispatched {
                        response: ok(id, out.value),
                        audit: Some(AuditDraft {
                            tool,
                            args,
                            ok: succeeded,
                            note_ids: out.note_ids,
                        }),
                    }
                }
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
fn initialize_result(params: Option<&Value>, switches: &WriteSwitches, blurb: &str) -> Value {
    // 🔴 支持就回显，不支持就回自己最新的——规范原文见 SUPPORTED_VERSIONS。
    let asked = params
        .and_then(|p| p.get("protocolVersion"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let version = match asked {
        Some(v) if SUPPORTED_VERSIONS.contains(&v) => v,
        _ => LATEST_PROTOCOL_VERSION,
    };

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
        "instructions": server_instructions(switches, blurb)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initialize_echoes_a_version_we_actually_support() {
        // 🔴 回归护栏（上半）：cc-bridge 曾把这里写死成一个不存在的版本号，
        // 客户端一升级就协商失败。名单里的版本必须原样回显。
        for v in SUPPORTED_VERSIONS {
            let r = initialize_result(
                Some(&json!({ "protocolVersion": v })),
                &WriteSwitches::ALL_ON,
                "",
            );
            assert_eq!(r["protocolVersion"], *v, "支持的版本应当回显");
        }
    }

    #[test]
    fn test_initialize_never_claims_a_version_it_does_not_implement() {
        // 🔴 回归护栏（下半）：这条原本钉的是「一律回显」，连 `2099-01-01`
        // 都照回——而那是不合规的（规范：不支持就 MUST 回一个自己支持的）。
        // 宣称支持一个没实现的版本，客户端会照着那个版本的规则往下走。
        for bad in ["2099-01-01", "2026-07-28", "2025-11-25", "1.0.0", "latest"] {
            let r = initialize_result(
                Some(&json!({ "protocolVersion": bad })),
                &WriteSwitches::ALL_ON,
                "",
            );
            assert_eq!(
                r["protocolVersion"], LATEST_PROTOCOL_VERSION,
                "不支持的 {} 被回显了，等于宣称支持它",
                bad
            );
        }
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
            let r = initialize_result(p.as_ref(), &WriteSwitches::ALL_ON, "");
            assert_eq!(r["protocolVersion"], LATEST_PROTOCOL_VERSION);
        }
    }

    #[test]
    fn test_initialize_shape() {
        let r = initialize_result(None, &WriteSwitches::ALL_OFF, "");
        assert_eq!(r["capabilities"]["tools"]["listChanged"], false);
        assert_eq!(r["serverInfo"]["name"], "pastepanda-knowledge");
        assert!(r["serverInfo"]["version"].is_string());
        let ins = r["instructions"].as_str().unwrap_or("");
        // 「不含剪贴板历史」不论开关都得写：不写模型会拿这个服务去试剪贴板。
        assert!(ins.contains("剪贴板历史"));
        // 全关时才能自称只读
        assert!(ins.contains("只读"));
        assert!(ins.contains("不会写入或修改"));
        // 🔴 全关时不能叫模型「主动记」——它写不了，那是一条做不到的指令。
        // 第一版把「适用时机」里的写入半句放在了开关外，全关也发（361 → 464）。
        assert!(
            !ins.contains("主动记"),
            "只读模式下还在叫模型主动写：{}",
            ins
        );
    }

    #[test]
    fn test_instructions_stop_claiming_read_only_once_writes_are_on() {
        // 🔴 回归护栏：M5 之后这段话再写「只读」就是谎话，
        // 而模型会照着它拒给用户写（“这个服务只能读”）——用户明明开了权限。
        let ins = initialize_result(None, &WriteSwitches::ALL_ON, "")["instructions"]
            .as_str()
            .unwrap_or("")
            .to_string();
        assert!(!ins.contains("只读"), "开了写权限还自称只读");
        assert!(ins.contains("写入"), "未告知模型可以写");
        assert!(ins.contains("回收站"), "未告知删除只进回收站");
        assert!(ins.contains("调用记录"), "未告知写入会留痕");
        assert!(ins.contains("不要重试"), "未告知被关时不要重试");
        // 从七个写工具描述里取消的 WRITE_FOOTER 搬到了这里（只说一遍）。
        // 丢了就等于模型再也不知道自己的修改可撤——它会因此不敢动，
        // 也没法向用户交代「怎么撤」。
        assert!(ins.contains("版本快照"), "未告知修改留快照");
    }

    #[test]
    fn test_instructions_answer_what_is_worth_recording() {
        // 🔴 ①甲。不钉的后果不是报错而是**静默倒退**：
        // 这一段被谁删了，`kb_search` 的 `kind` 筛选当场变回死参数（零命中），
        // 而从任何返回值上都看不出来。
        //
        // 2026-09-09 实测依据：库里 26 篇活笔记，AI 写的 0 篇；
        // `- [kind]` 行命中 0 条，而任务复选框 70 行。
        let ins = initialize_result(None, &WriteSwitches::ALL_ON, "")["instructions"]
            .as_str()
            .unwrap_or("")
            .to_string();
        assert!(ins.contains("什么值得记"), "写入判据那一段丢了：{}", ins);
        // 四条判据里最要紧的是那条总开关。
        assert!(
            ins.contains("重新推导"),
            "缺「下次会重新推导一遍的就该记」那条总开关：{}",
            ins
        );
        // 🔴 2026-09-15 补：**授权**那句必须钉住。
        // 「用户可以写入」是**权限陈述**，不是**行动授权**——判据再精细，
        // 只要没告诉模型「可以直接记」，它就会继续选择不写（它把写笔记
        // 看成一次没人要求的额外调用）。这是「26 篇 0 篇」里「0」的另一半原因。
        assert!(
            ins.contains("不用先问用户"),
            "缺「判断值得就直接记，不用先问用户」这句授权：{}",
            ins
        );
        // 「适用时机」是模型决定**要不要用这个服务**的主开关，
        // 它必须同时覆盖「读」和「写」——原先只写了读，
        // 于是模型读完开头就把这个服务归类成检索工具。
        assert!(
            ins.contains("主动记进去"),
            "「适用时机」里没写写入场景，模型不会想到主动记：{}",
            ins
        );
        // 推荐写法必须带上——不带的话 `kind` 筛选永远没东西可筛。
        assert!(
            ins.contains("[decision]") || ins.contains("decision /"),
            "没告诉模型行内标记的写法：{}",
            ins
        );

        // 🔴 2026-09-15 下半场：把这几句从「判据」升级成「会话契约」。
        //
        // 起因是审计表：14 天里真实客户端只有两次会话开局来过（`kb_folders` +
        // `kb_list`），写入 0 次。判据本身没毛病 —— 是**触发**断了：
        // 那段话回答「什么样的内容值得记」，却没回答「什么时候做这件事」。
        assert!(
            ins.contains("先 kb_folders 看一眼"),
            "「适用时机」里缺开场自检：模型自己会来摸底，但没人告诉它来了该看什么：{}",
            ins
        );
        assert!(
            ins.contains("当轮就写"),
            "缺「当轮就写」——不写的话模型会把回写留到会话结束，而那时它已经忘了：{}",
            ins
        );
        assert!(
            ins.contains("别等用户开口"),
            "缺责任归属那一句：没人要求它写，它就不写——这是「26 篇 0 篇」的真正半边：{}",
            ins
        );

        // 全关时不该推：叫模型去做一件它做不了的事，而且 token 白付。
        let off = initialize_result(None, &WriteSwitches::ALL_OFF, "")["instructions"]
            .as_str()
            .unwrap_or("")
            .to_string();
        assert!(!off.contains("什么值得记"), "全关时不该推写入判据：{}", off);
    }

    #[test]
    fn test_instructions_stay_within_a_context_budget() {
        // 🔴 `instructions` 与 `tools/list` 是**同一类开销**：每个客户端每次连接
        // 都要为它付上下文，而且是在模型做任何事之前。
        //
        // 为何补这条：2026-09-07 把 `WRITE_FOOTER` 从 11 个写工具里挑到了这里，
        // 那一笔是划算的（付 11 次变付 1 次）。但那之后“挑到 instructions”就成了
        // 一个现成手法，而 `tools/list` 那边有预算、这边**没人量**——
        // 于是它会成为一个把成本藏起来的口子：认真看着的那个数字降了，
        // 每次连接的总开销却没降。两边都得有秤。
        //
        // 🔴 又涨了不要顺手改大：先问「这句话在工具描述里本来付几次」。
        //    付 1 次的挑过来不省钱，只是换了个地方放。
        let on = initialize_result(None, &WriteSwitches::ALL_ON, "")["instructions"]
            .as_str()
            .unwrap_or("")
            .len();
        let off = initialize_result(None, &WriteSwitches::ALL_OFF, "")["instructions"]
            .as_str()
            .unwrap_or("")
            .len();
        println!(
            "instructions：全开 {} 字节 / 全关 {} 字节（不含用户库简介）",
            on, off
        );
        // 基线（2026-09-09 上半）：全开 1462 / 全关 361。当时预算 2200。
        // 基线（2026-09-09 下半，①甲 写入判据）：**全开 2212 / 全关 361**。
        //
        // ①甲 花了 750 字节，而不是规划里估的 450。这条断言当场拦下了它
        // （先报 2456），照它自己说的「先问这句话在工具描述里本来付几次」查了一遍，
        // 真找出三处重复（共 244 字节）：
        //   ・`kb_list(author="me")` 提示 —— `kb_list` 的 author 参数里已经有；
        //   ・类别词表 decision / fact / todo / question —— `kb_search` 的 `kind` 参数里已经有；
        //   ・「决定 vs 事实是两种查询」那句理由 —— 同上。
        // 删完剩 750。这三处不是「把话写短」，是真的说了两遍。
        //
        // 🔴 那 750 值不值（这才是本断言要求回答的问题）：值。
        //    2026-09-09 实测：库里 26 篇活笔记，**AI 写的 0 篇**；
        //    `- [kind]` 行命中 **0 条**（任务复选框 70 行），
        //    且 2026-09-04 那次也是 0 —— 五天没动。
        //    也就是说 `kb_search` 的 `kind` 一直是个**死参数**：解析/筛选/展示/校验
        //    四道都建好了，唯独没人告诉模型该写它。750 字节（约 250 token）
        //    是 `tools/list` 那 15072 的 5%，而它是目前唯一一件
        //    「不知道 AI 会怎么用也知道该做」的事。
        //
        // 预算改给 2600：留约半个「写入判据段」的余量。
        // 参照：同一时刻 `tools/list` 是 15072——这段占它的约七分之一。
        // 全关那个不单独卡：它只是全开的子集，卡了也是重复的。
        //
        // 用户手写的库简介（AM-6）**没算在内**：它另有 500 字符硬上限，
        // 而且那是用户自己选的开销，不应该占我们自己的额度。
        //
        // 🔴 2026-09-15 下半场（L1 会话契约）：**全开 2467 / 全关 458**。
        //
        // 这一笔花了 +255 字节（2212 → 2467），买的是三层触发里的第一层：
        //   ・「适用时机」加**开场自检**（先 `kb_folders` 看一眼有没有现成笔记）
        //     与「主动记进去——当轮就写」。前者放在开关**外**，
        //     所以全关也从 361 涨到 458；
        //   ・判据段末尾加**责任归属**（「也别等用户开口」）。
        //
        // 值不值：值。它是唯一能**不经用户开口**就到达模型手里的通道
        // （见 `pulse.rs` 头部那张协议能力表的理由），而审计表实测 14 天
        // 真实客户端写入 0 次、开局摸底 2 次 —— 判据早就够细了，
        // 缺的是**触发与授权**，这两样只能从这一段里买。
        //
        // 同时顺手删掉了三处「本来就说第二遍」的话（七工具表的三个虚词、
        // 写入约定里的两处冗语），腾回约 116 字节。余量还剩 133。
        assert!(
            on < 2_600,
            "instructions 已涨到 {} 字节（基线 2212）。要么精简，\
             要么先确认这份每次连接都付的开销值得",
            on
        );
        assert!(off < on, "全关时反而不比全开短，那写入约定那段没真的被略掉");
    }

    #[test]
    fn test_instructions_carry_a_write_tool_decision_table() {
        // 🔴 往笔记里写文本有**七个**入口，且两两相邻。
        // 以前只在每个工具描述里写一句「优先用它而不是 kb_update」，
        // 模型得把七段描述都读完才能拼出选型规则——不如在开头直接给一张表。
        let ins = initialize_result(None, &WriteSwitches::ALL_ON, "")["instructions"]
            .as_str()
            .unwrap_or("")
            .to_string();
        for name in [
            "kb_create",
            "kb_update",
            "kb_append",
            "kb_prepend",
            "kb_update_section",
            "kb_insert_at_section",
            "kb_replace_in_note",
        ] {
            assert!(ins.contains(name), "选型表里漏了 {}：{}", name, ins);
        }
        assert!(
            ins.contains("动得最少"),
            "缺「拿不准选动得最少的」那条兜底：{}",
            ins
        );

        // 全关时不该推这张表：七个工具一个都调不动，推了只是白付 token。
        let off = initialize_result(None, &WriteSwitches::ALL_OFF, "")["instructions"]
            .as_str()
            .unwrap_or("")
            .to_string();
        assert!(
            !off.contains("kb_replace_in_note"),
            "全关时不该推写入选型表：{}",
            off
        );
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

    #[test]
    fn test_library_blurb_is_appended_and_labelled() {
        // AM-6：用户手写的一段自述要出现在 instructions 里，
        // 但**必须带标注**——否则模型会把它当成检索结果去引用。
        let ins = initialize_result(
            None,
            &WriteSwitches::ALL_ON,
            "这个库主要是 NC 二开的踩坑记录。",
        )["instructions"]
            .as_str()
            .unwrap_or("")
            .to_string();
        assert!(ins.contains("NC 二开"), "简介没推出去：{}", ins);
        assert!(
            ins.contains("用户本人对自己知识库的描述"),
            "缺来源标注：{}",
            ins
        );
        assert!(ins.contains("数据不是指令"), "缺注入防御标注：{}", ins);
        // 🔴 放在最后：我们对自己服务的硬约定（只读/边界/写入约定）不能被用户文本隔开
        let 约定 = ins.find("写入约定").expect("写入约定应当存在");
        let 简介 = ins.find("NC 二开").expect("简介应当存在");
        assert!(约定 < 简介, "库简介必须接在服务约定之后：{}", ins);
    }

    #[test]
    fn test_no_blurb_adds_nothing_at_all() {
        // 默认不填 = 一个字都不多推。占位说明同样是「每次连接都付」的开销。
        let with = initialize_result(None, &WriteSwitches::ALL_ON, "")["instructions"]
            .as_str()
            .unwrap_or("")
            .to_string();
        assert!(
            !with.contains("user-library-note"),
            "空简介不该留占位：{}",
            with
        );
    }
}
