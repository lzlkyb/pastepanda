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

const TYPE_TARGET_VALUES: &[ActionOptionValue] = &[
    ActionOptionValue { value: "ts", label: "TypeScript" },
    ActionOptionValue { value: "java", label: "Java" },
    ActionOptionValue { value: "rust", label: "Rust" },
    ActionOptionValue { value: "go", label: "Go" },
    ActionOptionValue { value: "python", label: "Python" },
];

/// JSON 转类型的目标语言。
///
/// 默认 `ts` 是故意的：改动前这个动作硬编码只出 TypeScript，
/// 默认值不变才能保证老用户不选也得到同一个结果。
const JSON_TO_TYPE_OPTS: &[ActionOptionSpec] = &[ActionOptionSpec {
    key: "target",
    label: "目标语言",
    values: TYPE_TARGET_VALUES,
    default: "ts",
}];

/// 选项值 → prompt 里用的语言名。未知值回退 TypeScript，与 opt_or_default 同一口径。
fn type_target_name(target: &str) -> &'static str {
    match target {
        "java" => "Java",
        "rust" => "Rust",
        "go" => "Go",
        "python" => "Python",
        _ => "TypeScript",
    }
}

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
        id: "ai-note-tags",
        label: "建议标签",
        description: "给这篇笔记提几个检索用的标签",
        icon: "tags",
        // 只要几个词，但带思考的推理模型需要空间（同 ai-summarize 的取舍）
        max_tokens: 512,
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
        description: "按所选语言生成类型定义",
        icon: "braces",
        max_tokens: 1500,
        options: JSON_TO_TYPE_OPTS,
        content_types: &["json"],
    },
    AiAction {
        id: "ai-fix-code",
        label: "修复代码",
        description: "修掉报错与坏代码，输出可直接用的版本",
        icon: "wrench",
        max_tokens: 2000,
        options: &[],
        content_types: &["code", "shell"],
    },
    AiAction {
        id: "ai-regex-generate",
        label: "生成正则",
        description: "根据自然语言描述生成正则表达式",
        icon: "regex",
        max_tokens: 800,
        options: &[],
        content_types: &["text"],
    },
    AiAction {
        id: "ai-sql-generate",
        label: "生成 SQL",
        description: "根据自然语言描述生成 SQL 查询",
        icon: "database",
        max_tokens: 1000,
        options: &[],
        content_types: &["text"],
    },
    AiAction {
        // v6.10 结果追问：对上一次 AI 结果继续处理（「再短一点 / 翻译成英文…」）。
        // 不在快捷区/变换面板独立展示（没有"对哪段"的前置上下文），只由结果卡触发。
        id: "ai-followup",
        label: "继续处理",
        description: "对上一次结果继续追问",
        icon: "message-square",
        max_tokens: 2000,
        options: &[],
        content_types: &["text"],
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
        // 一次出 3 个语气候选，比单段回复长；上限要留够（1200 会截断第三段）
        max_tokens: 2000,
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
    // ===== 流程图画布内部动作（见 INTERNAL_ACTION_IDS，不进变换中心的清单）=====
    //
    // 为什么不复用 ai-rewrite：它的模板是「用 X 的语气改写下面的内容，保持原意不变：{内容}」。
    // 把「请输出 mermaid」这类指令塞进它的内容槽，模型看到的任务就成了「把这段指令换个语气重写」，
    // 返回的是一段散文而不是图（且「保持原意不变」与「生成流程图」直接冲突）。
    // 指令必须在模板里、用户内容在占位处，这是整张表的统一约定。
    AiAction {
        id: "ai-diagram",
        label: "生成流程图",
        description: "把一句话需求画成 Mermaid flowchart",
        icon: "workflow",
        // 比改写类动作小：12 节点以内的 flowchart 很难超 800 token，给 1500 留足余量
        max_tokens: 1500,
        options: &[],
        content_types: &[],
    },
    AiAction {
        id: "ai-diagram-expand",
        label: "展开子流程",
        description: "把一个流程节点拆成 3~6 个子步骤",
        icon: "git-branch",
        max_tokens: 800,
        options: &[],
        content_types: &[],
    },
    AiAction {
        id: "ai-diagram-label",
        label: "润色节点文字",
        description: "把流程图节点文字改得更专业简洁",
        icon: "pen-line",
        // 只返回一短句，上限给大了只会鼓励模型扯长
        max_tokens: 200,
        options: &[],
        content_types: &[],
    },
    // ===== 知识库问答雏形（B2 #10）=====
    //
    // 同样必须是内部动作：它的输入是拼好的「问题 + 从知识库检出的片段」格式。
    // 摆进卡片的变换中心后，用户会对着一段普通文本点「问知识库」——
    // 发出去的是卡片内容，回来的必然是胡话。
    AiAction {
        id: "ai-kb-qa",
        label: "问知识库",
        description: "只根据给定的笔记片段回答问题",
        icon: "sparkles",
        // 回答要短（几句话），但带思考的推理模型光思考就要几百 token，
        // 所以与 ai-summarize 同取 1024（上限 ≠ 预分配，不抬成本）
        max_tokens: 1024,
        options: &[],
        content_types: &[],
    },
];

/// 不进通用动作面的内部动作：`ai_run` 照常受理，但不出现在 `ai_list_actions` 的清单里。
///
/// 前端 `initAiTransforms` 会把清单里的**每一条**都注册成变换，不过滤的话
/// 这几条会出现在卡片的变换中心里——而它们的输入输出都是专用格式
/// （画布三条是 mermaid，问答那条是「问题 + 片段」），对普通内容无意义。
pub const INTERNAL_ACTION_IDS: &[&str] = &[
    "ai-diagram",
    "ai-diagram-expand",
    "ai-diagram-label",
    // 知识库问答（B2 #10）：只能从知识模式的搜/问切换器进，
    // 它的输入是拼好的「问题 + 片段」格式，对普通卡片内容无意义。
    "ai-kb-qa",
];

pub fn is_internal_action(id: &str) -> bool {
    INTERNAL_ACTION_IDS.contains(&id)
}

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

/// `build_prompt` 的附加上下文。
///
/// 用结构体而不是继续加位置参数：语言与用户标签是连着加的两项，
/// 分两次改签名等于把二十处测试调用改两遍。带 `Default`，以后加字段不用再动调用方。
#[derive(Debug, Default, Clone, Copy)]
pub struct PromptCtx<'a> {
    /// 后端 `ContentClassifier` 当场算的粗分类。
    pub content_type: Option<&'a str>,
    /// 语言级标签（Rust / Java / SQL …）。同样来自 classifier，前端不参与：
    /// `content_type` 到 `code` 就到顶了，这一层才分得出是哪门语言。
    pub language: Option<&'a str>,
    /// 用户**手工**标签名（已拼好的一串）。只有 `ai_tags_as_context` 开着才有值。
    ///
    /// **这是唯一由前端传进来的一项**：标签是按条目 id 存的用户数据，后端在这里拿不到；
    /// 而它会随内容出网，所以命令层必须先把它过一道出网闸（见 run.rs）。
    pub user_tags: Option<&'a str>,
}

/// 把语言标签拼成 prompt 里的前置定语（没标签就是空串，句子仍然通顺）。
fn lang_prefix(language: Option<&str>) -> String {
    match language {
        Some(l) if !l.trim().is_empty() => format!("{} ", l.trim()),
        _ => String::new(),
    }
}

/// 构造一次调用的 (system, user, max_tokens)。
///
/// `ctx.content_type` 与 `ctx.language` 由命令层用 `ContentClassifier` 当场算出来传进来，
/// **不由前端传**——这样它与入库时的分类天然一致，也不用改变换契约。
pub fn build_prompt(
    action_id: &str,
    text: &str,
    opts: &HashMap<String, String>,
    ctx: PromptCtx<'_>,
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
        // 输出格式说得死一点，因为它要被机器解析（parse_ai_tags）。
        // 但解析侧仍得容错：模型违反格式是常态，不能指望 prompt 兜底。
        "ai-note-tags" => format!(
            "给下面这篇笔记提 3~5 个标签，用于以后检索。要求：每个标签不超过 6 个字；\
             优先用中文（技术专有名词保留原文）；只提内容里真实存在的主题，不要自己发挥。\
             **只输出标签本身，用逗号分隔，不要编号、不要解释、不要加引号**：\n\n{}",
            trimmed
        ),
        "ai-explain-code" => format!(
            "用中文简明扼要地说明下面这段 {}代码做了什么，不要逐行翻译：\n\n{}",
            lang_prefix(ctx.language),
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
        // 目标语言走**动作选项**而不是语言标签：输入是 JSON，它自己没有语言标签
        // （classifier 给的就是“JSON”），转成哪门语言只能由用户选。
        "ai-json-to-type" => {
            let target = opt_or_default(&action.options[0], opts);
            format!(
                "把下面的 JSON 转成 {} 的类型定义。嵌套对象拆成独立类型；\
                 数组取元素的共同类型；拿不准的字段用该语言里最保守的未知类型，不要用等价于任意类型的宽松写法；\
                 只输出代码，不要解释：\n\n{}",
                type_target_name(target),
                trimmed
            )
        }
        "ai-fix-code" => format!(
            "修复下面这段 {}代码里的错误（语法、逻辑、运行时问题均可），输出修复后的完整代码。\
             拿不准的地方保留原样并加一行注释说明你的判断。\
             用代码块包裹输出，不要逐行解释：\n\n{}",
            lang_prefix(ctx.language),
            trimmed
        ),
        "ai-regex-generate" => format!(
            "根据下面的自然语言描述生成一个正则表达式。\
             只输出一行正则（不要代码块、不要解释），要求：\
             准确匹配描述的场景、考虑常见边界（如手机号 1[3-9] 开头、邮箱 @ 后带域名）；\
             如果描述本身有歧义，选最可能的一种并只输出它。\n\n描述：{}",
            trimmed
        ),
        "ai-sql-generate" => format!(
            "根据下面的自然语言描述生成一条 SQL 查询。\
             只输出 SQL（不要代码块、不要解释）；\
             表名与列名用下划线命名，条件按描述推断；\
             如果描述里有歧义，选最合理的解释并只用注释说明假设。\n\n描述：{}",
            trimmed
        ),
        "ai-followup" => format!(
            "这是对上一次 AI 结果的继续处理。内容 = 用户的追问 + 上一次的结果。\
             严格按用户追问执行（如「再短一点」「翻译成英文」「换个语气」），\
             只输出处理后的结果，不要解释过程、不要重复追问内容：\n\n{}",
            trimmed
        ),
        "ai-tabulate" => format!(
            "把下面的内容整理成 Markdown 表格。自己判断列头；原文没有的单元格留空，不要编：\n\n{}",
            trimmed
        ),
        "ai-reply-draft" => {
            let stance = opt_or_default(&action.options[0], opts);
            format!(
                "下面是我收到的消息。以{}的态度替我写一段可以直接发出去的回复，语言与原消息一致。\n\n\
                 给出 3 个不同语气的候选，每段以标题行开头（标题独占一行），格式如下：\n\
                 ---正式版---\n（正式、书面的回复）\n---简洁版---\n（简洁直白的回复）\n---轻松版---\n（轻松口语化的回复）\n\n\
                 只输出这 3 段，不要加其他说明，每段都可以直接发送：\n\n{}",
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
        // 下面三条是流程图画布专用。语法举例写得具体，是因为 parseMermaid 只认
        // ASCII 节点 id；模型若用中文做 id（如 开始[开始]）会整行解不出来。
        "ai-diagram" => format!(
            "把下面的需求画成一张 Mermaid flowchart。\
             首行必须是 flowchart TD；\
             节点 id 用英文字母或字母加数字（如 A、B1），不要用中文做 id；\
             节点写成 A[标签] / B(圆角) / C{{判断}}，连线写成 A --> B 或 A -->|说明| B；\
             标签用中文，控制在 12 个节点以内。\
             只输出 mermaid 代码本身，不要任何解释文字：\n\n需求：{}",
            trimmed
        ),
        "ai-diagram-expand" => format!(
            "把下面这个流程节点展开成 3~6 个有序子步骤，输出一张 Mermaid flowchart。\
             首行必须是 flowchart TD；\
             节点 id 用英文字母或字母加数字，不要用中文做 id；\
             节点写成 A[标签] / B(圆角) / C{{判断}}；标签用中文，控制在 6 个节点以内。\
             只输出 mermaid 代码本身，不要任何解释文字：\n\n待展开的节点：{}",
            trimmed
        ),
        "ai-diagram-label" => format!(
            "把下面这句流程图节点文字改写得更专业、通顺、简洁，控制在 12 个字以内。\
             只返回改写后的文字本身，不要解释、不要引号、不要 Markdown：\n\n原文：{}",
            trimmed
        ),
        // 知识库问答雏形（B2 #10）。`trimmed` 是**前端拼好**的「问题 + 编号片段」，
        // 格式约定住在 `src/lib/notes/kbQa.ts`，两边必须一致。
        //
        // 问题为何不走 `opts` 而拼进正文：`ai_run` 的出网闸只扫 `text`，
        // 放 `opts` 里等于让用户在问题里打一个手机号就静默出网。
        //
        // 引用格式是与前端的**硬约定**（B2 #10b）：前端 `linkifyCitations` 把 `[n]`
        // 预处理成 markdown 链接再渲染成可点 chip。所以这里要**鼓励**打 `[n]`——
        // #10 初版写的是「不要输出编号」（当时不解析），已反过来。**两处成对，改一头就错。**
        //
        // 越界编号（如只送 5 篇却打 [9]）由前端当普通文本留着，不会渲染成点不动的 chip，
        // 所以这里不必也不应把格式要求写得更重——模型违反格式是常态，兜底在前端。
        "ai-kb-qa" => format!(
            "下面是用户的问题，以及从他本人知识库里检索出的笔记片段（每段开头有 [编号] 与标题）。\
             **只能依据这些片段回答**：片段里没有的信息，直接回答「知识库中没有相关笔记」，\
             不要用常识补充、不要推测、不要把问题重复一遍。\
             若开头给了「上一轮问答」，它**只用于看懂本次追问的指代**，不得当成依据。\
             每一条事实陈述的句末要标出它来自哪一段，格式就是片段编号，如 [1]；\
             同时来自多段就并列，如 [1][2]。不要自己另写参考文献列表。\
             回答简洁，可以用 Markdown 的列表与粗体排版。用与问题相同的语言回答。\n\n{}",
            trimmed
        ),
        other => return Err(format!("动作 {} 尚未实现", other)),
    };

    // ai_tags_as_context：把用户手工标签当意图上下文拼进去。
    //
    // **集中注入一次**，不给十六个动作各改一遍 prompt——那样以后加动作必漏。
    // 放在正文**之前**：模型得先知道“这条是干什么用的”，再读内容。
    // 带上“不要在输出里提及”：否则模型容易把标签名复述进结果里。
    let user = match ctx.user_tags {
        Some(tags) if !tags.trim().is_empty() => format!(
            "（用户给这条内容打的标签，仅用于理解意图，不要在输出里提及）：{}\n\n{}",
            tags.trim(),
            user
        ),
        _ => user,
    };

    Ok((system_prompt(ctx.content_type), user, action.max_tokens))
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
            let r = build_prompt(a.id, "hello world", &HashMap::new(), PromptCtx::default());
            assert!(r.is_ok(), "动作 {} 造不出 prompt：{:?}", a.id, r.err());
            let (system, user, max_tokens) = r.unwrap();
            assert!(system.contains("只输出处理结果"));
            assert!(user.contains("hello world"), "原文必须在 prompt 里");
            assert_eq!(max_tokens, a.max_tokens);
        }
    }

    #[test]
    fn test_unknown_action_rejected() {
        let err = build_prompt("ai-不存在", "x", &HashMap::new(), PromptCtx::default()).unwrap_err();
        assert!(err.contains("未知的 AI 动作"));
    }

    #[test]
    fn test_empty_input_rejected() {
        let err = build_prompt("ai-summarize", "   \n  ", &HashMap::new(), PromptCtx::default()).unwrap_err();
        assert!(err.contains("为空"));
    }

    #[test]
    fn test_oversized_input_rejected_not_truncated() {
        // 宁可报错也不静默截断——截断会悄无声息地改变语义
        let long: String = "字".repeat(MAX_INPUT_CHARS + 1);
        let err = build_prompt("ai-translate", &long, &HashMap::new(), PromptCtx::default()).unwrap_err();
        assert!(err.contains("过长"));
        assert!(err.contains(&MAX_INPUT_CHARS.to_string()));
    }

    #[test]
    fn test_input_at_exact_limit_accepted() {
        let exact: String = "字".repeat(MAX_INPUT_CHARS);
        assert!(build_prompt("ai-summarize", &exact, &HashMap::new(), PromptCtx::default()).is_ok());
    }

    // v6.4 六大王牌：C 合并增强 + E 周报的动作提示词
    #[test]
    fn test_merge_polish_prompt() {
        let (_, user, _) =
            build_prompt("ai-merge-polish", "段落一\n段落二", &HashMap::new(), PromptCtx::default()).unwrap();
        assert!(user.contains("重复"));
        assert!(user.contains("段落一"));
    }

    // B2 #10 问答雏形：三条硬规则缺任一条都是一种独特的失败方式
    #[test]
    fn test_kb_qa_prompt_has_hard_rules() {
        let (_, user, max) = build_prompt(
            "ai-kb-qa",
            "问题：部署流程？\n\n[1] 部署手册\n先发预发布。",
            &HashMap::new(),
            PromptCtx::default(),
        )
        .unwrap();
        // ① 只能依据片段——漏了模型就拿常识编，而那是知识库问答最致命的失败
        assert!(user.contains("只能依据这些片段回答"));
        // ② 无命中的固定说法——漏了每次回答说法不一
        assert!(user.contains("知识库中没有相关笔记"));
        // ③ **鼓励**标 [n]（B2 #10b 反转）——前端要把它渲染成可点 chip，
        //   漏了就一个 chip 也出不来。与 `linkifyCitations` 成对
        assert!(user.contains("句末要标出它来自哪一段"));
        assert!(user.contains("[1]"));
        // 上一轮只作指代上下文，不得当依据（多轮追问的关键约束）
        assert!(user.contains("不得当成依据"));
        // 载荷原样带上
        assert!(user.contains("部署手册"));
        assert_eq!(max, 1024);
    }

    // 问答动作**不能**出现在通用动作面里：否则用户会对着普通卡片点「问知识库」，
    // 发出去的是卡片内容、回来的必然是胡话
    #[test]
    fn test_kb_qa_is_internal_action() {
        assert!(is_internal_action("ai-kb-qa"));
    }

    // v6.1 S3：修复代码动作
    #[test]
    fn test_fix_code_prompt() {
        let (_, user, _) =
            build_prompt("ai-fix-code", "function a( { return 1 }", &HashMap::new(), PromptCtx::default()).unwrap();
        assert!(user.contains("修复"), "prompt 应要求修复代码");
        assert!(user.contains("function a( { return 1 }"), "原文应完整带入");
    }

    // v6.4 E：自然语言 → 正则
    #[test]
    fn test_regex_generate_prompt() {
        let (_, user, _) =
            build_prompt("ai-regex-generate", "把 138 开头的手机号换掉", &HashMap::new(), PromptCtx::default()).unwrap();
        assert!(user.contains("正则"), "prompt 应要求生成正则");
        assert!(user.contains("138 开头的手机号"), "描述应完整带入");
        assert!(user.contains("只输出一行"), "应要求只输出一行正则");
    }

    // v6.7：自然语言 → SQL
    #[test]
    fn test_sql_generate_prompt() {
        let (_, user, _) =
            build_prompt("ai-sql-generate", "查昨天下单超过 100 元的订单", &HashMap::new(), PromptCtx::default()).unwrap();
        assert!(user.contains("SQL"), "prompt 应要求生成 SQL");
        assert!(user.contains("昨天下单超过 100 元"), "描述应完整带入");
    }

    #[test]
    fn test_weekly_report_prompt() {
        let (_, user, _) = build_prompt(
            "ai-weekly-report",
            "内容类型：代码 60%，链接 20%",
            &HashMap::new(),
            PromptCtx::default(),
        )
        .unwrap();
        assert!(user.contains("行为统计"));
        assert!(user.contains("代码 60%"));
    }

    #[test]
    fn test_reply_draft_prompt_asks_three_tone_candidates() {
        // 六大王牌 F：回复草稿一次要 3 个语气候选，且标题行格式固定，
        // 前端才解析得出来（---正式版--- / ---简洁版--- / ---轻松版---）
        let (_, user, _) = build_prompt(
            "ai-reply-draft",
            "明天开会吗？",
            &HashMap::new(),
            PromptCtx::default(),
        )
        .unwrap();
        assert!(user.contains("---正式版---"), "必须要求正式版候选：{user}");
        assert!(user.contains("---简洁版---"), "必须要求简洁版候选：{user}");
        assert!(user.contains("---轻松版---"), "必须要求轻松版候选：{user}");
        // 默认态度是答应
        assert!(user.contains("答应"), "默认 stance 应为答应：{user}");
    }

    #[test]
    fn test_reply_draft_max_tokens_enough_for_three_candidates() {
        let (_, _, max_tokens) = build_prompt(
            "ai-reply-draft",
            "x",
            &HashMap::new(),
            PromptCtx::default(),
        )
        .unwrap();
        assert!(max_tokens >= 1800, "3 个候选需要更大上限，当前 {max_tokens}");
    }

    #[test]
    fn test_translate_option_applied() {
        let (_, user, _) = build_prompt("ai-translate", "hello", &opts(&[("lang", "ja")]), PromptCtx::default()).unwrap();
        assert!(user.contains("日文"));
        assert!(!user.contains("韩文"));
    }

    #[test]
    fn test_unknown_option_value_falls_back_to_default() {
        // 前端传了离谱值不应该报错，按默认跑
        let (_, user, _) =
            build_prompt("ai-translate", "hello", &opts(&[("lang", "火星文")]), PromptCtx::default()).unwrap();
        assert!(user.contains("中文"), "应回退到默认的中文");

        let (_, user2, _) = build_prompt("ai-rewrite", "hello", &opts(&[("tone", "xxx")]), PromptCtx::default()).unwrap();
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

    #[test]
    fn test_internal_action_ids_all_exist() {
        // 防止名单里拼错 id：拼错不会报错，只会让该动作静默泄露到变换中心里
        for id in INTERNAL_ACTION_IDS {
            assert!(find_action(id).is_some(), "INTERNAL_ACTION_IDS 里的 {} 不在 ACTIONS 表里", id);
            assert!(is_internal_action(id));
        }
        assert!(!is_internal_action("ai-rewrite"), "普通动作不能被当成内部动作");
    }

    /// 流程图三条动作的 prompt 必须自己带全部指令。
    ///
    /// 回归：这三个功能最早复用 ai-rewrite，把指令拼在用户文本里一起传，
    /// 结果落到 ai-rewrite 模板的内容槽里 → 模型去改写指令而不是画图。
    #[test]
    fn test_diagram_prompts_are_self_contained() {
        let (_, user, max_tokens) =
            build_prompt("ai-diagram", "登录流程", &HashMap::new(), PromptCtx::default()).unwrap();
        assert!(user.contains("flowchart TD"), "必须告诉模型首行格式");
        assert!(user.contains("不要用中文做 id"), "parseMermaid 只认 ASCII 节点 id");
        assert!(user.contains("C{判断}"), "format! 里的 {{}} 转义写错会把语法例子吐掉");
        assert!(user.trim_end().ends_with("登录流程"), "用户内容在末尾，指令在前");
        assert_eq!(max_tokens, 1500);

        let (_, user2, _) =
            build_prompt("ai-diagram-expand", "校验参数", &HashMap::new(), PromptCtx::default()).unwrap();
        assert!(user2.contains("flowchart TD") && user2.contains("3~6"));

        let (_, user3, _) =
            build_prompt("ai-diagram-label", "处理", &HashMap::new(), PromptCtx::default()).unwrap();
        assert!(user3.contains("只返回改写后的文字本身"));
        assert!(!user3.contains("flowchart"), "润色只改文字，不该让模型输出图");
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
                build_prompt(id, text, &HashMap::new(), PromptCtx::default()).expect("prompt 构造失败");
            let out = crate::ai::chat(&cfg, &key, Some(system.as_str()), &user, Some(max_tokens), None)
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

    /// 语言级标签必须真的进 prompt——这是整个 C3 的目的。
    /// 不进的话“识别出 Rust”就只是个不影响输出的内部状态。
    #[test]
    fn test_language_goes_into_code_prompts() {
        for id in ["ai-explain-code", "ai-fix-code"] {
            let (_, user, _) = build_prompt(
                id,
                "fn main() {}",
                &HashMap::new(),
                PromptCtx {
                    language: Some("Rust"),
                    ..Default::default()
                },
            )
            .unwrap();
            assert!(user.contains("Rust"), "{id} 没把语言写进 prompt：{user}");
        }
    }

    /// 没识别出语言时句子仍然要通顺（lang_prefix 返回空串），
    /// 不能出现“这段  代码”这种双空格或坠落的占位符。
    #[test]
    fn test_no_language_leaves_prompt_clean() {
        let (_, user, _) =
            build_prompt("ai-explain-code", "x = 1", &HashMap::new(), PromptCtx::default()).unwrap();
        assert!(!user.contains("{}"), "占位符没被填：{user}");
        assert!(!user.contains("  "), "留下了双空格：{user}");
    }

    /// json-to-type 的目标语言走动作选项；默认必须仍是 TypeScript
    /// （改动前硬编码只出 TS，默认值变了就是默默改了老用户的结果）。
    #[test]
    fn test_json_to_type_target_option() {
        let (_, dflt, _) = build_prompt(
            "ai-json-to-type",
            "{\"a\":1}",
            &HashMap::new(),
            PromptCtx::default(),
        )
        .unwrap();
        assert!(dflt.contains("TypeScript"), "默认应仍为 TypeScript：{dflt}");

        let (_, java, _) = build_prompt(
            "ai-json-to-type",
            "{\"a\":1}",
            &opts(&[("target", "java")]),
            PromptCtx::default(),
        )
        .unwrap();
        assert!(java.contains("Java"), "target=java 未生效：{java}");
        assert!(!java.contains("TypeScript"), "不该还提 TypeScript：{java}");
    }

    /// 标签上下文：有值就拼在正文**之前**，无值时 prompt 不应有任何变化。
    #[test]
    fn test_user_tags_injected_before_body() {
        let (_, with_tags, _) = build_prompt(
            "ai-summarize",
            "BODYMARK",
            &HashMap::new(),
            PromptCtx {
                user_tags: Some("TAGMARK"),
                ..Default::default()
            },
        )
        .unwrap();
        let ti = with_tags.find("TAGMARK").expect("标签没拼进去");
        let bi = with_tags.find("BODYMARK").expect("正文丢了");
        assert!(ti < bi, "标签必须在正文之前：{with_tags}");

        let (_, plain, _) =
            build_prompt("ai-summarize", "BODYMARK", &HashMap::new(), PromptCtx::default()).unwrap();
        assert!(!plain.contains("TAGMARK"));
        // 空串/纯空白等于没标签，不能拼一行空提示进去
        let (_, blank, _) = build_prompt(
            "ai-summarize",
            "BODYMARK",
            &HashMap::new(),
            PromptCtx {
                user_tags: Some("   "),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(blank, plain, "空白标签不应改变 prompt");
    }

    #[test]
    fn test_content_type_goes_into_system_prompt() {
        let (with, _, _) =
            build_prompt("ai-summarize", "hello", &HashMap::new(), PromptCtx { content_type: Some("json"), ..Default::default() }).unwrap();
        assert!(with.contains("JSON"), "内容类型没注入：{}", with);

        let (without, _, _) =
            build_prompt("ai-summarize", "hello", &HashMap::new(), PromptCtx::default()).unwrap();
        assert!(!without.contains("内容类型是"));

        // 认不出来的类型不注入，而不是把原始 id 喂给模型
        let (unknown, _, _) =
            build_prompt("ai-summarize", "hello", &HashMap::new(), PromptCtx { content_type: Some("火星类型"), ..Default::default() }).unwrap();
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
