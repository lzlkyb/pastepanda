//! 七个写工具（M5）。
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
fn wrote(note: &Note, what: &str) -> ToolOutput {
    ToolOutput {
        value: text_result(format!("{}：「{}」\nid={}", what, title_of(note), note.id)),
        note_ids: vec![note.id.clone()],
    }
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

/// 七个写工具的定义。**本函数不做开关过滤**，过滤在 [`super::definitions`]。
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
        Ok(n) => Ok(wrote(&n, "已修改笔记")),
        Err(e) => Ok(error_result(format!("修改失败：{}", e)).into()),
    }
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
