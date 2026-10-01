//! MCP **resources** 原语（方案 ②，2026-10-01）。
//!
//! # 为什么补这一维，而不是多加几个工具
//!
//! `pulse.rs:5-11` 记着一个实测事实：读 14 天审计表，真实客户端**只有两次会话
//! 开局**来过（`kb_folders` + `kb_list`），此后整场不碰。结论当时就写准了——
//! 「判据没问题，是触发断了」。
//!
//! `tools` 这一维的先天限制正是如此：**它要求模型自己想到来查**。而 resources 是
//! **用户/宿主主动把内容挂进上下文**（在 Claude / Cursor / VS Code 里 `@` 一篇笔记），
//! 零调用、零推理，不依赖投递率，也不依赖 `instructions` 有没有被读到。
//!
//! # 与 `kb_read` 的关系：同一张脸，不是第二套门
//!
//! 🔴 可读面**必须与 `kb_read` 完全一致**——不能更宽（等于绕开我们已经在管的范围），
//! 也不能更窄（会造出第二条「列表里看得见、点开读不到」的困惑通路，那是
//! 规则 #11.1 定义的失败）。所以这里只调 [`KbSource`] 的同一批方法，
//! 正文也复用 [`super::tools::wrap_content`] 那一份包裹（规则 #11），
//! 不在这里重写第二遍 nonce 逻辑。
//!
//! # ⚠ 未核实项（实施时按「先实现、真机点验后再定」处理）
//!
//! URI scheme 用 `pastepanda://note/{id}`。各家宿主对**非 `file://` scheme** 的支持度
//! 不一（有的只列 `file`/`http`），**必须拿真客户端验证后再定**；
//! 没验证之前不许在文案里宣称「任何客户端都能 @」。改 scheme 只需动
//! [`SCHEME`]/[`NOTE_HOST`] 两个常量，形状由 [`note_uri`] 单点产出。
//!
//! # 新增的风险面要说清（不是现有风险）
//!
//! 正文今天已经能被 `kb_read` 读走，所以**泄露面没有变大**；但 `@` 一个 resource
//! 会让**整篇正文进云端模型的上下文**，而且是一次一批地进。设置页的文案要写这一句
//! （对齐红线②那套「不出本机 / 用户可见可删」的克制风格）。

use serde_json::{json, Value};

use super::source::{KbSource, ListOutcome};
use super::tools::{self, ToolError};
use crate::data_store::Note;

/// URI 的 scheme。⚠ 见文件头「未核实项」。
pub const SCHEME: &str = "pastepanda";

/// 单篇笔记在 scheme 下面的固定段：`pastepanda://note/{id}`。
pub const NOTE_HOST: &str = "note";

/// 正文的 MIME。库里存的就是 Markdown（`Note::content` 的注释：`[[..]]` 原样保存）。
pub const MIME: &str = "text/markdown";

/// `resources/list` 一页多少条。
///
/// 取 **20**，与 `kb_list` 的默认页同口径（`tools/mod.rs` 里 `arg_u32(args,"limit",20,1,50)`
/// 的那个 20）。规则 #11 要的是「同一个数字只在一处写死」，但这两处**语义不同**
/// （一个是模型能改的参数默认值，一个是宿主选择器的固定页大小），所以不强行合并——
/// 改的时候两边都要看一眼，别只动一处。
///
/// ❗ 它同时是「用户点开 `@` 选择器那一瞬间」的开销，不能照着「反正能翻页」往上加。
const PAGE: u32 = 20;

/// 一篇笔记的 resource URI。**唯一出口**（规则 #11.1）：
/// 列出来与读进去必须拼出同一个串，否则「列表里点得到、读回来 404」。
pub fn note_uri(id: &str) -> String {
    format!("{}://{}/{}", SCHEME, NOTE_HOST, id)
}

/// 从 URI 里取笔记 id。不是我们的 scheme / 段不对 / id 为空都返 `None`。
///
/// 🔴 **纯函数**，不碰任何环境——按规则 #11.1 把可测的那一半单独抽出来钉住。
/// 不能用 `starts_with` 判 scheme：`pastepanda-evil://note/x` 会过。
pub fn parse_note_uri(uri: &str) -> Option<&str> {
    let rest = uri.strip_prefix(&format!("{}://", SCHEME))?;
    let (host, id) = rest.split_once('/')?;
    if host != NOTE_HOST || id.is_empty() {
        return None;
    }
    // id 是 UUID（`hex` + `-`）。不收 `/`、`?`、`#`：URI 里出现这些说明串被拼坏了，
    // 拼坏还去查库会把一个结构问题变成一次「查无此篇」，错误信息更没用。
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    Some(id)
}

/// 游标就是偏移量的十进制串。
///
/// **故意不做「不透明游标 + 快照」**：本服务的读路径每次都现查 SQLite（与
/// `kb_list` 同口径），一个稳定快照要付的是内存和「用户新写的笔记迟迟不出现在
/// `@` 列表里」——后者比游标可能重复一条严重得多。
fn cursor_offset(cursor: Option<&str>) -> u32 {
    cursor
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0)
}

/// `resources/list`。
///
/// 只列**活笔记**（`list()` 本身不含回收站，见 `source.rs`），排序沿用数据层的
/// `updated_at DESC`——宿主里的 `@` 选择器按「最近在动的优先」排是符合直觉的，
/// 而这里没有第二个排序可发明。
///
/// 🔴 返回 `(应答体, 本次列出的笔记 id)`。id 由这里**交出来**而不是让调用方
/// 从 uri 反解：列出的就是那几篇，反解等于把「我给了你什么」这件事
/// 交给一个字符串解析函数去重新发现（规则 #11.1 说的正是这种绕路）。
///
/// 🔴 读失败返回 `Err` 而不是「一个空列表 + 多带一个 error 字段」：
/// 空列表在宿主里长成「这个知识库里没有东西」，那是一个**错答案**，
/// 而且它同时还是一个不符合规范的 result 体（规则 #15.3）。
pub async fn list(
    kb: &std::sync::Arc<dyn KbSource>,
    params: Option<&Value>,
) -> Result<(Value, Vec<String>), ToolError> {
    let cursor = params
        .and_then(|p| p.get("cursor"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let offset = cursor_offset(cursor.as_deref());

    // 多取一条：用它在「正好一页」和「真的一页到底」之间做出判断，
    // 而不是凭 `PAGE` 就宣称还有下一页。
    let kb2 = kb.clone();
    let outcome = tokio::task::spawn_blocking(move || kb2.list(None, None, None, "", PAGE + 1, offset))
        .await
        .map_err(|e| ToolError::internal(format!("读笔记列表任务失败：{}", e)))?
        .map_err(|e| ToolError::internal(format!("读笔记列表失败：{}", e)))?;

    let notes = match outcome {
        ListOutcome::Ok(v) => v,
        // 这里三个 `folder`/`tag`/`author` 全传 `None`，理论上到不了这几个分支；
        // 真到了就是数据层加了新形态，**当错误报出来**而不是当作空列表放行。
        other => {
            let why = match other {
                ListOutcome::UnknownFolder(f) => format!("未知文件夹：{}", f),
                ListOutcome::UnknownTag(t) => format!("未知标签：{}", t),
                ListOutcome::UnknownAuthor { asked, .. } => format!("未知作者：{}", asked),
                ListOutcome::Ok(_) => {
                    return Err(ToolError::internal("内部错误：Ok 分支不该走到这里"))
                }
            };
            return Err(ToolError::internal(why));
        }
    };

    let page: Vec<_> = notes.iter().take(PAGE as usize).collect();
    let has_more = notes.len() > PAGE as usize;

    let mut body = json!({
        "resources": page.iter().map(|n| json!({
            "uri": note_uri(&n.id),
            "name": n.id,          // 稳定标识；重名笔记的 name 会撞，uri 不会
            "title": n.title,      // 给人看的那一个
            "description": format!("更新于 {}", n.updated_at),
            "mimeType": MIME,
        })).collect::<Vec<_>>()
    });
    // 🔴 到底了就**不写这个键**，而不是写 `null`：规范里 `nextCursor` 是 optional，
    // 而严格的客户端校验是「字符串或没有」——`null` 会让它们直接报错。
    // 恰好一页时宁可多要一次空页，也不谎报「到底了」。
    if has_more {
        body["nextCursor"] = json!((offset + PAGE).to_string());
    }

    Ok((
        body,
        page.iter().map(|n| n.id.clone()).collect(),
    ))
}

/// `resources/read`。
///
/// 返回 [`ToolError`] 由调用方转成 JSON-RPC 错误——与 `tools/call` 那条路不同
/// （那里工具失败走 `isError`，因为「工具没干成」是给模型看的信息；
/// 而这里「URI 不对」是给**宿主**看的协议错误，模型根本碰不到）。
/// 错误码不自己发明：参数问题 `invalid_params`、数据层问题 `internal`，
/// 与工具那边同一套分类（规则 #11）。
pub async fn read(
    kb: &std::sync::Arc<dyn KbSource>,
    params: Option<&Value>,
) -> Result<Value, ToolError> {
    let uri = params
        .and_then(|p| p.get("uri"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| ToolError::invalid_params("resources/read 缺少 uri 参数"))?;

    let id = parse_note_uri(uri).ok_or_else(|| {
        ToolError::invalid_params(format!(
            "无法识别的 resource uri：{}（本服务只提供 {}:///{}/<笔记 id>）",
            uri, SCHEME, NOTE_HOST
        ))
    })?;

    let kb2 = kb.clone();
    let id2 = id.to_string();
    // 🔴 取正文与取文件夹名**在同一次 spawn_blocking 里**（R2：这两个调用都要拿
    // SQLite 的 `std::sync::Mutex`，在 async 上下文里直接调会把阻塞带上运行时线程）。
    // 分开两次拿锁还会让「正文」与「它当时在哪个夹子」之间隔一次调度。
    let found = tokio::task::spawn_blocking(move || {
        let n = kb2.read(&id2)?;
        Ok::<Option<(Note, Option<String>)>, String>(n.map(|n| {
            let folder = n
                .folder_id
                .as_deref()
                .and_then(|f| kb2.folder_name(f));
            (n, folder)
        }))
    })
    .await
    .map_err(|e| ToolError::internal(format!("读笔记任务失败：{}", e)))?
    .map_err(|e| ToolError::internal(format!("读笔记失败：{}", e)))?;

    let Some((n, folder)) = found else {
        // 列表里刚出现过、这里就没了，只可能是用户在宿主翻开的这段时间里删了。
        // 不说「已被删除」而说「没有这一篇」：前者的猜测没有依据（也可能从来就没建过）。
        return Err(ToolError::invalid_params(format!("没有这篇笔记：{}", id)));
    };
    let folder = folder.unwrap_or_else(|| "未分类".to_string());

    // 🔴 正文过同一份 nonce 包裹（方案文档的硬约束之一）。
    // 漏了这里等于绕开 O-1 已解决的问题：库里大量正文来自剪贴板，
    // 定界符固定就能被内容自己提前闭合、后面接指令。
    let body = format!(
        "【{}】\nid={}\n文件夹：{}\n最近更新：{}\n",
        tools::title_of(&n),
        n.id,
        folder,
        n.updated_at
    ) + &tools::wrap_content(&n.id, None, &n.content);

    Ok(json!({
        "contents": [{
            "uri": uri,
            "mimeType": MIME,
            "text": body,
        }]
    }))
}

/// `resources/templates/list`。
///
/// 只给一条：宿主靠它知道「这个服务能挂什么形状的东西」。文件夹不做模板——
/// 文件夹是**范围**不是**内容**，拿它当 resource 会变成「@ 一个文件夹 = 读全文若干篇」，
/// 那是一次无法预算的上下文开销。范围浏览走 `kb_folders` + `kb_list`。
pub fn templates() -> Value {
    json!({
        "resourceTemplates": [{
            "uriTemplate": format!("{}://{}/{{id}}", SCHEME, NOTE_HOST),
            "name": "PastePanda 笔记",
            "mimeType": MIME,
            "description": "按 id 取一篇笔记的 Markdown 正文（只读；写入请用 kb_* 工具）",
        }]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_uri_round_trips() {
        let id = "6f1c7e6e-6f6f-4a2b-9e3a-0d1c2b3a4f5e";
        assert_eq!(parse_note_uri(&note_uri(id)), Some(id));
    }

    #[test]
    fn test_parse_rejects_lookalikes() {
        // 🔴 不能用 starts_with 判 scheme：这几条都得挂。
        for bad in [
            "pastepandaevil://note/abc",
            "pastepanda://folder/abc",
            "pastepanda://note/",
            "pastepanda://note",
            "pastepanda:/note/abc",
            "http://127.0.0.1:17650/mcp",
            "pastepanda://note/../../etc/passwd",
            "pastepanda://note/abc?x=1",
            "pastepanda://note/abc#frag",
            "",
        ] {
            assert_eq!(parse_note_uri(bad), None, "不该认账：{}", bad);
        }
    }

    #[test]
    fn test_cursor_offset_falls_back_to_zero() {
        for c in [None, Some(""), Some("   "), Some("x"), Some("-1")] {
            assert_eq!(cursor_offset(c), 0, "{:?} 应当退回 0", c);
        }
        assert_eq!(cursor_offset(Some("50")), 50);
    }
}
