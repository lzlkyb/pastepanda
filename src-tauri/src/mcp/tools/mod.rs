//! 工具的定义与分发（四个只读 + 七个写）。
//!
//! 工具描述就是给模型看的 API 文档，写得准不准直接决定它会不会用错。
//! 尤其是 `kb_search` 的取词口径（见下）—— 那是个真存在的限制，
//! 不写进描述模型就会拿单字关键词去搜，拿到零命中后以为「库里没这个」。
//!
//! # 分层
//!
//! | 位置 | 内容 |
//! |---|---|
//! | 本模块 | 注册表 + 分发 + 公用辅助 + 四个只读工具 |
//! | [`write`] | 七个写工具（M5）|
//!
//! # 为何上了注册表
//!
//! 原注释写着「3 个工具时手写三件套完全可控，加到 6 个以上再上注册表」。
//! 现在是 11 个，而且多了一个新约束：每个写工具要知道**自己归哪个开关**。
//! 没有表的话，工具名要在「定义 / 分发 / 门控」三处各写一份。
//! 不上 derive 宏（cc-bridge 那套是为 17 个工具的重复维护痛点做的）。

pub mod write;

use std::sync::Arc;

use serde_json::{json, Value};

use super::gate::{WriteKind, WriteSwitches};
use super::source::{KbSource, ListOutcome, SearchOutcome};
use crate::data_store::Note;

/// 搜索/列表结果里每篇给多长的摘要。
///
/// 不返全文是故意的：一次 `kb_search` 可能拉 20 篇，全文丢进上下文窗口
/// 既浪费又淡化重点。模型看完摘要再用 `kb_read` 取它真需要的那一篇。
const BRIEF_CHARS: usize = 200;

/// 工具层报错。`code` 用 JSON-RPC 错误码（见 [`super::protocol`]）。
///
/// **区分两类失败**：
/// - 协议层失败（工具名不存在、参数缺失）→ 这个 `ToolError` → JSON-RPC `error`。
/// - 工具执行失败（检索挂了、笔记不存在）→ 正常 result 带 `isError: true`，
///   因为模型需要**看到**错误文本才能换个问法重试；JSON-RPC error 往往
///   被客户端当成传输故障吞掉。
#[derive(Debug)]
pub struct ToolError {
    pub code: i32,
    pub message: String,
}

impl ToolError {
    fn invalid_params(msg: impl Into<String>) -> Self {
        Self {
            code: super::protocol::ERR_INVALID_PARAMS,
            message: msg.into(),
        }
    }
}

/// 把一段文本包成 MCP 的工具结果。
pub fn text_result(text: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": text.into() }] })
}

/// 把一段文本包成**工具执行失败**的结果（仍是 JSON-RPC 成功应答）。
pub fn error_result(text: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": text.into() }], "isError": true })
}

/// 🔴 `kb_search` 的取词口径说明。
///
/// 它不是客套，是照 `data_store::note::question_to_or_expr` 的**实际行为**写的：
/// 中文只取相邻双字组合且两字都不是停用字，英文/数字只取长度 ≥ 2 的连续串。
/// 所以「什么」「问题」这类**两字都是停用字**的词也会被丢。
/// 不告知模型的后果是：它搜一个单字得到零命中，然后告诉用户「你库里没记过」——
/// 那是个**错答案**，比报错更坏。
const SEARCH_QUERY_CAVEAT: &str =
    "取词口径：中文按「相邻两字成一词」拆，英文/数字按「长度≥ 2 的连续串 + 前缀匹配」拆，\
     拆出的词做 OR 匹配后按 BM25 排相关度（标题权重 10 倍）。\n\
     会被丢弃的输入：单个汉字（如「钱」）、单个字母或数字（如「C」「3」）、\
     以及两字全是高频虚词的组合（如「什么」「问题」）。\n\
     若目标词本身就是单字/单字母，请把它放进一个更长的短语里（如「Go 并发」而非「Go」），\
     或改用 kb_list 按文件夹/标签浏览。\n\
     零命中不等于「库里没这个」—— 先换个问法重试，或用 kb_list 看看库里到底有什么。";

/// 四个只读工具的定义。只读工具**不受写开关约束**，永远在表里。
fn read_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "kb_folders",
            "description": "列出全部文件夹与全部标签。\
                            要给 kb_list 传 folder / tag，或要用 kb_move / kb_tag / kb_create 时，\
                            先调这个看清楚现有的名字。\n\
                            🔴 写入类工具**不会自动新建文件夹或标签**，名字对不上就会直接失败，\
                            所以不要自己编一个名字。",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "kb_search",
            "description": format!(
                "在用户的个人知识库（笔记）里按相关度检索，返回标题与摘要。不返回全文；\
                 看完摘要觉得哪篇有用，用 kb_read 取它的全文。\n\n{}",
                SEARCH_QUERY_CAVEAT
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "检索词或一句自然语言问题。整句也可以，会自动拆词。"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "最多返回几篇。默认 5。",
                        "minimum": 1,
                        "maximum": 20
                    }
                },
                "required": ["query"]
            }
        }),
        json!({
            "name": "kb_read",
            "description": "按 id 读一篇笔记的完整内容（Markdown 原文）。\
                            id 从 kb_search 或 kb_list 的结果里拿，不要自己造。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "笔记 id，来自 kb_search / kb_list 的返回结果。"
                    }
                },
                "required": ["id"]
            }
        }),
        json!({
            "name": "kb_list",
            "description": "浏览笔记列表（按最近修改倒序），可按文件夹或标签筛。\
                            适用于「库里都有什么」这类没有明确关键词的需求，\
                            或 kb_search 零命中后用来确认库里到底有没有相关内容。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "folder": {
                        "type": "string",
                        "description": "文件夹名（用 kb_folders 查）。省略 = 不按文件夹筛。"
                    },
                    "tag": {
                        "type": "string",
                        "description": "标签名（用 kb_folders 查）。省略 = 不按标签筛。\
                                          标签不存在时会明确告知，**不会**退化成「返回全库第一页」。"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "最多返回几篇。默认 20。",
                        "minimum": 1,
                        "maximum": 50
                    },
                    "offset": {
                        "type": "integer",
                        "description": "跳过前几篇，用于翻页。默认 0。",
                        "minimum": 0
                    }
                }
            }
        }),
    ]
}

/// 一次调用的上下文。
///
/// `source` 不在本模块推导：它源于 HTTP 的 User-Agent，而本模块故意不知道
/// HTTP 的存在（同 `AuditDraft.client` 的取舍）。由 server 层填。
#[derive(Clone)]
pub struct CallCtx {
    pub kb: Arc<dyn KbSource>,
    /// 七个写开关的快照。**每个请求现读一次**，所以设置页一改即时生效。
    pub switches: WriteSwitches,
    /// 写入要落到 `source_agent` 的值，形如 `agent:claude-code`。
    ///
    /// 🔴 **永不得为空**：空串在 W2 里的语义是「人亲自改的」，
    /// 传空等于让锚定快照静默失效。看 [`super::source_agent_from_ua`]。
    pub source: String,
}

/// 注册表的一行。
type Fut = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<ToolOutput, ToolError>> + Send>,
>;
type Runner = fn(CallCtx, Option<Value>) -> Fut;

struct ToolSpec {
    name: &'static str,
    /// `None` = 只读工具，不受开关约束。
    write: Option<WriteKind>,
    run: Runner,
}

/// 🔴 **分发与门控的唯一真相**。定义（`read_definitions` / `write::definitions`）
/// 与它的一致性由测试钉住。
const TOOLS: &[ToolSpec] = &[
    ToolSpec {
        name: "kb_folders",
        write: None,
        run: |c, a| Box::pin(async move { call_folders(&c.kb, a.as_ref()).await }),
    },
    ToolSpec {
        name: "kb_search",
        write: None,
        run: |c, a| Box::pin(async move { call_search(&c.kb, a.as_ref()).await }),
    },
    ToolSpec {
        name: "kb_read",
        write: None,
        run: |c, a| Box::pin(async move { call_read(&c.kb, a.as_ref()).await }),
    },
    ToolSpec {
        name: "kb_list",
        write: None,
        run: |c, a| Box::pin(async move { call_list(&c.kb, a.as_ref()).await }),
    },
    ToolSpec {
        name: "kb_create",
        write: Some(WriteKind::Create),
        run: |c, a| Box::pin(async move { write::call_create(c, a).await }),
    },
    ToolSpec {
        name: "kb_append",
        write: Some(WriteKind::Append),
        run: |c, a| Box::pin(async move { write::call_append(c, a).await }),
    },
    ToolSpec {
        name: "kb_update",
        write: Some(WriteKind::Update),
        run: |c, a| Box::pin(async move { write::call_update(c, a).await }),
    },
    ToolSpec {
        name: "kb_move",
        write: Some(WriteKind::Move),
        run: |c, a| Box::pin(async move { write::call_move(c, a).await }),
    },
    ToolSpec {
        name: "kb_tag",
        write: Some(WriteKind::Tag),
        run: |c, a| Box::pin(async move { write::call_tag(c, a).await }),
    },
    ToolSpec {
        name: "kb_delete",
        write: Some(WriteKind::Delete),
        run: |c, a| Box::pin(async move { write::call_delete(c, a).await }),
    },
    ToolSpec {
        name: "kb_restore",
        write: Some(WriteKind::Restore),
        run: |c, a| Box::pin(async move { write::call_restore(c, a).await }),
    },
];

fn spec_of(name: &str) -> Option<&'static ToolSpec> {
    TOOLS.iter().find(|t| t.name == name)
}

/// `tools/list` 的内容。**按开关过滤**。
///
/// 这只是两层门的外层（让模型不知道）。内层在 [`call`]——
/// 客户端会缓存工具表，只靠这里过滤治不了旧会话。详见 `gate.rs` 头部。
pub fn definitions(switches: &WriteSwitches) -> Vec<Value> {
    let mut all = read_definitions();
    all.extend(write::definitions());
    all.retain(|d| {
        let name = d["name"].as_str().unwrap_or("");
        // 表里没有的名字一律不上表（fail-closed）：声明了却没接的工具
        // 让模型看得到、调不通，比它根本不知道更糟。
        spec_of(name).is_some_and(|s| s.write.map_or(true, |k| switches.allowed(k)))
    });
    all
}

/// 工具调用的结果 + 审计要用的元信息（W3）。
///
/// 为什么不给 `call` 注入一个审计 sink：`call` 与 `dispatch` 现在只依赖
/// `KbSource`，是纯的、好测的。把副作用**抬到调用方**（server 层）
/// 比往下注入一个依赖干净得多。
pub struct ToolOutput {
    pub value: Value,
    /// 本次返回给模型的笔记 id。🔴 审计**只记 id 不记正文**。
    pub note_ids: Vec<String>,
}

impl From<Value> for ToolOutput {
    /// 错误与空结果路径没有命中的笔记，直接 `.into()` 即可。
    fn from(value: Value) -> Self {
        Self {
            value,
            note_ids: Vec::new(),
        }
    }
}

/// 分发 `tools/call`。
///
/// 🔴 这里是两层门的**内层**，也是真正的那一道：客户端会缓存工具表，
/// 用户关掉开关后，一个早就 `tools/list` 过的会话手里还握着旧表，照样能调过来。
pub async fn call(ctx: &CallCtx, params: Option<&Value>) -> Result<ToolOutput, ToolError> {
    let Some(params) = params else {
        return Err(ToolError::invalid_params("tools/call 缺少 params"));
    };
    let Some(name) = params.get("name").and_then(|v| v.as_str()) else {
        return Err(ToolError::invalid_params("tools/call 缺少 name"));
    };

    let Some(spec) = spec_of(name) else {
        return Err(ToolError::invalid_params(format!(
            "未知工具：{}（当前可用：{}）",
            name,
            available_names(&ctx.switches).join(", ")
        )));
    };

    // 🔴 被关掉的写工具：**明说被关，叫它不要重试**。
    //
    // 不装作「工具不存在」（-32601）：令牌已经把门守住了，没必要向自己人隐瞒；
    // 而模型以为自己记错了工具名就会换名字反复试——浪费 token 还得不到结果。
    if let Some(kind) = spec.write {
        if !ctx.switches.allowed(kind) {
            return Ok(error_result(format!(
                "用户已在 PastePanda 的设置里关闭「{}」权限，{} 不可用。\
                 **请勿重试**，也不要换其它工具绕过——请直接告诉用户：\
                 这一项需要他去「设置 → 知识库 MCP 服务」里打开对应开关。",
                kind.label(),
                name
            ))
            .into());
        }
    }

    let args = params.get("arguments").cloned();
    (spec.run)(ctx.clone(), args).await
}

/// 当前开关下真正可用的工具名（报错文案用）。
///
/// 报全部 11 个会把模型往一个它调不通的工具上引，那只会多一轮往返。
fn available_names(switches: &WriteSwitches) -> Vec<&'static str> {
    TOOLS
        .iter()
        .filter(|t| t.write.map_or(true, |k| switches.allowed(k)))
        .map(|t| t.name)
        .collect()
}

// ===== 工具实现 =====

async fn call_read(kb: &Arc<dyn KbSource>, args: Option<&Value>) -> Result<ToolOutput, ToolError> {
    let Some(id) = arg_str(args, "id") else {
        return Err(ToolError::invalid_params("kb_read 需要参数 id"));
    };
    let id = id.to_string();
    let kb2 = kb.clone();
    let id2 = id.clone();
    let found = match blocking(move || kb2.read(&id2)).await {
        Ok(v) => v,
        Err(e) => return Ok(error_result(format!("读取失败：{}", e)).into()),
    };
    let Some(note) = found else {
        // 不假装成空内容：模型需要知道是「id 不存在」而不是「这篇是空的」。
        return Ok(error_result(format!(
            // 必须带上「或它已在回收站里」：kb_delete 刚把这个 id 交给模型，紧接着
            // 读一下就被告知「不要自己造」的话，模型会以为自己在幻觉。
            // source.rs:300/393/405 三处已经是这个口径，只有这里漏了。
            "没有 id 为 {} 的笔记（或它已在回收站里）。id 要从 kb_search / kb_list 的结果里拿。",
            id
        ))
        .into());
    };
    let folder = folder_label(kb, &note).await;
    Ok(ToolOutput {
        value: text_result(format_full(&note, folder.as_deref())),
        note_ids: vec![note.id.clone()],
    })
}

async fn call_list(kb: &Arc<dyn KbSource>, args: Option<&Value>) -> Result<ToolOutput, ToolError> {
    let folder = arg_str(args, "folder").map(|s| s.to_string());
    let tag = arg_str(args, "tag").map(|s| s.to_string());
    let limit = arg_u32(args, "limit", 20, 1, 50);
    let offset = arg_u32(args, "offset", 0, 0, u32::MAX);

    let kb2 = kb.clone();
    let (f, t) = (folder.clone(), tag.clone());
    let outcome = match blocking(move || kb2.list(f.as_deref(), t.as_deref(), limit, offset)).await
    {
        Ok(v) => v,
        Err(e) => return Ok(error_result(format!("列表查询失败：{}", e)).into()),
    };

    match outcome {
        // 🔴 R6：未知筛选条件必须明说，**不能**当成「不筛」返回全库第一页。
        // 那种退化对模型是隐形的：它拿到一堆看似合理的结果，完全不知道自己的
        // 条件被静默丢掉了，然后把无关的笔记当成证据给用户。
        ListOutcome::UnknownFolder(name) => Ok(error_result(format!(
            "没有叫「{}」的文件夹。未按文件夹筛选的结果并未返回——用 kb_folders 看清楚有哪些文件夹。",
            name
        ))
        .into()),
        ListOutcome::UnknownTag(name) => Ok(error_result(format!(
            "没有叫「{}」的标签。未按标签筛选的结果并未返回——用 kb_folders 看清楚有哪些标签。",
            name
        ))
        .into()),
        ListOutcome::Ok(notes) if notes.is_empty() => Ok(text_result(
            "这个范围内没有笔记。若带了 offset，可能是已经翻过最后一页。",
        )
        .into()),
        ListOutcome::Ok(notes) => {
            let mut out = format!("共 {} 篇（按最近修改倒序）：\n", notes.len());
            for n in &notes {
                let folder = folder_label(kb, n).await;
                out.push('\n');
                out.push_str(&format_brief(n, folder.as_deref()));
            }
            out.push_str("\n用 kb_read(id) 取其中一篇的全文。");
            Ok(ToolOutput {
                value: text_result(out),
                note_ids: notes.iter().map(|n| n.id.clone()).collect(),
            })
        }
    }
}

async fn call_search(kb: &Arc<dyn KbSource>, args: Option<&Value>) -> Result<ToolOutput, ToolError> {
    let Some(query) = arg_str(args, "query") else {
        return Err(ToolError::invalid_params("kb_search 需要参数 query"));
    };
    let query = query.to_string();
    let limit = arg_u32(args, "limit", 5, 1, 20);

    let kb2 = kb.clone();
    let q = query.clone();
    let outcome = match blocking(move || kb2.search(&q, limit)).await {
        Ok(v) => v,
        // 🔴 检索挂了要报错，不能假装成「没找到」（规则 #15.3）——
        // 后者会被模型转述成「你库里没记过」，那是个看不出来的错答案。
        Err(e) => return Ok(error_result(format!("检索失败：{}", e)).into()),
    };

    match outcome {
        SearchOutcome::NoSearchableTerms => Ok(error_result(format!(
            "「{}」里没有可检索的词（单个汉字、单个字母/数字、以及全是高频虚词的组合都会被丢弃）。\n\
             **这不代表库里没有。** 把目标词放进一个更长的短语里重试，或改用 kb_list 浏览。",
            query
        ))
        .into()),
        SearchOutcome::NoMatch => Ok(text_result(format!(
            "没有匹配到「{}」的笔记。\n\
             **零命中不等于库里没有** —— 先换个关键词重试，或用 kb_list 看看库里到底有什么。",
            query
        ))
        .into()),
        SearchOutcome::Hits(notes) => {
            let mut out = format!("找到 {} 篇相关笔记（按相关度排序）：\n", notes.len());
            for n in &notes {
                let folder = folder_label(kb, n).await;
                out.push('\n');
                out.push_str(&format_brief(n, folder.as_deref()));
            }
            out.push_str("\n看完摘要觉得哪篇有用，用 kb_read(id) 取它的全文。");
            Ok(ToolOutput {
                value: text_result(out),
                note_ids: notes.iter().map(|n| n.id.clone()).collect(),
            })
        }
    }
}

async fn call_folders(
    kb: &Arc<dyn KbSource>,
    _args: Option<&Value>,
) -> Result<ToolOutput, ToolError> {
    let kb2 = kb.clone();
    let folders = match blocking(move || kb2.folders()).await {
        Ok(v) => v,
        Err(e) => return Ok(error_result(format!("读文件夹失败：{}", e)).into()),
    };
    let kb2 = kb.clone();
    let tags = match blocking(move || kb2.tags()).await {
        Ok(v) => v,
        Err(e) => return Ok(error_result(format!("读标签失败：{}", e)).into()),
    };

    let mut out = String::new();
    if folders.is_empty() {
        out.push_str("文件夹：一个都没有（所有笔记都在未分类）。\n");
    } else {
        out.push_str(&format!("文件夹（{} 个，缩进表示层级）：\n", folders.len()));
        for f in &folders {
            let indent = "  ".repeat((f.depth.max(1) - 1) as usize);
            out.push_str(&format!(
                "{}- {}（{} 篇，含子文件夹）\n",
                indent, f.name, f.note_count
            ));
        }
        // 同名必须摆出来：写入侧按名字解文件夹，同名时取**第一个匹配**。
        // 不告知的话，kb_move 会把笔记移进一个模型没想着的同名文件夹里。
        let mut names: Vec<&str> = folders.iter().map(|f| f.name.as_str()).collect();
        names.sort_unstable();
        let dups: Vec<&str> = names.windows(2).filter(|w| w[0] == w[1]).map(|w| w[0]).collect();
        if !dups.is_empty() {
            out.push_str(&format!(
                "⚠ 有同名文件夹（{}）。按名字指定时只会命中其中一个，\
                 涉及它们时请让用户确认。\n",
                dups.join("、")
            ));
        }
    }

    out.push('\n');
    if tags.is_empty() {
        out.push_str("标签：一个都没有。\n");
    } else {
        let names: Vec<&str> = tags.iter().map(|t| t.name.as_str()).collect();
        out.push_str(&format!(
            "标签（{} 个）：{}\n",
            names.len(),
            names.join("、")
        ));
    }
    out.push_str("\n🔴 写入类工具不会自动新建文件夹或标签：上面没列出的名字传过去会直接失败。");
    Ok(text_result(out).into())
}

// ===== 辅助 =====

/// R2：**所有 DB 调用都必须走这里。**
///
/// `DataStore` 用的是 `std::sync::Mutex`，它的 guard 不是 `Send`；
/// 直接在 async 上下文里锁，轻则堵住 executor 线程（查询期间整个服务停响应），
/// 重则跨 await 持有 guard 直接编译不过。
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    match tokio::task::spawn_blocking(f).await {
        Ok(r) => r,
        // 不静默（规则 #15.3）：任务 panic 或被取消时要让调用方看得见。
        Err(e) => Err(format!("查询任务异常终止：{}", e)),
    }
}

/// 从 `arguments` 里取非空字符串参数。空串与缺失同一处理——
/// 模型经常传 `""` 表示「不筛」，拿空串去查会变成「找不到叫空的标签」。
fn arg_str<'a>(args: Option<&'a Value>, key: &str) -> Option<&'a str> {
    args?
        .get(key)?
        .as_str()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
}

/// 取字符串数组参数（`kb_tag` 的 add / remove）。
///
/// 宽容两件事：模型常把单个值直接传成字符串而不是单元素数组；
/// 数组里偶尔混空串。两者都不值得让整次调用失败。
fn arg_str_list(args: Option<&Value>, key: &str) -> Vec<String> {
    let Some(v) = args.and_then(|a| a.get(key)) else {
        return Vec::new();
    };
    let raw: Vec<&str> = match v {
        Value::String(s) => vec![s.as_str()],
        Value::Array(items) => items.iter().filter_map(|i| i.as_str()).collect(),
        _ => Vec::new(),
    };
    raw.into_iter()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// 取整数参数并**夹**到 `[min, max]`。
///
/// 夹而不报错：schema 里已声明了范围，模型偶尔越界时给它一个可用结果
/// 比让整次调用失败更有用。负数 / 非数字走 `as_u64()` 自然落回默认值。
fn arg_u32(args: Option<&Value>, key: &str, default: u32, min: u32, max: u32) -> u32 {
    args.and_then(|a| a.get(key))
        .and_then(|v| v.as_u64())
        .map(|v| v.clamp(min as u64, max as u64) as u32)
        .unwrap_or(default)
}

/// 按**字符**（不是字节）截断。
///
/// 🔴 必须用 `chars()`：直接切字节遇中文会在非字符边界上 panic，
/// 而 `panic = "abort"` 下一次 panic 就是整个应用死掉（R3）。
fn truncate_chars(s: &str, n: usize) -> String {
    let mut out: String = s.chars().take(n).collect();
    if s.chars().nth(n).is_some() {
        out.push('…');
    }
    out
}

/// 笔记所在文件夹的显示名。拿不到就不显示（不报错）。
async fn folder_label(kb: &Arc<dyn KbSource>, note: &Note) -> Option<String> {
    let id = note.folder_id.clone()?;
    let kb2 = kb.clone();
    blocking(move || Ok(kb2.folder_name(&id))).await.ok()?
}

/// 列表/搜索里的一条。**id 放在最前面**：模型接下来就要拿它去调 kb_read。
fn format_brief(n: &Note, folder: Option<&str>) -> String {
    let title = if n.title.trim().is_empty() {
        "（无标题）"
    } else {
        n.title.trim()
    };
    // 有 AI 摘要就用摘要，否则截正文——与界面列表同口径。
    let brief = match n
        .summary
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(s) => truncate_chars(s, BRIEF_CHARS),
        None => truncate_chars(n.content.trim(), BRIEF_CHARS),
    };
    let mut meta = format!("更新于 {}", n.updated_at);
    if let Some(f) = folder {
        meta.push_str(&format!(" ｜ 文件夹：{}", f));
    }
    if !n.tags.is_empty() {
        let names: Vec<&str> = n.tags.iter().map(|t| t.name.as_str()).collect();
        meta.push_str(&format!(" ｜ 标签：{}", names.join("、")));
    }
    format!("id={}\n【{}】\n{}\n{}\n", n.id, title, meta, brief)
}

/// `kb_read` 的全文输出。
fn format_full(n: &Note, folder: Option<&str>) -> String {
    let title = if n.title.trim().is_empty() {
        "（无标题）"
    } else {
        n.title.trim()
    };
    let mut out = format!(
        "【{}】\nid={}\n创建于 {} ｜ 更新于 {}",
        title, n.id, n.created_at, n.updated_at
    );
    if let Some(f) = folder {
        out.push_str(&format!(" ｜ 文件夹：{}", f));
    }
    if !n.tags.is_empty() {
        let names: Vec<&str> = n.tags.iter().map(|t| t.name.as_str()).collect();
        out.push_str(&format!(" ｜ 标签：{}", names.join("、")));
    }
    out.push_str("\n\n---\n\n");
    out.push_str(n.content.trim());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 全开时的全部工具定义（测试便利）。
    fn all() -> Vec<Value> {
        definitions(&WriteSwitches::ALL_ON)
    }

    #[test]
    fn test_every_write_kind_has_exactly_one_tool() {
        // 一档开关对一个工具（1:1）。多了意味着用户关一个开关关掉两个能力；
        // 少了意味着面板上有个开关点了没任何效果。
        for kind in WriteKind::ALL {
            let n = TOOLS.iter().filter(|t| t.write == Some(kind)).count();
            assert_eq!(n, 1, "{} 对应了 {} 个工具", kind.cfg_key(), n);
        }
        assert_eq!(TOOLS.iter().filter(|t| t.write.is_some()).count(), 7);
    }

    #[test]
    fn test_write_kind_tool_names_match_registry() {
        // `WriteKind::tool_name()` 与本表里的名字是两份写法（前者给设置页用）。
        // 对不上的后果：面板上写着关的是 kb_delete，实际关掉的是另一个。
        for kind in WriteKind::ALL {
            let spec = TOOLS
                .iter()
                .find(|t| t.write == Some(kind))
                .expect("每档必有工具");
            assert_eq!(spec.name, kind.tool_name(), "{} 的工具名不一致", kind.cfg_key());
        }
    }

    #[test]
    fn test_switch_off_hides_only_that_tool() {
        // 外层门：关掉一档，`tools/list` 里只能少掉对应的那一个。
        for kind in WriteKind::ALL {
            let sw = WriteSwitches::from_config(&json!({ kind.cfg_key(): false }));
            let names: Vec<String> = definitions(&sw)
                .iter()
                .filter_map(|t| t["name"].as_str().map(|s| s.to_string()))
                .collect();
            assert_eq!(names.len(), 10, "关 {} 后工具数不对", kind.cfg_key());
            let hidden = TOOLS
                .iter()
                .find(|t| t.write == Some(kind))
                .expect("每档必有工具")
                .name;
            assert!(
                !names.contains(&hidden.to_string()),
                "{} 没被藏起来",
                hidden
            );
        }
    }

    #[test]
    fn test_read_tools_survive_all_switches_off() {
        // 写开关全关时服务退回只读，四个只读工具一个不能少。
        let names: Vec<String> = definitions(&WriteSwitches::ALL_OFF)
            .iter()
            .filter_map(|t| t["name"].as_str().map(|s| s.to_string()))
            .collect();
        assert_eq!(names.len(), 4);
        for expect in ["kb_folders", "kb_search", "kb_read", "kb_list"] {
            assert!(names.contains(&expect.to_string()), "丢了 {}", expect);
        }
    }

    #[test]
    fn test_definitions_and_dispatch_agree() {
        // 手写三件套的唯一真风险：声明了却没接（模型调了报未知工具），
        // 或接了却没声明（模型永远不知道它存在）。这条测试就是护栏。
        let mut declared: Vec<String> = all()
            .iter()
            .filter_map(|t| t["name"].as_str().map(|s| s.to_string()))
            .collect();
        let mut dispatched: Vec<String> = TOOLS.iter().map(|t| t.name.to_string()).collect();
        declared.sort();
        dispatched.sort();
        assert_eq!(declared, dispatched);
        assert_eq!(
            declared.len(),
            11,
            "工具数量变了就要重读一遍本模块头部的取舍说明"
        );
    }

    #[test]
    fn test_every_tool_has_a_usable_schema() {
        for t in all() {
            let name = t["name"].as_str().unwrap_or("");
            assert!(
                t["description"].as_str().is_some_and(|d| d.len() > 20),
                "{} 的 description 太短，模型没依据判该不该用它",
                name
            );
            assert_eq!(
                t["inputSchema"]["type"], "object",
                "{} 的 schema 类型不对",
                name
            );
            assert!(
                t["inputSchema"]["properties"].is_object(),
                "{} 缺 properties",
                name
            );
        }
    }

    #[test]
    fn test_search_description_carries_the_tokenizer_caveat() {
        // 🔴 口径差必须写进工具描述。不写的后果：模型搜单字得零命中，
        // 然后告诉用户「你库里没记过」—— 一个比报错更坏的错答案。
        let search = all()
            .into_iter()
            .find(|t| t["name"] == "kb_search")
            .expect("kb_search 必须存在");
        let d = search["description"].as_str().unwrap_or("");
        assert!(d.contains("单个汉字"), "未告知单字会被丢弃");
        assert!(d.contains("零命中不等于"), "未告知零命中不能当「库里没有」");
        assert!(d.contains("kb_read"), "未指引模型接下来用 kb_read 取全文");
    }

    #[test]
    fn test_error_result_is_marked() {
        let r = error_result("boom");
        assert_eq!(r["isError"], true);
        assert_eq!(r["content"][0]["type"], "text");
        assert_eq!(r["content"][0]["text"], "boom");
        // 成功结果不得带 isError，否则模型会把正常结果当失败
        assert!(text_result("fine").get("isError").is_none());
    }
}
