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
            "description": "要动的那一节，按**标题路径**定位（如「架构 / 数据流」，\
                              也可只写尾段「数据流」）。"
        },
        "index": {
            "type": "integer",
            "minimum": 0,
            "description": "要动的那一节，按 kb_sections 给的**序号**定位。\
                              0 = 第一个标题之前的引言部分。"
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
pub fn definitions(trash_days: i64) -> Vec<Value> {
    vec![
        json!({
            "name": "kb_create",
            "description": "在用户的知识库里新建一篇笔记。\n\
                 先用 kb_search 确认一下同一主题是不是已经有了——如果有，\
                 用 kb_append 追到那篇里比另开一篇更有用。",
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
            "name": "kb_folder_create",
            "description": "新建一个文件夹。\n\
                 先用 kb_folders 看一眼：很可能已经有一个意思相近的了，\
                 那就直接用现有的，不要另建一个。\n\
                 ⚠ 文件夹结构是用户自己的组织方式，**不要主动帮他重排**；\
                 只在他明确要求、或你真的需要一个地方放新笔记时才建。\n\
                 🔴 建好的夹子会被标成「由 AI 创建」，用户能在设置里一键撤销\
                 （撤销 = 删掉它，里面的笔记与子夹都升到父级，不会丢）。\n\
                 同一个父级下不能重名；层数有上限，超了会直接失败。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "文件夹名。必填。" },
                    "parent": {
                        "type": "string",
                        "description": "建在哪个文件夹下（名字，用 kb_folders 查）。\
                                          省略 = 建在顶层。**不存在的名字会直接失败**。"
                    }
                },
                "required": ["name"]
            }
        }),
        json!({
            "name": "kb_append",
            "description": "往一篇已有笔记的**末尾追加**一段内容，原有内容不动。\n\
                 只是“再添一条”时请**优先用它而不是 kb_update**：\
                 kb_update 是整篇覆盖，很容易把用户原有的内容写丢。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "笔记 id。" },
                    "text": { "type": "string", "description": "要追加的内容。会隔一个空行接在末尾。" }
                },
                "required": ["id", "text"]
            }
        }),
        json!({
            "name": "kb_update",
            "description": "改一篇笔记的标题和/或正文。\n\
                 ⚠ **content 是整篇覆盖**，不是局部修改。只想添内容就用 kb_append；\
                 真要重写整篇时，请**先 kb_read 拿到当前全文**，在它基础上改，\
                 不要凭记忆或凭摘要重建——那会把用户写的细节概括掉。\n\
                 只传 title 就只改标题，只传 content 就只改正文。",
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
            "description": "**只重写某一节的正文**，标题行不动、其它节不动。\n\
                 先用 kb_sections 看大纲拿到序号或标题路径，再用它改。\n\
                 🔴 比 kb_update 安全得多：kb_update 是你拿着几十秒前读到的全文整篇覆盖，\
                 期间用户在界面上改的东西会被抹掉；这里只碰你点名的那一节。\n\
                 🔴 节是**平的**：改 `## A` 不会动它下面的 `### A1`。\
                 返回里会告知有几个子节没被动。\n\
                 🔴 body 传空字符串 = **清空这一节的正文**（标题保留）。\
                 不想改就别调，不要用空串试探。",
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
            "description": "在某一节的指定位置**插入**一段，原有内容一字不动。\n\
                 想在某节前面新开一节就用 position=before，\
                 想往某节末尾补一段就用 position=end。",
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
            "description": "把笔记里的一段原文换成另一段。适合改错别字、改一句话这种局部修正。\n\
                 🔴 **要求全文唯一命中**。命中 0 处或多处都会报错，且**一个字也不改**：\
                 若默认全换，你想改第一处却改了七处；\
                 若默认只换第一处，你以为改完了实际还剩六处。两种默认都是你看不出来的错。\n\
                 命中多处时把 find 向前后加长到唯一，或改用 kb_update_section。\n\
                 行尾无需操心：LF 与 CRLF 会自动对齐。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "笔记 id。"
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
            "description": "把一段内容插到笔记正文的**最开头**，原有内容不动。\
                 与 kb_append（插到末尾）互为一对，归同一个「追加内容」开关。\n\
                 带 frontmatter 的笔记会插在 frontmatter 之后，不会撑坏它。",
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
            "description": "把一篇笔记移到另一个文件夹。\n\
                 文件夹结构是用户自己的组织方式，**不要主动帮他重排**；\
                 除非用户明确要求，否则不要调它。",
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
            "description": "给一篇笔记加或去标签。只动点名的那几个，其它标签不受影响。\n\
                 标签体系是用户自己的，**只能用已存在的标签**，不会自动新建。\n\
                 ⚠ kb_folders 列的是**笔记在用的**标签，那不是「能用哪些」的完整名单\
                 （库里可能还有只被剪贴板条目用过的标签，那些也能直接用）。\
                 所以名字对不上时**不要断定「库里没有」**，让用户确认写法。",
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
                "把一篇笔记**删到回收站**。{}\n\
                 没有彻底删除的工具，也不要去找——那一步只能用户自己在界面上做。\n\
                 ⚠ **删之前先确认用户真的要删这一篇**：拿不准就先 kb_read 把标题与\
                 开头念给用户听，而不是根据标题像不像自己判。",
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
            "description": "把一篇在回收站里的笔记拿回来。删错了用它自己改回来。\n\
                 回收站里的笔记**不会**出现在 kb_search / kb_list 的结果里：\
                 id 从你刚才 kb_delete 的回复里拿，\
                 或者用 kb_trash_list 列出回收站来找（上一次会话删的只能走这条路）。",
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
            "description": "把一篇笔记回滚到它的某个历史版本。先用 kb_history 拿版本号。\n\
                 回滚**前**的内容会先另存一份历史，所以回错了能再回来。\n\
                 ⚠ 正文会被**整篇**换成旧的那一版：用户在那之后写的东西全部不在了。\
                 只想拿回其中一段就用 kb_history 读那一版，再用 kb_append 把那段接回去。",
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
            "description": "给一篇笔记写一句摘要。\n\
                 它会出现在 kb_search / kb_list 的结果里，所以写得好能让以后的检索便宜很多：\
                 写**这篇解决了什么**，不要复述标题。\n\
                 text 传空串 = 清掉摘要。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "笔记 id。" },
                    "text": { "type": "string", "description": "摘要。一两句就好。" }
                },
                "required": ["id", "text"]
            }
        }),
        json!({
            "name": "kb_folder_rename",
            "description": "给一个文件夹改名。里面的笔记不动。\n\
                 ⚠ 文件夹结构是用户自己的组织方式，**不要主动帮他重排**；\
                 只在他明确要求时才改。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "folder": {
                        "type": "string",
                        "description": "要改名的文件夹（名字，用 kb_folders 查）。"
                    },
                    "name": { "type": "string", "description": "新名字。同一父级下不能重名。" }
                },
                "required": ["folder", "name"]
            }
        }),
        json!({
            "name": "kb_folder_dissolve",
            "description": "解散一个文件夹：里面的笔记与子文件夹全部上提到它的父级，再删这一层。\n\
                 **笔记一篇不删**。用它收拾建多了的空夹子或多余的层级。\n\
                 ⚠ 同 kb_folder_rename：别主动重排用户的目录。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "folder": {
                        "type": "string",
                        "description": "要解散的文件夹（名字，用 kb_folders 查）。"
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
                 它在设置里会被标成「由 AI 创建」，用户可以一键撤销。\n\
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
