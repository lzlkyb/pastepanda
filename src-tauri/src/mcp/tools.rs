//! 三个只读工具的定义与分发。
//!
//! 工具描述就是给模型看的 API 文档，写得准不准直接决定它会不会用错。
//! 尤其是 `kb_search` 的取词口径（见下）—— 那是个真存在的限制，
//! 不写进描述模型就会拿单字关键词去搜，拿到零命中后以为「库里没这个」。

use serde_json::{json, Value};

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

/// `tools/list` 的内容。
///
/// 手写三件套（`definitions()` 里一块 json! + `call()` 里一个 match 臂）。
/// 3 个工具时这完全可控；加到 6 个以上再上注册表 + derive 宏（参 cc-bridge 的 RFC）。
pub fn definitions() -> Vec<Value> {
    vec![
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
                        "description": "文件夹名。省略 = 不按文件夹筛。"
                    },
                    "tag": {
                        "type": "string",
                        "description": "标签名。省略 = 不按标签筛。标签不存在时会明确告知，\
                                          **不会**退化成「返回全库第一页」。"
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

/// 已注册的工具名。`call` 与 `definitions` 各写一份，靠测试钉住两边一致。
const TOOL_NAMES: &[&str] = &["kb_search", "kb_read", "kb_list"];

/// 分发 `tools/call`。
pub async fn call(params: Option<&Value>) -> Result<Value, ToolError> {
    let Some(params) = params else {
        return Err(ToolError::invalid_params("tools/call 缺少 params"));
    };
    let Some(name) = params.get("name").and_then(|v| v.as_str()) else {
        return Err(ToolError::invalid_params("tools/call 缺少 name"));
    };

    if !TOOL_NAMES.contains(&name) {
        return Err(ToolError::invalid_params(format!(
            "未知工具：{}（可用：{}）",
            name,
            TOOL_NAMES.join(", ")
        )));
    }

    // ===== M4 步骤 2：协议壳 =====
    // 工具实现在步骤 3 接入。现在返一个**能看出是占位**的执行失败：
    // 这样冒烟测试能把「协议通了」与「查询通了」分开验——客户端能列出工具并
    // 拿到这句话，就说明握手/鉴权/分发全部正常，剩下的只是查询。
    Ok(error_result(format!(
        "{} 尚未实现（MCP 服务当前只到协议壳阶段）。协议握手与鉴权已走通。",
        name
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_definitions_and_dispatch_agree() {
        // 手写三件套的唯一真风险：声明了却没接（模型调了报未知工具），
        // 或接了却没声明（模型永远不知道它存在）。这条测试就是护栏。
        let declared: Vec<String> = definitions()
            .iter()
            .filter_map(|t| t["name"].as_str().map(|s| s.to_string()))
            .collect();
        let mut dispatched: Vec<String> = TOOL_NAMES.iter().map(|s| s.to_string()).collect();
        let mut declared_sorted = declared.clone();
        declared_sorted.sort();
        dispatched.sort();
        assert_eq!(declared_sorted, dispatched);
        assert_eq!(
            declared.len(),
            3,
            "工具数量变了就要重读一遍本模块头部的取舍说明"
        );
    }

    #[test]
    fn test_every_tool_has_a_usable_schema() {
        for t in definitions() {
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
        let search = definitions()
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
