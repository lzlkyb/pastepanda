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
    arg_i64, arg_str, arg_str_list, blocking, error_result, text_result, CallCtx, ToolError,
    ToolOutput,
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

// 这里原本有一个 `WRITE_FOOTER`，接在**每一个**写工具描述的末尾：
// 「会计入调用记录 + 标注来源 + 留版本快照」。
//
// 🔴 它搬到了 `protocol::server_instructions` 的「写入约定」里，只说一遍。
// 原因不是「冗余不好看」，而是它逐字重复了 **11 遍**，而工具表是
// 每次会话都要付的常驻开销。同一句话在同一个上下文里出现一次就够了。
//
// 告知本身不能丢：模型不知道自己的动作可撤时，一来会因为怕不可逆而不敢动，
// 二来没法向用户交代「改了哪里、怎么撤」。protocol.rs 那边有测试钉着。

/// 「删了还能后悔多久」那一句。
///
/// 🔴 **必须拿真值拼，不能写死「30 天」**：`note_trash_days` 是用户可改的
/// （设置 → 常规）。写死的话，用户设成 7 天后模型仍会向他保证
/// 「30 天内都能恢复」——他信了，第八天东西就没了。
fn trash_note(days: i64) -> String {
    if days <= 0 {
        // 0 = 用户关掉了自动销毁。这时再说「N 天后销毁」同样是假话。
        "可恢复：这台机器上回收站的自动销毁是关着的，删掉的笔记会一直留在回收站里。"
            .to_string()
    } else {
        format!(
            "可恢复：删掉的笔记会在回收站里留 {} 天（用户自己设的值），到期后自动销毁。",
            days
        )
    }
}

/// 三个 section 类工具的 inputSchema：`id` + 定位符 + 各自的额外参数。
///
/// 抽出来是因为定位符的说明有三处要一字不差（规则 #11）：
/// 说明不一致会让模型对同一个参数产生三种理解。
fn section_schema(extra: Value, required: &[&str]) -> Value {
    let mut props = json!({
        "id": {
            "type": "string",
            "description": "笔记 id。"
        },
        "section": {
            "type": "string",
            "description": "按标题路径定位（如「架构/数据流」或尾段）。"
        },
        "index": {
            "type": "integer",
            "minimum": 0,
            "description": "按 kb_sections 序号定位。0=标题前引言。"
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
///
/// `trash_days` 只给 `kb_delete` 用，理由见 [`trash_note`]。
///
/// 描述压缩判据同 `read_definitions`：能力/政策留，报错恢复删。
/// 硬约束（整篇覆盖、唯一命中、软删可恢复、只动自己写的）一字不丢。
pub fn definitions(trash_days: i64) -> Vec<Value> {
    vec![
        json!({
            "name": "kb_create",
            "description": "新建笔记。先 kb_search 查同主题——有就用 kb_append。\n\
                 项目说明（怎么跑/配/架构）→「手册」夹（没有先 kb_folder_create）；\
                 一次性结论/坑 → 主题夹。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "标题。必填。" },
                    "content": { "type": "string", "description": "正文，Markdown。" },
                    "folder": {
                        "type": "string",
                        "description": "文件夹名，见 kb_folders。省略=未分类。名不存在会失败。"
                    }
                },
                "required": ["title", "content"]
            }
        }),
        json!({
            "name": "kb_folder_create",
            "description": "新建文件夹。先 kb_folders，有相近的就用现有的。\n\
                 🔴 只建来放**你自己写的东西**；用户建的夹别重排。\n\
                 🔴 会标成「由 AI 创建」（kb_folders 显示 ［AI］），用户可一键撤销\
                （笔记与子夹升到父级，不丢）。同父不能重名；层数有上限。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "文件夹名。必填。" },
                    "parent": {
                        "type": "string",
                        "description": "父文件夹名，见 kb_folders。**必填**：只能在已授权夹里建子夹\
                                      （省略=顶层，通常被拒）。名不存在会失败。"
                    }
                },
                "required": ["name"]
            }
        }),
        json!({
            "name": "kb_append",
            "description": "往笔记**末尾追加**，原文不动。添内容优先用它，\
                 别用 kb_update（整篇覆盖易写丢）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "笔记 id。" },
                    "text": { "type": "string", "description": "要追加的内容。" }
                },
                "required": ["id", "text"]
            }
        }),
        json!({
            "name": "kb_update",
            "description": "改标题和/或正文。⚠ content=**整篇覆盖**。\
                 只添内容用 kb_append；重写前先 kb_read 再改，别凭摘要重建。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "笔记 id。" },
                    "title": { "type": "string", "description": "新标题。省略=不改。" },
                    "content": {
                        "type": "string",
                        "description": "新正文（**整篇替换**）。省略=不改。"
                    }
                },
                "required": ["id"]
            }
        }),
        json!({
            "name": "kb_update_section",
            "description": "只重写某一节正文，标题与其它节不动。先 kb_sections 拿序号/标题路径。\n\
                 🔴 比 kb_update 安全：只碰点名的节。节是**平的**，改 `## A` 不动 `### A1`。\n\
                 🔴 body 空串=**清空本节**。不想改就别调。",
            "inputSchema": section_schema(
                json!({
                    "body": {
                        "type": "string",
                        "description": "这一节新正文（不含标题行）。空行自动维护。"
                    }
                }),
                &["id", "body"]
            )
        }),
        json!({
            "name": "kb_insert_at_section",
            "description": "在某一节指定位置**插入**，原文不动。\
                 before=标题前新开节；end=本节末尾。",
            "inputSchema": section_schema(
                json!({
                    "text": {
                        "type": "string",
                        "description": "要插入的内容。空内容会报错。"
                    },
                    "position": {
                        "type": "string",
                        "enum": ["before", "start", "end"],
                        "description": "before=标题前；start=正文开头；end=正文末尾。默认 end。"
                    }
                }),
                &["id", "text"]
            )
        }),
        json!({
            "name": "kb_replace_in_note",
            "description": "把一段原文换成另一段（改错字/一句话）。\n\
                 🔴 **全文唯一命中**：0 或多处都报错且一个字不改。\
                 不唯一就把 find 加长，或改用 kb_update_section。LF/CRLF 自动对齐。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "笔记 id。"
                    },
                    "find": {
                        "type": "string",
                        "description": "被替掉的原文，照 kb_read 一字不改地拷。"
                    },
                    "replace": {
                        "type": "string",
                        "description": "换成什么。空串=删掉 find 那段。"
                    }
                },
                "required": ["id", "find", "replace"]
            }
        }),
        json!({
            "name": "kb_prepend",
            "description": "插到正文**最开头**，原文不动。与 kb_append 一对。\
                 frontmatter 之后插入。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "笔记 id。"
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
            "description": "把笔记移到另一文件夹。\n\
                 🔴 只搬**你自己写的**（`kb_list(author=\"me\")`）；用户写的不碰。\n\
                 可把未分类收进合适的夹。🔴 用户建的夹不要改名/解散/搬。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "笔记 id。" },
                    "folder": {
                        "type": "string",
                        "description": "目标文件夹名，见 kb_folders。省略=移回未分类。名不存在会失败。"
                    }
                },
                "required": ["id"]
            }
        }),
        json!({
            "name": "kb_tag",
            "description": "加/去标签，只动点名的。**只能用已存在的**，不自动新建。\n\
                 ⚠ kb_folders 列的是笔记在用的，不是完整可用名单；\
                 名字对不上别断定没有，问用户。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "笔记 id。" },
                    "add": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "要加的标签名。已有的忽略。"
                    },
                    "remove": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "要去的标签名。本来没有的忽略。"
                    }
                },
                "required": ["id"]
            }
        }),
        json!({
            "name": "kb_delete",
            "description": format!(
                "把笔记**删到回收站**。{}\n\
                 没有彻底删除的工具，那一步只能用户在界面上做。\n\
                 ⚠ 删前确认用户真要删这篇：拿不准先 kb_read 念标题开头。",
                trash_note(trash_days)
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
            "description": "从回收站恢复。id 从刚 delete 的回复或 kb_trash_list 拿\
                 （上次会话删的只能走 trash_list）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "笔记 id。" }
                },
                "required": ["id"]
            }
        }),
        json!({
            "name": "kb_revert",
            "description": "回滚到历史版本（先 kb_history 拿 rev）。回滚前会另存当前版。\n\
                 ⚠ 正文**整篇**换成旧版：之后用户写的内容会没。\
                 只取一段用 history 读 + kb_append。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "笔记 id。" },
                    "rev": { "type": "integer", "description": "版本号，从 kb_history 拿。" }
                },
                "required": ["id", "rev"]
            }
        }),
        json!({
            "name": "kb_summary",
            "description": "写一句摘要（进 search/list 结果）。写**解决了什么**，别复述标题。\
                 空串=清掉。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "笔记 id。" },
                    "text": { "type": "string", "description": "摘要，一两句。" }
                },
                "required": ["id", "text"]
            }
        }),
        json!({
            "name": "kb_folder_rename",
            "description": "给文件夹改名，笔记不动。\
                 🔴 只改**你自己建的**（［AI］）；用户建的别改。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "folder": {
                        "type": "string",
                        "description": "要改名的文件夹，见 kb_folders。"
                    },
                    "name": { "type": "string", "description": "新名字。同父不能重名。" }
                },
                "required": ["folder", "name"]
            }
        }),
        json!({
            "name": "kb_folder_dissolve",
            "description": "解散文件夹：笔记与子夹升到父级，**一篇不删**。\
                 收拾自己建多的空夹。\n\
                 🔴 只解散**你自己建的**，用户建的不碰。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "folder": {
                        "type": "string",
                        "description": "要解散的文件夹，见 kb_folders。"
                    }
                },
                "required": ["folder"]
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
    // 🔴 新篇落到哪儿要说出来。不说的话，模型无从向用户交代，
    // 而用户很可能正在某个文件夹里找一篇实际落在**未分类**的笔记。
    // 拿参数拼而不是反查 folder_id：创建能成功就说明这个名字已经解到了，
    // 再查一次是多一次 SQLite 全局锁（那把锁与主界面共用）。
    let landed = match folder.as_deref() {
        Some(f) => format!("\n已放进文件夹「{}」。", f),
        None => "\n没指定文件夹，这篇落在**未分类**里。要归类用 kb_move。".to_string(),
    };
    let src = source(&ctx);
    let kb = ctx.kb.clone();
    match blocking(move || kb.create(&title, &content, folder.as_deref(), &src)).await {
        Ok(n) => Ok(wrote_note(&n, "已新建笔记", Some(landed))),
        Err(e) => Ok(error_result(format!("新建失败：{}", e)).into()),
    }
}

/// 建一个文件夹（项目③）。
pub(super) async fn call_folder_create(
    ctx: CallCtx,
    args: Option<Value>,
) -> Result<ToolOutput, ToolError> {
    let a = args.as_ref();
    let Some(name) = arg_str(a, "name").map(str::to_string) else {
        return Err(ToolError::invalid_params("kb_folder_create 需要参数 name"));
    };
    let parent = arg_str(a, "parent").map(str::to_string);
    let kb = ctx.kb.clone();
    let where_ = match parent.as_deref() {
        Some(p) => format!("「{}」下面", p),
        None => "顶层".to_string(),
    };
    match blocking(move || kb.folder_create(&name, parent.as_deref())).await {
        Ok(created) => Ok(ToolOutput {
            value: json!({ "content": [{ "type": "text", "text": format!(
                "已在{}建好文件夹「{}」。\n\
                 它在设置里会被标成「由 AI 创建」（kb_folders 里显示为 ［AI］），\
                 用户可以一键撤销。\n\
                 接下来用 kb_create(folder=\"{}\") 或 kb_move 把笔记放进去。",
                where_, created, created
            ) }] }),
            // 没有笔记被读写，审计里不记 id。
            note_ids: vec![],
        }),
        Err(e) => Ok(error_result(format!("建文件夹失败：{}", e)).into()),
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

/// 回滚到某个历史版本。
///
/// 🔴 归属校验在 [`super::KbSource::revert`] 里，不在这里：
/// `rev` 是全库递增的整数，而范围判定看的是 `arguments.id`。
/// 两边不对时，一个别的笔记的 `rev` 就能改写白名单外那篇。
pub(super) async fn call_revert(
    ctx: CallCtx,
    args: Option<Value>,
) -> Result<ToolOutput, ToolError> {
    let a = args.as_ref();
    let Some(id) = arg_str(a, "id").map(str::to_string) else {
        return Err(ToolError::invalid_params("kb_revert 需要参数 id"));
    };
    let Some(rev) = arg_i64(a, "rev") else {
        return Err(ToolError::invalid_params(
            "kb_revert 需要参数 rev（整数，用 kb_history 拿）",
        ));
    };
    let src = source(&ctx);
    let kb = ctx.kb.clone();
    let id2 = id.clone();
    match blocking(move || kb.revert(&id2, rev, &src)).await {
        Ok(title) => Ok(ToolOutput {
            value: text_result(format!(
                "已把「{}」回滚到 rev={}。\n\
                 回滚前的内容已另存为一份历史（kb_history 能看到），所以这一步能退回去。\n\
                 🔴 请把回滚这件事告诉用户——他在那之后写的东西现在不在正文里了。\nid={}",
                title, rev, id
            )),
            note_ids: vec![id],
        }),
        Err(e) => Ok(error_result(format!("回滚失败：{}", e)).into()),
    }
}

/// 写（或清掉）一篇的摘要。
pub(super) async fn call_summary(
    ctx: CallCtx,
    args: Option<Value>,
) -> Result<ToolOutput, ToolError> {
    let a = args.as_ref();
    let Some(id) = arg_str(a, "id").map(str::to_string) else {
        return Err(ToolError::invalid_params("kb_summary 需要参数 id"));
    };
    // 🔴 用 `arg_str_allow_empty` 而不是 `arg_str`：后者把空串当没传，
    // 而空串在这里是一个**有意义的指令**（清掉摘要）。
    // 拿 `arg_str` 的后果是「清摘要」静默变成报参数缺失。
    let text = arg_str_allow_empty(a, "text").unwrap_or("").to_string();
    let val: Option<String> = if text.trim().is_empty() { None } else { Some(text) };
    let cleared = val.is_none();
    let kb = ctx.kb.clone();
    let id2 = id.clone();
    match blocking(move || kb.set_summary(&id2, val.as_deref())).await {
        Ok(()) => Ok(ToolOutput {
            value: text_result(if cleared {
                format!("已清掉这篇的摘要。\nid={}", id)
            } else {
                format!(
                    "已写好摘要。它会出现在 kb_search / kb_list 的结果里。\nid={}",
                    id
                )
            }),
            note_ids: vec![id],
        }),
        Err(e) => Ok(error_result(format!("写摘要失败：{}", e)).into()),
    }
}

/// 文件夹改名。
pub(super) async fn call_folder_rename(
    ctx: CallCtx,
    args: Option<Value>,
) -> Result<ToolOutput, ToolError> {
    let a = args.as_ref();
    let Some(folder) = arg_str(a, "folder").map(str::to_string) else {
        return Err(ToolError::invalid_params("kb_folder_rename 需要参数 folder"));
    };
    let Some(name) = arg_str(a, "name").map(str::to_string) else {
        return Err(ToolError::invalid_params("kb_folder_rename 需要参数 name"));
    };
    let old = folder.clone();
    let kb = ctx.kb.clone();
    match blocking(move || kb.folder_rename(&folder, &name)).await {
        Ok(newname) => Ok(ToolOutput {
            value: text_result(format!(
                "已把文件夹「{}」改名为「{}」。里面的笔记没动。",
                old, newname
            )),
            // 没有笔记被读写，审计里不记 id（同 `kb_folder_create`）。
            note_ids: vec![],
        }),
        Err(e) => Ok(error_result(format!("改名失败：{}", e)).into()),
    }
}

/// 解散一层文件夹。
pub(super) async fn call_folder_dissolve(
    ctx: CallCtx,
    args: Option<Value>,
) -> Result<ToolOutput, ToolError> {
    let a = args.as_ref();
    let Some(folder) = arg_str(a, "folder").map(str::to_string) else {
        return Err(ToolError::invalid_params("kb_folder_dissolve 需要参数 folder"));
    };
    let shown = folder.clone();
    let kb = ctx.kb.clone();
    match blocking(move || kb.folder_dissolve(&folder)).await {
        Ok((notes, subs)) => Ok(ToolOutput {
            value: text_result(format!(
                "已解散文件夹「{}」：{} 篇笔记与 {} 个子文件夹上提到了它的父级，\
                 笔记一篇没删。",
                shown, notes, subs
            )),
            note_ids: vec![],
        }),
        Err(e) => Ok(error_result(format!("解散失败：{}", e)).into()),
    }
}
