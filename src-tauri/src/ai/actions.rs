//! 云端 AI 动作定义与 prompt 构造。
//!
//! 动作是**写死的**（不做成用户可编辑的 prompt 库）：剩下那些需求用户直接去
//! 对话类工具里做更顺手，剪贴板里只留高频且能一步到位的。
//!
//! 系统提示词的重点是 **只输出结果本身**。模型默认爱加“好的，以下是翻译：”
//! 这类前言，而这里的产物是要直接写回剪贴板的，多一句就是脏数据。

use serde::Serialize;
use std::collections::HashMap;

/// 单次处理的输入上限（字符）。
///
/// 超限**直接拒绝而不是静默截断**：截断会悄无声息地改变语义（翻译掉一半、
/// 摘要漏掉后半段），而用户看不出来。宁可让他自己选一段。
pub const MAX_INPUT_CHARS: usize = 8000;

/// 自定义模板的长度上限（字符）。
///
/// 与 [`MAX_INPUT_CHARS`] 分开算：后者管的是**内容**，而模板是另一截。
/// 两者相加不超 10000，对所有厂商都在安全范围内。
pub const MAX_TEMPLATE_CHARS: usize = 2000;

/// 自定义模板里的内容占位符。中英文都认，界面上只教中文那个。
pub const CONTENT_PLACEHOLDERS: &[&str] = &["{{内容}}", "{{content}}"];

/// 编辑器里可选的“适用内容类型”。
///
/// 不是 `content_type_from_labels` 的全集：邮箱/电话/颜色/数字这类对 AI 动作没意义，
/// **密钥（secret）更是故意不给选**——不应该存在一个专门在密钥上冒出来的云端动作。
pub const SELECTABLE_CONTENT_TYPES: &[(&str, &str)] = &[
    ("text", "纯文本"),
    ("code", "代码"),
    ("json", "JSON"),
    ("markdown", "Markdown"),
    ("html", "HTML"),
    ("csv", "表格"),
    ("config", "配置"),
    ("log", "日志"),
    ("shell", "命令行"),
    ("link", "链接"),
];

/// 内容类型的中文说法，用于喂给模型。认不出来就返回 None（不注入）。
fn content_type_label(ct: &str) -> Option<&'static str> {
    SELECTABLE_CONTENT_TYPES
        .iter()
        .find(|(id, _)| *id == ct)
        .map(|(_, label)| *label)
}

/// 所有动作共用的系统提示词。
const SYSTEM_PROMPT: &str = "你是一个文本处理工具。只输出处理结果本身，不要任何解释、前言、结语，也不要用 Markdown 代码块包裹。";

/// 拼出系统提示词。
///
/// **内容类型放系统提示词而不是用户消息**：它是关于输入的元信息，不是指令，
/// 掺进用户消息里会和自定义模板的结构打架。
///
/// **只发类型，不发来源应用名**——后者会泄露“你在用什么软件”，收益远不抵代价。
fn system_prompt(content_type: Option<&str>) -> String {
    match content_type.and_then(content_type_label) {
        Some(label) => format!("{}\n用户给的内容类型是：{}。", SYSTEM_PROMPT, label),
        None => SYSTEM_PROMPT.to_string(),
    }
}

/// 模板里是否带内容占位符。
pub fn template_has_placeholder(template: &str) -> bool {
    CONTENT_PLACEHOLDERS.iter().any(|p| template.contains(p))
}

/// 校验自定义模板。保存时和调用时都走它，不要各写一份。
///
/// **为什么占位符是必需而不是“缺了就拼在末尾”**：自动拼末尾的话，
/// “只输出结果本身”这类收尾约束就会被内容挤到前面，模型很容易照旧带前言。
/// 强制占位符是为了把“夹心结构”变成默认。
pub fn validate_template(template: &str) -> Result<(), String> {
    let t = template.trim();
    if t.is_empty() {
        return Err("模板不能为空".to_string());
    }
    if t.chars().count() > MAX_TEMPLATE_CHARS {
        return Err(format!("模板过长（上限 {} 字符）", MAX_TEMPLATE_CHARS));
    }
    if !template_has_placeholder(t) {
        return Err(format!(
            "模板里必须包含 {}，否则模型不知道要处理什么",
            CONTENT_PLACEHOLDERS[0]
        ));
    }
    Ok(())
}

/// 把内容填进模板。多个占位符都会被替换。
fn render_template(template: &str, text: &str) -> String {
    let mut out = template.to_string();
    for p in CONTENT_PLACEHOLDERS {
        out = out.replace(p, text);
    }
    out
}

/// 用自定义模板造 prompt。
///
/// 与 [`build_prompt`] 一样是**纯函数**：模板由命令层从库里查好传进来。
/// 不要为了查表把 `DataStore` 传进这个模块——它现在的一整套单测都建立在无状态上。
pub fn build_custom_prompt(
    template: &str,
    text: &str,
    max_tokens: u32,
    content_type: Option<&str>,
) -> Result<(String, String, u32), String> {
    validate_template(template)?;
    let trimmed = check_input(text)?;
    Ok((
        system_prompt(content_type),
        render_template(template.trim(), trimmed),
        max_tokens,
    ))
}

/// 内容的长度与非空校验。内置与自定义共用。
fn check_input(text: &str) -> Result<&str, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("内容为空，无需处理".to_string());
    }
    let char_count = trimmed.chars().count();
    if char_count > MAX_INPUT_CHARS {
        return Err(format!(
            "内容过长（{} 字符，上限 {}），请先截取需要处理的部分",
            char_count, MAX_INPUT_CHARS
        ));
    }
    Ok(trimmed)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionOptionValue {
    pub value: &'static str,
    pub label: &'static str,
}

/// 选项规格，供前端自动生成 chip（与变换注册表的 `TransformOptionSpec` 同构）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionOptionSpec {
    pub key: &'static str,
    pub label: &'static str,
    pub values: &'static [ActionOptionValue],
    pub default: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAction {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    /// 图标语义键，由 UI 层映射为具体组件（与变换注册表的约定一致）。
    pub icon: &'static str,
    /// 输出上限。摘要给得小，翻译/改写要能容下全文。
    pub max_tokens: u32,
    pub options: &'static [ActionOptionSpec],
    /// 适用的内容类型；空 = 不限。前端据此决定要不要把它摆出来。
    ///
    /// 原有四个动作的打分在前端有手调过的细规则（如摘要要求 200 字以上），
    /// 这个字段是给**新增动作与自定义动作**用的通用规则。
    pub content_types: &'static [&'static str],
}

const LANG_VALUES: &[ActionOptionValue] = &[
    ActionOptionValue { value: "zh", label: "中文" },
    ActionOptionValue { value: "en", label: "英文" },
    ActionOptionValue { value: "ja", label: "日文" },
    ActionOptionValue { value: "ko", label: "韩文" },
];

const TONE_VALUES: &[ActionOptionValue] = &[
    ActionOptionValue { value: "concise", label: "简洁" },
    ActionOptionValue { value: "formal", label: "正式" },
    ActionOptionValue { value: "casual", label: "口语" },
];

const TRANSLATE_OPTS: &[ActionOptionSpec] = &[ActionOptionSpec {
    key: "lang",
    label: "目标语言",
    values: LANG_VALUES,
    default: "zh",
}];

const REWRITE_OPTS: &[ActionOptionSpec] = &[ActionOptionSpec {
    key: "tone",
    label: "语气",
    values: TONE_VALUES,
    default: "concise",
}];

/// 回复草稿的态度。比语气更关键——同一封邮件答应还是拒绝，写法完全不同。
const REPLY_STANCE_VALUES: &[ActionOptionValue] = &[
    ActionOptionValue { value: "accept", label: "答应" },
    ActionOptionValue { value: "decline", label: "委婉拒绝" },
    ActionOptionValue { value: "ask", label: "追问细节" },
];

const REPLY_OPTS: &[ActionOptionSpec] = &[ActionOptionSpec {
    key: "stance",
    label: "态度",
    values: REPLY_STANCE_VALUES,
    default: "accept",
}];

pub const ACTIONS: &[AiAction] = &[
    AiAction {
        id: "ai-translate",
        label: "翻译",
        description: "把内容翻译成指定语言",
        icon: "languages",
        max_tokens: 2000,
        options: TRANSLATE_OPTS,
        content_types: &[],
    },
    AiAction {
        id: "ai-summarize",
        label: "一句话摘要",
        description: "把长内容压成一句话",
        icon: "file-text",
        // 上限 ≠ 预分配：抬到 1024 不给不带思考的模型增加成本（它们实际只输出几十 token），
        // 但给带思考的推理模型留出「思考 + 答案」的空间（思考本身就要几百 token）
        max_tokens: 1024,
        options: &[],
        content_types: &[],
    },
    AiAction {
        id: "ai-explain-code",
        label: "解释代码",
        description: "说清楚这段代码做了什么",
        icon: "code",
        max_tokens: 1024,
        options: &[],
        content_types: &["code", "shell"],
    },
    AiAction {
        id: "ai-rewrite",
        label: "改写语气",
        description: "换一种语气重写这段内容",
        icon: "pen-line",
        max_tokens: 2000,
        options: REWRITE_OPTS,
        content_types: &[],
    },
    // ===== 以下为扩容新增。挑选标准：高频 + 一步到位 + 产物直接可用。
    // 需要多轮对话才能完成的（如“帮我调试这段代码”）不收——那是对话工具的活。
    AiAction {
        id: "ai-polish",
        label: "润色纠错",
        description: "修掉错别字与语病，保持原意",
        icon: "wand-sparkles",
        max_tokens: 2000,
        options: &[],
        content_types: &["text", "markdown"],
    },
    AiAction {
        id: "ai-key-points",
        label: "提取要点",
        description: "把长段落拆成条目列表",
        icon: "list",
        max_tokens: 1024,
        options: &[],
        content_types: &["text", "markdown", "log"],
    },
    AiAction {
        id: "ai-commit-message",
        label: "写 commit message",
        description: "根据 diff 写一条提交信息",
        icon: "git-commit-horizontal",
        max_tokens: 1024,
        options: &[],
        content_types: &["code"],
    },
    AiAction {
        id: "ai-json-to-type",
        label: "JSON → 类型定义",
        description: "生成 TypeScript interface",
        icon: "braces",
        max_tokens: 1500,
        options: &[],
        content_types: &["json"],
    },
    AiAction {
        id: "ai-tabulate",
        label: "表格化",
        description: "把杂乱文本整理成 Markdown 表格",
        icon: "table",
        max_tokens: 2000,
        options: &[],
        content_types: &["text", "csv", "log"],
    },
    AiAction {
        id: "ai-reply-draft",
        label: "回复草稿",
        description: "对收到的消息写一段可直接发的回复",
        icon: "reply",
        max_tokens: 1200,
        options: REPLY_OPTS,
        content_types: &["text"],
    },
    // v6.4 六大王牌：C 合并粘贴的 AI 增强 + E 剪贴板周报
    AiAction {
        id: "ai-merge-polish",
        label: "合并整理",
        description: "合并多段内容：去重、顺排、润色",
        icon: "merge",
        max_tokens: 2000,
        options: &[],
        content_types: &[],
    },
    AiAction {
        id: "ai-weekly-report",
        label: "生成周报",
        description: "把本周行为统计翻译成周报文字",
        icon: "calendar-range",
        max_tokens: 1500,
        options: &[],
        content_types: &[],
    },
];

pub fn find_action(id: &str) -> Option<&'static AiAction> {
    ACTIONS.iter().find(|a| a.id == id)
}

/// 从 opts 取值；缺失或不在允许集里时回退到默认值。
///
/// 不报错是故意的：前端传个离谱值不应该让用户看到报错，按默认跑就行。
fn opt_or_default(
    spec: &ActionOptionSpec,
    opts: &HashMap<String, String>,
) -> &'static str {
    match opts.get(spec.key) {
        Some(v) => spec
            .values
            .iter()
            .find(|x| x.value == v.as_str())
            .map(|x| x.value)
            .unwrap_or(spec.default),
        None => spec.default,
    }
}

fn lang_name(code: &str) -> &'static str {
    match code {
        "en" => "英文",
        "ja" => "日文",
        "ko" => "韩文",
        _ => "中文",
    }
}

fn tone_name(code: &str) -> &'static str {
    match code {
        "formal" => "正式、书面",
        "casual" => "轻松口语化",
        _ => "简洁直白",
    }
}

fn stance_name(code: &str) -> &'static str {
    match code {
        "decline" => "婉转地拒绝",
        "ask" => "不表态，只追问关键细节",
        _ => "答应",
    }
}

/// 构造一次调用的 (system, user, max_tokens)。
///
/// `content_type` 由命令层用 `ContentClassifier` 当场算出来传进来，
/// **不由前端传**——这样它与入库时的分类天然一致，也不用改变换契约。
pub fn build_prompt(
    action_id: &str,
    text: &str,
    opts: &HashMap<String, String>,
    content_type: Option<&str>,
) -> Result<(String, String, u32), String> {
    let action = find_action(action_id).ok_or_else(|| format!("未知的 AI 动作：{}", action_id))?;
    let trimmed = check_input(text)?;

    let user = match action.id {
        "ai-translate" => {
            let lang = opt_or_default(&action.options[0], opts);
            format!(
                "把下面的内容翻译成{}。如果它已经是{}，就翻译成英文。\n\n{}",
                lang_name(lang),
                lang_name(lang),
                trimmed
            )
        }
        "ai-summarize" => format!("用一句话概括下面的内容：\n\n{}", trimmed),
        "ai-explain-code" => format!(
            "用中文简明扼要地说明下面这段代码做了什么，不要逐行翻译：\n\n{}",
            trimmed
        ),
        "ai-rewrite" => {
            let tone = opt_or_default(&action.options[0], opts);
            format!(
                "用{}的语气改写下面的内容，保持原意不变：\n\n{}",
                tone_name(tone),
                trimmed
            )
        }
        "ai-polish" => format!(
            "修掉下面内容里的错别字、标点与语病，**保持原意和原有风格不变**，不要扩写也不要缩写：\n\n{}",
            trimmed
        ),
        "ai-key-points" => format!(
            "把下面的内容拆成要点列表，每行一条，行首用 - 。只保留原文里真实存在的信息，不要自己发挥：\n\n{}",
            trimmed
        ),
        "ai-commit-message" => format!(
            "根据下面的代码改动写一条 commit message。要求：用中文；首行不超 50 字且只说做了什么；\
             若改动较多，首行后空一行再列要点：\n\n{}",
            trimmed
        ),
        "ai-json-to-type" => format!(
            "把下面的 JSON 转成 TypeScript 类型定义。嵌套对象拆成独立 interface；\
             数组取元素的共同类型；拿不准的字段用 unknown 而不是 any：\n\n{}",
            trimmed
        ),
        "ai-tabulate" => format!(
            "把下面的内容整理成 Markdown 表格。自己判断列头；原文没有的单元格留空，不要编：\n\n{}",
            trimmed
        ),
        "ai-reply-draft" => {
            let stance = opt_or_default(&action.options[0], opts);
            format!(
                "下面是我收到的消息。以{}的态度替我写一段可以直接发出去的回复，\
                 语言与原消息一致，不要写称呼以外的套话：\n\n{}",
                stance_name(stance),
                trimmed
            )
        }
        "ai-merge-polish" => format!(
            "下面是用分隔符拼起来的多段内容，帮我整理成一份连贯的文本：\
             去掉完全重复的段落，按合理的逻辑顺序重排，顺手修正明显语病，\
             不要编造原文没有的内容，不要加标题。直接输出整理结果：\n\n{}",
            trimmed
        ),
        "ai-weekly-report" => format!(
            "下面是我本周使用剪贴板的行为统计（只有数字和分类，没有具体内容）。\
             用中文写一段 3~5 行的周报，说说我这周的工作节奏和侧重点，\
             语气自然不浮夸，不要编造统计里不存在的细节：\n\n{}",
            trimmed
        ),
        other => return Err(format!("动作 {} 尚未实现", other)),
    };

    Ok((system_prompt(content_type), user, action.max_tokens))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn test_every_action_builds_a_prompt() {
        // 防止“加了动作但忘了写分支”：注册表里每一项都必须能造出 prompt
        for a in ACTIONS {
            let r = build_prompt(a.id, "hello world", &HashMap::new(), None);
            assert!(r.is_ok(), "动作 {} 造不出 prompt：{:?}", a.id, r.err());
            let (system, user, max_tokens) = r.unwrap();
            assert!(system.contains("只输出处理结果"));
            assert!(user.contains("hello world"), "原文必须在 prompt 里");
            assert_eq!(max_tokens, a.max_tokens);
        }
    }

    #[test]
    fn test_unknown_action_rejected() {
        let err = build_prompt("ai-不存在", "x", &HashMap::new(), None).unwrap_err();
        assert!(err.contains("未知的 AI 动作"));
    }

    #[test]
    fn test_empty_input_rejected() {
        let err = build_prompt("ai-summarize", "   \n  ", &HashMap::new(), None).unwrap_err();
        assert!(err.contains("为空"));
    }

    #[test]
    fn test_oversized_input_rejected_not_truncated() {
        // 宁可报错也不静默截断——截断会悄无声息地改变语义
        let long: String = "字".repeat(MAX_INPUT_CHARS + 1);
        let err = build_prompt("ai-translate", &long, &HashMap::new(), None).unwrap_err();
        assert!(err.contains("过长"));
        assert!(err.contains(&MAX_INPUT_CHARS.to_string()));
    }

    #[test]
    fn test_input_at_exact_limit_accepted() {
        let exact: String = "字".repeat(MAX_INPUT_CHARS);
        assert!(build_prompt("ai-summarize", &exact, &HashMap::new(), None).is_ok());
    }

    // v6.4 六大王牌：C 合并增强 + E 周报的动作提示词
    #[test]
    fn test_merge_polish_prompt() {
        let (_, user, _) =
            build_prompt("ai-merge-polish", "段落一\n段落二", &HashMap::new(), None).unwrap();
        assert!(user.contains("重复"));
        assert!(user.contains("段落一"));
    }

    #[test]
    fn test_weekly_report_prompt() {
        let (_, user, _) = build_prompt(
            "ai-weekly-report",
            "内容类型：代码 60%，链接 20%",
            &HashMap::new(),
            None,
        )
        .unwrap();
        assert!(user.contains("行为统计"));
        assert!(user.contains("代码 60%"));
    }

    #[test]
    fn test_translate_option_applied() {
        let (_, user, _) = build_prompt("ai-translate", "hello", &opts(&[("lang", "ja")]), None).unwrap();
        assert!(user.contains("日文"));
        assert!(!user.contains("韩文"));
    }

    #[test]
    fn test_unknown_option_value_falls_back_to_default() {
        // 前端传了离谱值不应该报错，按默认跑
        let (_, user, _) =
            build_prompt("ai-translate", "hello", &opts(&[("lang", "火星文")]), None).unwrap();
        assert!(user.contains("中文"), "应回退到默认的中文");

        let (_, user2, _) = build_prompt("ai-rewrite", "hello", &opts(&[("tone", "xxx")]), None).unwrap();
        assert!(user2.contains("简洁"), "应回退到默认的简洁");
    }

    #[test]
    fn test_action_ids_are_unique() {
        let mut ids: Vec<&str> = ACTIONS.iter().map(|a| a.id).collect();
        let total = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), total, "动作 id 有重复");
    }

    /// 真实跑一遍全部动作，验证**系统提示词真的压住了前言**。
    ///
    /// 这件事单测证明不了（只能验 prompt 字面对不对），而它正是最容易出错的地方：
    /// 产物要直接写回剪贴板，多一句“好的，以下是……”就是脏数据。
    ///
    /// 跑法：`PASTEPANDA_AI_KEY=sk-xxx cargo test --lib -- --ignored test_live_all_actions --nocapture`
    #[tokio::test]
    #[ignore = "需要真实 API Key 且会计费，默认跳过"]
    async fn test_live_all_actions() {
        let key = std::env::var("PASTEPANDA_AI_KEY")
            .expect("请先设置环境变量 PASTEPANDA_AI_KEY");
        let cfg = crate::ai::AiConfig::default();

        let samples: &[(&str, &str)] = &[
            ("ai-translate", "The quick brown fox jumps over the lazy dog."),
            (
                "ai-summarize",
                "会议决定下周一上线新版本，前端负责改改页面，后端负责数据库迁移，\
                 测试周五前完成回归，若有阻塞当天同步。",
            ),
            ("ai-explain-code", "fn main() { println!(\"hi\"); }"),
            ("ai-rewrite", "这个东西不太行，你们得改改。"),
        ];

        for (id, text) in samples {
            let (system, user, max_tokens) =
                build_prompt(id, text, &HashMap::new(), None).expect("prompt 构造失败");
            let out = crate::ai::chat(&cfg, &key, Some(system.as_str()), &user, Some(max_tokens))
                .await
                .unwrap_or_else(|e| panic!("{} 调用失败：{}", id, e));

            println!("[live] {} => {:?}", id, out.content);

            assert!(
                !out.content.starts_with("```"),
                "{} 的结果被代码块包裹了：{}",
                id,
                out.content
            );
            for bad in ["好的", "以下是", "当然", "Sure", "Here"] {
                assert!(
                    !out.content.starts_with(bad),
                    "{} 的结果带了前言：{}",
                    id,
                    out.content
                );
            }
        }
    }

    // ===== 自定义模板 =====

    #[test]
    fn test_template_must_contain_placeholder() {
        // 这是整个自定义动作的核心约束：没占位符就不知道内容放哪，
        // 而自动拼在末尾会把“只输出结果本身”这类收尾约束挤掉
        let err = validate_template("把这段话润色一下。").unwrap_err();
        assert!(err.contains("{{内容}}"), "报错要直接告诉用户缺什么：{}", err);

        assert!(validate_template("润色：{{内容}}").is_ok());
        assert!(validate_template("polish: {{content}}").is_ok(), "英文占位符也要认");
    }

    #[test]
    fn test_template_length_and_empty_rejected() {
        assert!(validate_template("   ").unwrap_err().contains("不能为空"));
        let long = format!("{}{{{{内容}}}}", "字".repeat(MAX_TEMPLATE_CHARS));
        assert!(validate_template(&long).unwrap_err().contains("过长"));
    }

    #[test]
    fn test_custom_prompt_renders_at_placeholder_position() {
        // 内容必须落在占位符的位置，而不是被拼到末尾——
        // 否则“只输出结果本身”就不是最后一句话了
        let (system, user, mt) =
            build_custom_prompt("前缀\n{{内容}}\n只输出结果本身。", "待处理", 500, None).unwrap();
        assert_eq!(user, "前缀\n待处理\n只输出结果本身。");
        assert!(user.ends_with("只输出结果本身。"), "收尾约束必须在最后");
        assert!(system.contains("只输出处理结果"));
        assert_eq!(mt, 500);
    }

    #[test]
    fn test_custom_prompt_replaces_every_placeholder() {
        let (_, user, _) =
            build_custom_prompt("A{{内容}}B{{content}}C", "x", 100, None).unwrap();
        assert_eq!(user, "AxBxC");
    }

    #[test]
    fn test_custom_prompt_shares_input_limits() {
        // 自定义不能绕过内容长度与非空校验
        let long: String = "字".repeat(MAX_INPUT_CHARS + 1);
        assert!(build_custom_prompt("{{内容}}", &long, 100, None)
            .unwrap_err()
            .contains("过长"));
        assert!(build_custom_prompt("{{内容}}", "  ", 100, None)
            .unwrap_err()
            .contains("为空"));
    }

    // ===== 内容类型注入 =====

    #[test]
    fn test_content_type_goes_into_system_prompt() {
        let (with, _, _) =
            build_prompt("ai-summarize", "hello", &HashMap::new(), Some("json")).unwrap();
        assert!(with.contains("JSON"), "内容类型没注入：{}", with);

        let (without, _, _) =
            build_prompt("ai-summarize", "hello", &HashMap::new(), None).unwrap();
        assert!(!without.contains("内容类型是"));

        // 认不出来的类型不注入，而不是把原始 id 喂给模型
        let (unknown, _, _) =
            build_prompt("ai-summarize", "hello", &HashMap::new(), Some("火星类型")).unwrap();
        assert!(!unknown.contains("火星类型"));
    }

    #[test]
    fn test_secret_is_not_a_selectable_content_type() {
        // 不应该存在一个“专门在密钥上冒出来”的云端动作
        assert!(
            !SELECTABLE_CONTENT_TYPES.iter().any(|(id, _)| *id == "secret"),
            "secret 不得出现在可选类型里"
        );
    }

    #[test]
    fn test_new_actions_bind_sensible_content_types() {
        // 新增动作必须绑类型，否则会在所有内容上冒出来把列表冲掉
        for id in ["ai-commit-message", "ai-json-to-type", "ai-polish"] {
            let a = find_action(id).expect(id);
            assert!(!a.content_types.is_empty(), "{} 没绑内容类型", id);
            for ct in a.content_types {
                assert!(
                    SELECTABLE_CONTENT_TYPES.iter().any(|(x, _)| x == ct),
                    "{} 绑了一个不存在的类型 {}",
                    id,
                    ct
                );
            }
        }
    }

    #[test]
    fn test_options_default_is_within_values() {
        // 防止默认值写错后静默生效成另一个选项
        for a in ACTIONS {
            for spec in a.options {
                assert!(
                    spec.values.iter().any(|v| v.value == spec.default),
                    "{} 的选项 {} 默认值 {} 不在候选集里",
                    a.id,
                    spec.key,
                    spec.default
                );
            }
        }
    }
}
