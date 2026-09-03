//! 十一个写工具（M5）——**但只有七档开关**。
//!
//! O-8 新加的四个精准编辑工具复用现有档位（见 `gate.rs` 的 `tool_names`）：
//! 它们与 `kb_update` / `kb_append` 是同一种能力的不同粒度。
//!
//! # 三条硬规则
//!
//! 1. 🔴 **`source_agent` 必填**。每一次写入都标上 `agent:<客户端>`，
//!    界面上要能一眼看出「这条是 AI 写的」。而且它不只是标签：
//!    来源非空会触发 W2 的锚定快照，传空就等于把那层保护静默关掉。
//! 2. 🔴 **删除只能软删**。`note_purge` / `note_purge_all` 永不开放给模型——
//!    模型删的东西必须能从回收站找回来。
//! 3. 🔴 **速记不可写**。没有任何工具接受 `daily_date` 参数：
//!    那是热键的身份，模型写了会撞 `idx_notes_daily` 唯一约束。
//!    这条靠**根本不开那个参数**实现，而不是靠参数校验。
//!
//! # 为何 `kb_append` 单列一个工具
//!
//! 「往一篇里追一段」是模型最常见的写动作。走 `kb_update` 的话它得先
//! `kb_read` 拿全文、拼好再整篇回写——既费 token，又**极容易把原文写丢**
//! （模型概括了一下就覆盖了原篇）。追加是个本质上更安全的操作。

use serde_json::{json, Value};

use super::{
    arg_str, arg_str_list, blocking, error_result, text_result, CallCtx, ToolError, ToolOutput,
};
use crate::data_store::Note;
use crate::markdown::{ContentEdit, EditReport, InsertAt};

/// 回话里用的标题。空标题给个占位，否则句子里会出现一对空书名号。
fn title_of(n: &Note) -> String {
    let t = n.title.trim();
    if t.is_empty() {
        "（无标题）".to_string()
    } else {
        t.to_string()
    }
}

/// 写成功后给模型的回复。**带上 id**：它下一步很可能要拿着继续操作。
///
/// `extra` 给那些有额外副作用要告知的写入（如改标题顺带重写引用，O-9）。
fn wrote_note(note: &Note, what: &str, extra: Option<String>) -> ToolOutput {
    let mut text = format!("{}：「{}」\nid={}", what, title_of(note), note.id);
    if let Some(e) = extra {
        text.push_str(&e);
    }
    ToolOutput {
        value: text_result(text),
        note_ids: vec![note.id.clone()],
    }
}

fn wrote(note: &Note, what: &str) -> ToolOutput {
    wrote_note(note, what, None)
}

/// 本次写入该落的来源。
///
/// 🔴 空串是**不允许**的（见 [`CallCtx::source`]）：它在 W2 里的语义是
/// 「人亲自改的」，会让锚定快照静默失效。真出现就兜成 `agent:unknown`：
/// 宁可来源不精确，也不能丢掉保护。
fn source(ctx: &CallCtx) -> String {
    if ctx.source.trim().is_empty() {
        "agent:unknown".to_string()
    } else {
        ctx.source.clone()
    }
}

/// 每个写工具描述末尾都接这一句。
///
/// 告知模型「你的动作留痕且可恢复」不是客套：它会影响模型向用户的交代方式
/// （能说清「改了哪里、怎么撤」），也避免它因为怕不可逆而不敢动。
const WRITE_FOOTER: &str = "\n\n此操作会计入用户可见的调用记录，并在笔记上标注改动来源；\
     修改类操作会自动留下版本快照，用户可以随时恢复。";

/// 三个 section 类工具的 inputSchema：`id` + 定位符 + 各自的额外参数。
///
/// 抽出来是因为定位符的说明有三处要一字不差（规则 #11）：
/// 说明不一致会让模型对同一个参数产生三种理解。
fn section_schema(extra: Value, required: &[&str]) -> Value {
    let mut props = json!({
        "id": {
            "type": "string",
            "description": "笔记 id，来自 kb_search / kb_list / kb_sections 的返回结果。"
        },
        "section": {
            "type": "string",
            "description": "按**标题路径**定位要动的那一节（如「架构 / 数据流」，\
                              也可只写尾段「数据流」）。\
                              命中多节时报错并列出候选，**不会随便挑一个**。\
                              与 index 只能给一个。"
        },
        "index": {
            "type": "integer",
            "minimum": 0,
            "description": "按 kb_sections 给的**序号**定位要动的那一节。\
                              0 = 第一个标题之前的引言部分。与 section 只能给一个。"
        }
    });
    if let (Some(p), Some(e)) = (props.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            p.insert(k.clone(), v.clone());
        }
    }
    json!({ "type": "object", "properties": props, "required": required })
}

/// 十一个写工具的定义。**本函数不做开关过滤**，过滤在 [`super::definitions`]。
pub fn definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "kb_create",
            "description": format!(
                "在用户的知识库里新建一篇笔记。\n\
                 先用 kb_search 确认一下同一主题是不是已经有了——如果有，\
                 用 kb_append 追到那篇里比另开一篇更有用。{}",
                WRITE_FOOTER
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "标题。必填。" },
                    "content": { "type": "string", "description": "正文，Markdown。" },
                    "folder": {
                        "type": "string",
                        "description": "放进哪个文件夹（名字，用 kb_folders 查）。\
                                          省略 = 未分类。**不存在的名字会直接失败，不会自动新建**。"
                    }
                },
                "required": ["title", "content"]
            }
        }),
        json!({
            "name": "kb_append",
            "description": format!(
                "往一篇已有笔记的**末尾追加**一段内容，原有内容不动。\n\
                 只是“再添一条”时请**优先用它而不是 kb_update**：\
                 kb_update 是整篇覆盖，很容易把用户原有的内容写丢。{}",
                WRITE_FOOTER
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "笔记 id，来自 kb_search / kb_list。" },
                    "text": { "type": "string", "description": "要追加的内容。会隔一个空行接在末尾。" }
                },
                "required": ["id", "text"]
            }
        }),
        json!({
            "name": "kb_update",
            "description": format!(
                "改一篇笔记的标题和/或正文。\n\
                 ⚠ **content 是整篇覆盖**，不是局部修改。只想添内容就用 kb_append；\
                 真要重写整篇时，请**先 kb_read 拿到当前全文**，在它基础上改，\
                 不要凭记忆或凭摘要重建——那会把用户写的细节概括掉。\n\
                 只传 title 就只改标题，只传 content 就只改正文。{}",
                WRITE_FOOTER
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "笔记 id。" },
                    "title": { "type": "string", "description": "新标题。省略 = 不改标题。" },
                    "content": {
                        "type": "string",
                        "description": "新正文（**整篇替换**）。省略 = 不改正文。"
                    }
                },
                "required": ["id"]
            }
        }),
        json!({
            "name": "kb_update_section",
            "description": format!(
                "**只重写某一节的正文**，标题行不动、其它节不动。\n\
                 先用 kb_sections 看大纲拿到序号或标题路径，再用它改。\n\
                 🔴 比 kb_update 安全得多：kb_update 是你拿着几十秒前读到的全文整篇覆盖，\
                 期间用户在界面上改的东西会被抹掉；这里只碰你点名的那一节。\n\
                 🔴 节是**平的**：改 `## A` 不会动它下面的 `### A1`。\
                 返回里会告知有几个子节没被动。\n\
                 🔴 body 传空字符串 = **清空这一节的正文**（标题保留）。\
                 不想改就别调，不要用空串试探。{}",
                WRITE_FOOTER
            ),
            "inputSchema": section_schema(
                json!({
                    "body": {
                        "type": "string",
                        "description": "这一节的新正文（不含标题行）。\
                                          段落间的空行会自动维护，不用你操心。"
                    }
                }),
                &["id", "body"]
            )
        }),
        json!({
            "name": "kb_insert_at_section",
            "description": format!(
                "在某一节的指定位置**插入**一段，原有内容一字不动。\n\
                 想在某节前面新开一节就用 position=before，\
                 想往某节末尾补一段就用 position=end。{}",
                WRITE_FOOTER
            ),
            "inputSchema": section_schema(
                json!({
                    "text": {
                        "type": "string",
                        "description": "要插入的内容。空内容会报错，而不是让你以为写进去了。"
                    },
                    "position": {
                        "type": "string",
                        "enum": ["before", "start", "end"],
                        "description": "before = 插在这一节的**标题行之前**（用于在它前面新开一节）；\
                                          start = 标题行之后、本节正文的开头；\
                                          end = 本节正文的末尾（下一个标题之前）。默认 end。"
                    }
                }),
                &["id", "text"]
            )
        }),
        json!({
            "name": "kb_replace_in_note",
            "description": format!(
                "把笔记里的一段原文换成另一段。适合改错别字、改一句话这种局部修正。\n\
                 🔴 **要求全文唯一命中**。命中 0 处或多处都会报错，且**一个字也不改**：\
                 若默认全换，你想改第一处却改了七处；\
                 若默认只换第一处，你以为改完了实际还剩六处。两种默认都是你看不出来的错。\n\
                 命中多处时把 find 向前后加长到唯一，或改用 kb_update_section。\n\
                 行尾无需操心：LF 与 CRLF 会自动对齐。{}",
                WRITE_FOOTER
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "笔记 id，来自 kb_search / kb_list 的返回结果。"
                    },
                    "find": {
                        "type": "string",
                        "description": "要被替掉的原文，**照 kb_read 拿到的内容一字不改地拷**。"
                    },
                    "replace": {
                        "type": "string",
                        "description": "换成什么。传空字符串 = 删掉 find 那一段。"
                    }
                },
                "required": ["id", "find", "replace"]
            }
        }),
        json!({
            "name": "kb_prepend",
            "description": format!(
                "把一段内容插到笔记正文的**最开头**，原有内容不动。\
                 与 kb_append（插到末尾）互为一对，归同一个「追加内容」开关。\n\
                 带 frontmatter 的笔记会插在 frontmatter 之后，不会撑坏它。{}",
                WRITE_FOOTER
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "笔记 id，来自 kb_search / kb_list 的返回结果。"
                    },
                    "text": {
                        "type": "string",
                        "description": "要插到开头的内容。"
                    }
                },
                "required": ["id", "text"]
            }
        }),
        json!({
            "name": "kb_move",
            "description": format!(
                "把一篇笔记移到另一个文件夹。\n\
                 文件夹结构是用户自己的组织方式，**不要主动帮他重排**；\
                 除非用户明确要求，否则不要调它。{}",
                WRITE_FOOTER
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "笔记 id。" },
                    "folder": {
                        "type": "string",
                        "description": "目标文件夹名（用 kb_folders 查）。\
                                          省略 = 移回未分类。**不存在的名字会失败，不会自动新建**。"
                    }
                },
                "required": ["id"]
            }
        }),
        json!({
            "name": "kb_tag",
            "description": format!(
                "给一篇笔记加或去标签。只动点名的那几个，其它标签不受影响。\n\
                 标签体系是用户自己的，**只能用已存在的标签**（先用 kb_folders 看），\
                 不会自动新建。{}",
                WRITE_FOOTER
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "笔记 id。" },
                    "add": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "要加上的标签名。已有的会被忽略。"
                    },
                    "remove": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "要去掉的标签名。本来没有的会被忽略。"
                    }
                },
                "required": ["id"]
            }
        }),
        json!({
            "name": "kb_delete",
            "description": format!(
                "把一篇笔记**删到回收站**（可恢复，30 天后自动销毁）。\n\
                 没有彻底删除的工具，也不要去找——那一步只能用户自己在界面上做。\n\
                 ⚠ **删之前先确认用户真的要删这一篇**：拿不准就先 kb_read 把标题与\
                 开头念给用户听，而不是根据标题像不像自己判。{}",
                WRITE_FOOTER
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "笔记 id。" }
                },
                "required": ["id"]
            }
        }),
        json!({
            "name": "kb_restore",
            "description": format!(
                "把一篇在回收站里的笔记拿回来。删错了用它自己改回来。\n\
                 回收站里的笔记**不会**出现在 kb_search / kb_list 的结果里，\
                 所以 id 得从你刚才 kb_delete 的回复里拿。{}",
                WRITE_FOOTER
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "笔记 id。" }
                },
                "required": ["id"]
            }
        }),
    ]
}

// ===== 工具实现 =====

pub(super) async fn call_create(
    ctx: CallCtx,
    args: Option<Value>,
) -> Result<ToolOutput, ToolError> {
    let a = args.as_ref();
    let Some(title) = arg_str(a, "title").map(str::to_string) else {
        return Err(ToolError::invalid_params("kb_create 需要参数 title"));
    };
    // content 允许为空：先开一篇再用 kb_append 填是合理的用法。
    let content = arg_str(a, "content").unwrap_or("").to_string();
    let folder = arg_str(a, "folder").map(str::to_string);
    let src = source(&ctx);
    let kb = ctx.kb.clone();
    match blocking(move || kb.create(&title, &content, folder.as_deref(), &src)).await {
        Ok(n) => Ok(wrote(&n, "已新建笔记")),
        Err(e) => Ok(error_result(format!("新建失败：{}", e)).into()),
    }
}

pub(super) async fn call_append(
    ctx: CallCtx,
    args: Option<Value>,
) -> Result<ToolOutput, ToolError> {
    let a = args.as_ref();
    let Some(id) = arg_str(a, "id").map(str::to_string) else {
        return Err(ToolError::invalid_params("kb_append 需要参数 id"));
    };
    let Some(text) = arg_str(a, "text").map(str::to_string) else {
        // 空追加不当成功：否则模型以为它写进去了（规则 #15.3）。
        return Err(ToolError::invalid_params(
            "kb_append 需要参数 text（且不能是空内容）",
        ));
    };
    let src = source(&ctx);
    let kb = ctx.kb.clone();
    match blocking(move || kb.append(&id, &text, &src)).await {
        Ok(n) => Ok(wrote(&n, "已追加到笔记")),
        Err(e) => Ok(error_result(format!("追加失败：{}", e)).into()),
    }
}

pub(super) async fn call_update(
    ctx: CallCtx,
    args: Option<Value>,
) -> Result<ToolOutput, ToolError> {
    let a = args.as_ref();
    let Some(id) = arg_str(a, "id").map(str::to_string) else {
        return Err(ToolError::invalid_params("kb_update 需要参数 id"));
    };
    let title = arg_str(a, "title").map(str::to_string);
    let content = arg_str(a, "content").map(str::to_string);
    let src = source(&ctx);
    let kb = ctx.kb.clone();
    match blocking(move || kb.update(&id, title.as_deref(), content.as_deref(), &src)).await {
        Ok((n, rep)) => {
            // O-9：改标题会顺带重写其它笔记里的 `[[旧标题]]`。
            // 必须说出来——模型以为自己只动了一篇，实际动了 N+1 篇，
            // 而它向用户交代的会是一个不完整的事实。
            let extra = (rep.relinked > 0).then(|| {
                format!(
                    "\n\n🔴 顺带重写了 **{} 篇其它笔记**里指向旧标题的 [[引用]]。\
                     wiki 链按标题存，不重写那些引用就全断了；\
                     每一篇都留了版本快照，用户可以恢复。\
                     **请把这件事告诉用户。**",
                    rep.relinked
                )
            });
            Ok(wrote_note(&n, "已修改笔记", extra))
        }
        Err(e) => Ok(error_result(format!("修改失败：{}", e)).into()),
    }
}

// ===== 精准编辑四件（O-8）=====

/// 四个精准编辑工具共用的收尾。
///
/// `untouched_children` 必须说出来：节是平的，不告知的话
/// AI 以为自己重写了整棵子树，然后据此向用户下结论。
fn edited(note: &Note, report: &EditReport) -> ToolOutput {
    let mut text = format!("{}\n【{}】\nid={}", report.summary, title_of(note), note.id);
    if report.untouched_children > 0 {
        text.push_str(&format!(
            "\n注意：这一节下面还有 {} 个子节，**没有**被改动。",
            report.untouched_children
        ));
    }
    ToolOutput {
        value: text_result(text),
        note_ids: vec![note.id.clone()],
    }
}

/// 四个精准编辑工具的公用入口。
///
/// 失败文案**不加「编辑失败：」前缀**：`markdown::apply` 与 `edit_on`
/// 返的本来就是写给模型看的完整中文句子（带下一步指引），
/// 再包一层只会把重点推得更远。
async fn run_edit(ctx: CallCtx, id: String, op: ContentEdit) -> Result<ToolOutput, ToolError> {
    let src = source(&ctx);
    let kb = ctx.kb.clone();
    match blocking(move || kb.edit_content(&id, &op, &src)).await {
        Ok((n, rep)) => Ok(edited(&n, &rep)),
        Err(e) => Ok(error_result(e).into()),
    }
}

/// 取定位符。精准编辑**必须**给定位符（不像 `kb_read` 可以不给=整篇）：
/// 不给就默认整篇的话，一次手误就从「改一节」变成了「覆盖全文」。
fn need_locator(
    args: Option<&Value>,
    tool: &str,
) -> Result<crate::markdown::SectionRef, ToolError> {
    super::section_ref(args, tool)?.ok_or_else(|| {
        ToolError::invalid_params(format!(
            "{} 需要 section（标题路径）或 index（序号）之一。\
             先调 kb_sections 看大纲拿到它们。若确实想改整篇，用 kb_update。",
            tool
        ))
    })
}

/// 取一个**允许为空串但必须显式给**的字符串参数。
///
/// 🔴 不能用 `arg_str`：它把空串与缺失归为同一件事（对筛选参数是对的）。
/// 但 `body` / `replace` 上那两者是不同的意图：空串 = 「清空它」，
/// 缺失 = 「参数忘了」。混起来会让一次手误静默清掉一节正文。
fn arg_str_allow_empty<'a>(args: Option<&'a Value>, key: &str) -> Option<&'a str> {
    args?.get(key)?.as_str()
}

pub(super) async fn call_update_section(
    ctx: CallCtx,
    args: Option<Value>,
) -> Result<ToolOutput, ToolError> {
    let a = args.as_ref();
    let Some(id) = arg_str(a, "id").map(str::to_string) else {
        return Err(ToolError::invalid_params("kb_update_section 需要参数 id"));
    };
    let locator = need_locator(a, "kb_update_section")?;
    let Some(body) = arg_str_allow_empty(a, "body") else {
        return Err(ToolError::invalid_params(
            "kb_update_section 需要参数 body（传空字符串表示清空这一节的正文）。",
        ));
    };
    let op = ContentEdit::UpdateSection {
        locator,
        body: body.to_string(),
    };
    run_edit(ctx, id, op).await
}

pub(super) async fn call_insert_at_section(
    ctx: CallCtx,
    args: Option<Value>,
) -> Result<ToolOutput, ToolError> {
    let a = args.as_ref();
    let Some(id) = arg_str(a, "id").map(str::to_string) else {
        return Err(ToolError::invalid_params("kb_insert_at_section 需要参数 id"));
    };
    let locator = need_locator(a, "kb_insert_at_section")?;
    let Some(text) = arg_str(a, "text").map(str::to_string) else {
        return Err(ToolError::invalid_params(
            "kb_insert_at_section 需要参数 text（且不能是空内容）。",
        ));
    };
    let at = match arg_str(a, "position").unwrap_or("end") {
        "before" => InsertAt::BeforeHeading,
        "start" => InsertAt::BodyStart,
        "end" => InsertAt::BodyEnd,
        // 不静默兜成默认值：模型以为插在开头、实际插在末尾，
        // 而它从返回里看不出来（规则 #15.3）。
        other => {
            return Err(ToolError::invalid_params(format!(
                "position 只能是 before / start / end，收到「{}」。",
                other
            )))
        }
    };
    run_edit(ctx, id, ContentEdit::InsertAtSection { locator, text, at }).await
}

pub(super) async fn call_replace_in_note(
    ctx: CallCtx,
    args: Option<Value>,
) -> Result<ToolOutput, ToolError> {
    let a = args.as_ref();
    let Some(id) = arg_str(a, "id").map(str::to_string) else {
        return Err(ToolError::invalid_params("kb_replace_in_note 需要参数 id"));
    };
    let Some(find) = arg_str(a, "find").map(str::to_string) else {
        return Err(ToolError::invalid_params(
            "kb_replace_in_note 需要参数 find（且不能为空）。",
        ));
    };
    let Some(replace) = arg_str_allow_empty(a, "replace") else {
        return Err(ToolError::invalid_params(
            "kb_replace_in_note 需要参数 replace（传空字符串表示删掉 find 那一段）。",
        ));
    };
    let op = ContentEdit::ReplaceText {
        find,
        replace: replace.to_string(),
    };
    run_edit(ctx, id, op).await
}

pub(super) async fn call_prepend(
    ctx: CallCtx,
    args: Option<Value>,
) -> Result<ToolOutput, ToolError> {
    let a = args.as_ref();
    let Some(id) = arg_str(a, "id").map(str::to_string) else {
        return Err(ToolError::invalid_params("kb_prepend 需要参数 id"));
    };
    let Some(text) = arg_str(a, "text").map(str::to_string) else {
        return Err(ToolError::invalid_params(
            "kb_prepend 需要参数 text（且不能是空内容）。",
        ));
    };
    run_edit(ctx, id, ContentEdit::Prepend { text }).await
}

pub(super) async fn call_move(ctx: CallCtx, args: Option<Value>) -> Result<ToolOutput, ToolError> {
    let a = args.as_ref();
    let Some(id) = arg_str(a, "id").map(str::to_string) else {
        return Err(ToolError::invalid_params("kb_move 需要参数 id"));
    };
    let folder = arg_str(a, "folder").map(str::to_string);
    let kb = ctx.kb.clone();
    let id2 = id.clone();
    match blocking(move || kb.move_to(&id2, folder.as_deref())).await {
        Ok(target) => Ok(ToolOutput {
            value: text_result(format!("已移到「{}」。\nid={}", target, id)),
            note_ids: vec![id],
        }),
        Err(e) => Ok(error_result(format!("移动失败：{}", e)).into()),
    }
}

pub(super) async fn call_tag(ctx: CallCtx, args: Option<Value>) -> Result<ToolOutput, ToolError> {
    let a = args.as_ref();
    let Some(id) = arg_str(a, "id").map(str::to_string) else {
        return Err(ToolError::invalid_params("kb_tag 需要参数 id"));
    };
    let add = arg_str_list(a, "add");
    let remove = arg_str_list(a, "remove");
    let kb = ctx.kb.clone();
    let id2 = id.clone();
    match blocking(move || kb.tag(&id2, &add, &remove)).await {
        // 报**实际**生效数而不是请求数：加一个已有的标签时这两个数不一样，
        // 而“没生效”是模型应该知道的事。
        Ok((added, removed)) => Ok(ToolOutput {
            value: text_result(format!(
                "标签已更新：新增 {} 个、移除 {} 个。\nid={}",
                added, removed, id
            )),
            note_ids: vec![id],
        }),
        Err(e) => Ok(error_result(format!("改标签失败：{}", e)).into()),
    }
}

pub(super) async fn call_delete(
    ctx: CallCtx,
    args: Option<Value>,
) -> Result<ToolOutput, ToolError> {
    let a = args.as_ref();
    let Some(id) = arg_str(a, "id").map(str::to_string) else {
        return Err(ToolError::invalid_params("kb_delete 需要参数 id"));
    };
    let kb = ctx.kb.clone();
    let id2 = id.clone();
    match blocking(move || kb.delete(&id2)).await {
        // 把 id 原样送回去：删后它就不在 kb_search / kb_list 里了，
        // 模型想改回来只能靠这一句里的 id。
        Ok(title) => Ok(ToolOutput {
            value: text_result(format!(
                "已删到回收站：「{}」。\n删错了用 kb_restore(id=\"{}\") 拿回来（或用户自己在回收站里恢复）。",
                title, id
            )),
            note_ids: vec![id],
        }),
        Err(e) => Ok(error_result(format!("删除失败：{}", e)).into()),
    }
}

pub(super) async fn call_restore(
    ctx: CallCtx,
    args: Option<Value>,
) -> Result<ToolOutput, ToolError> {
    let a = args.as_ref();
    let Some(id) = arg_str(a, "id").map(str::to_string) else {
        return Err(ToolError::invalid_params("kb_restore 需要参数 id"));
    };
    let kb = ctx.kb.clone();
    let id2 = id.clone();
    match blocking(move || kb.restore(&id2)).await {
        Ok(title) => Ok(ToolOutput {
            value: text_result(format!("已从回收站恢复：「{}」。\nid={}", title, id)),
            note_ids: vec![id],
        }),
        Err(e) => Ok(error_result(format!("恢复失败：{}", e)).into()),
    }
}
