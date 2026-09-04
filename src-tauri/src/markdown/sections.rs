//! Markdown 大纲解析。**纯函数**，不碰数据库、不碰 MCP。
//!
//! # 为何自己写而不上 pulldown-cmark
//!
//! 我们需要的不是「渲染成 HTML」而是「把原文按节切开、改完再原样拼回去」。
//! 事件流解析器给的是语义事件，反向回到「原文的第几行」要额外维护位置映射，
//! 而且多一个依赖。按行扫一遍反而更短也更好控。
//!
//! # 行为单位是「行」而不是「字节偏移」
//!
//! 中文笔记占比很高，字节切片一不小心就切在 UTF-8 字符中间直接 panic。
//! 按行做则根本不存在这个风险。
//!
//! # 行尾与无损拼回
//!
//! 用 `split('\n')` 而不是 `lines()`：后者丢掉结尾的空行信息，
//! `"a\n"` 与 `"a"` 会变成同一个东西。`split('\n')` 后 `join("\n")` 是**无损**的，
//! 而且 CRLF 输入里的 `\r` 会原封不动留在行尾——判断时 `trim_end`，拼回时不动。
//!
//! # 与 CommonMark 的一处有意偏离
//!
//! setext 标题只认 `===`（一级），**不认 `---`**（CommonMark 里它是二级标题）。
//! 理由：剪贴板来的内容里 `---` 绝大多数是**分割线**。若按标题认，
//! 会把它上面那句（可能很长的）正文当成标题填进大纲，并让上一节提前结束——
//! 那比「少识别出一个标题」难看得多。少识别只是粒度变粗，误识别是凭空造出结构。

/// 一节。
///
/// **节是平的，不嵌套**：`## A` 的正文到 `### A1` 就结束，不含子节。
/// 这是有意的——若 `kb_update_section` 能一口气替掉整棵子树，
/// AI 改一节就能静默删掉十个子节。但这个限制必须告知，
/// 所以有 [`Section::child_count`]。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section {
    /// 1 起的序号。`0` 是「引言节」（第一个标题之前的内容，或整篇无标题时的全文）。
    pub index: usize,
    /// 标题层级 1..=6。引言节为 `0`。
    pub level: u8,
    /// 标题文字（不含 `#`）。引言节为空串。
    pub heading: String,
    /// 从根到本节的标题路径。引言节为空。
    pub path: Vec<String>,
    /// 标题占的首行（0 起）。引言节为 `None`。
    ///
    /// setext 标题占两行（文字行 + `===` 行），这里是**文字行**。
    pub heading_line: Option<usize>,
    /// 正文起始行（含）。
    pub body_start: usize,
    /// 正文结束行（**不含**）。
    pub body_end: usize,
    /// 直接与间接的子节数。`> 0` 时意为「改本节不会动这些子节」。
    pub child_count: usize,
}

impl Section {
    /// 大纲里的一行标识。**序号与标题路径双写**（已拍板）：
    /// 只给路径则重名时必歧义，只给序号则每次编辑都得先拉一遍大纲。
    pub fn label(&self) -> String {
        if self.path.is_empty() {
            return format!("[{}] （引言，无标题）", self.index);
        }
        format!("[{}] {}", self.index, self.path.join(" / "))
    }
}

/// 定位一节的两种方式。
///
/// 不做「字符串能解成数字就当序号」那种魔法：标题就叫「3」的笔记是存在的，
/// 而那种歧义会静默改错地方。调用方（工具层）用两个不同的参数名收。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SectionRef {
    /// 按序号。`0` = 引言节。
    Index(usize),
    /// 按标题路径。可只给尾段（「数据流」），也可给多段（「架构/数据流」）。
    Path(String),
}

/// 定位失败。两种失败要分开：「没找到」和「找到好几个」对 AI 的下一步动作要求不同。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocateError {
    /// 没这一节。`available` 是当前大纲，直接报给 AI 看，省一轮往返。
    NotFound { available: Vec<String> },
    /// 路径命中多节。**报错而不猜**（已拍板）。
    Ambiguous { candidates: Vec<String> },
}

impl std::fmt::Display for LocateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LocateError::NotFound { available } if available.is_empty() => {
                write!(f, "这篇笔记没有任何标题，只能用 index=0（全文）。")
            }
            LocateError::NotFound { available } => write!(
                f,
                "找不到这一节。当前大纲：\n{}",
                available.join("\n")
            ),
            LocateError::Ambiguous { candidates } => write!(
                f,
                "这个标题路径命中了 {} 节，无法确定改哪一节。\
                 请用序号（index）指定，或把路径写得更完整：\n{}",
                candidates.len(),
                candidates.join("\n")
            ),
        }
    }
}

/// 解析大纲。**永不返空**：没标题的笔记也会得到一个引言节（`index = 0`）。
///
/// “永不返空”是个有用的保证：调用方不用为「空正文」写一条特例分支。
pub fn outline(content: &str) -> Vec<Section> {
    let lines: Vec<&str> = content.split('\n').collect();
    let start = frontmatter_end(&lines);
    let heads = scan_headings(&lines, start);

    let mut out: Vec<Section> = Vec::with_capacity(heads.len() + 1);

    // 引言节：第一个标题之前的内容。整篇无标题时就是全文。
    // 只有那段里真有非空白内容才给它一节——开头就是标题的笔记很多，
    // 百分之九十的大纲里多一个空的 `[0]` 只是噪声。
    let first_head = heads.first().map(|h| h.line).unwrap_or(lines.len());
    if heads.is_empty() || has_content(&lines, start, first_head) {
        out.push(Section {
            index: 0,
            level: 0,
            heading: String::new(),
            path: Vec::new(),
            heading_line: None,
            body_start: start,
            body_end: first_head,
            child_count: 0,
        });
    }

    // 标题路径靠一个栈维护。层级跳跃（`#` 直接到 `###`）时不补中间层，
    // 路径就是 `一级 / 三级`——凭空造一个不存在的二级标题才是真的误导。
    let mut stack: Vec<(u8, String)> = Vec::new();
    for (n, h) in heads.iter().enumerate() {
        while stack.last().is_some_and(|(lv, _)| *lv >= h.level) {
            stack.pop();
        }
        stack.push((h.level, h.text.clone()));

        let body_start = h.line + h.span;
        let body_end = heads.get(n + 1).map(|nx| nx.line).unwrap_or(lines.len());
        // 子节：往后数到第一个层级 <= 自己的为止。
        let child_count = heads[n + 1..]
            .iter()
            .take_while(|nx| nx.level > h.level)
            .count();

        out.push(Section {
            index: n + 1,
            level: h.level,
            heading: h.text.clone(),
            path: stack.iter().map(|(_, t)| t.clone()).collect(),
            heading_line: Some(h.line),
            body_start,
            body_end,
            child_count,
        });
    }

    out
}

/// 按定位符找一节。
pub fn locate(content: &str, r: &SectionRef) -> Result<Section, LocateError> {
    let all = outline(content);
    let labels = || all.iter().map(Section::label).collect::<Vec<_>>();

    match r {
        SectionRef::Index(i) => all
            .iter()
            .find(|s| s.index == *i)
            .cloned()
            .ok_or_else(|| LocateError::NotFound { available: labels() }),
        SectionRef::Path(p) => {
            let want = split_path(p);
            if want.is_empty() {
                return Err(LocateError::NotFound { available: labels() });
            }
            // 后缀匹配：给「数据流」能命中「架构 / 数据流」，
            // 给完整路径也能命中。AI 往往只知道自己要改哪个小标题。
            let hit: Vec<&Section> = all.iter().filter(|s| path_ends_with(&s.path, &want)).collect();
            match hit.len() {
                1 => Ok(hit[0].clone()),
                0 => Err(LocateError::NotFound { available: labels() }),
                _ => Err(LocateError::Ambiguous {
                    candidates: hit.iter().map(|s| s.label()).collect(),
                }),
            }
        }
    }
}

/// 取一节的原文。`include_heading` 决定要不要带上标题行。
pub fn slice(content: &str, s: &Section, include_heading: bool) -> String {
    let lines: Vec<&str> = content.split('\n').collect();
    let from = match (include_heading, s.heading_line) {
        (true, Some(h)) => h,
        _ => s.body_start,
    };
    let to = s.body_end.min(lines.len());
    if from >= to {
        return String::new();
    }
    lines[from..to].join("\n")
}

// ===== 内部 =====

/// 一个标题在原文里的位置。
struct Head {
    /// 首行（setext 时是文字行）。
    line: usize,
    /// 占几行：ATX = 1，setext = 2。
    span: usize,
    level: u8,
    text: String,
}

fn scan_headings(lines: &[&str], start: usize) -> Vec<Head> {
    let mut heads: Vec<Head> = Vec::new();
    // 围栏状态。代码块里的 `#` 不是标题——这是技术笔记里真会碰到的情况
    // （Markdown 教程、shell 注释、配置文件片段）。
    let mut fence: Option<(char, usize)> = None;

    for i in start..lines.len() {
        let line = lines[i];

        if let Some((ch, n)) = fence_at(line) {
            match fence {
                None => fence = Some((ch, n)),
                // 闭合要求同符号且不短于开头那串：```` 里嵌 ``` 是合法内容。
                Some((fc, fl)) if fc == ch && n >= fl => fence = None,
                _ => {}
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }

        if let Some((level, text)) = atx_heading(line) {
            heads.push(Head { line: i, span: 1, level, text });
            continue;
        }

        // setext 一级（`===`）。只有上一行是普通正文时才算。
        if i > start && setext_underline(line) {
            let prev = lines[i - 1];
            let already_head = heads.last().is_some_and(|h| h.line == i - 1);
            if !prev.trim().is_empty() && !already_head && atx_heading(prev).is_none() {
                heads.push(Head {
                    line: i - 1,
                    span: 2,
                    level: 1,
                    text: prev.trim().to_string(),
                });
            }
        }
    }

    heads
}

/// frontmatter 结束后的行号。没有 frontmatter 就返 0。
///
/// 不能把 frontmatter 的 `---` 当成内容：导入/导出（A-57）写出的文件开头就是它。
fn frontmatter_end(lines: &[&str]) -> usize {
    if lines.first().map(|l| l.trim_end()) != Some("---") {
        return 0;
    }
    for (i, l) in lines.iter().enumerate().skip(1) {
        let t = l.trim_end();
        if t == "---" || t == "..." {
            return i + 1;
        }
    }
    // 没闭合就不当 frontmatter——否则一篇以 `---` 开头的普通笔记会整篇被吞。
    0
}

/// `[from, to)` 这段里有非空白内容吗。
fn has_content(lines: &[&str], from: usize, to: usize) -> bool {
    let to = to.min(lines.len());
    from < to && lines[from..to].iter().any(|l| !l.trim().is_empty())
}

/// ATX 标题（`## 标题`）。返（层级, 文字）。
fn atx_heading(line: &str) -> Option<(u8, String)> {
    let t = line.trim_end();
    if indent_of(t) > 3 {
        // 缩进 4 格以上是代码块，不是标题。
        return None;
    }
    let s = t.trim_start();
    let hashes = s.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &s[hashes..];
    // `#标题`（没空格）不是标题，`#tag` 这种标签写法得以幸免。
    if !rest.is_empty() && !rest.starts_with(' ') && !rest.starts_with('\t') {
        return None;
    }
    // 尾部的闭合 `#`（`## 标题 ##`）要去掉。
    let text = rest.trim().trim_end_matches('#').trim().to_string();
    Some((hashes as u8, text))
}

/// 围栏行（```` ``` ```` 或 `~~~`）。返（符号, 长度）。
///
/// `pub(super)`：[`super::annotate`] 扫约定行时也要跳过代码块（规则 #11）。
/// 各写一套的后果是「大纲跟类别扫到的围栏不一致」，
/// 而那只在某些嵌套围栏的笔记上才表现出来。
pub(super) fn fence_at(line: &str) -> Option<(char, usize)> {
    let t = line.trim_end();
    if indent_of(t) > 3 {
        return None;
    }
    let s = t.trim_start();
    let ch = s.chars().next()?;
    if ch != '`' && ch != '~' {
        return None;
    }
    let n = s.chars().take_while(|c| *c == ch).count();
    if n < 3 {
        return None;
    }
    Some((ch, n))
}

/// setext 一级的下划线（整行只有 `=`）。
///
/// 只认 `=` 不认 `-`，理由见本文件头部。
fn setext_underline(line: &str) -> bool {
    let t = line.trim_end();
    if indent_of(t) > 3 {
        return false;
    }
    let s = t.trim();
    !s.is_empty() && s.chars().all(|c| c == '=')
}

fn indent_of(t: &str) -> usize {
    t.len() - t.trim_start().len()
}

/// 把 `"架构 / 数据流"` 拆成段。空段丢掉，所以前后多余的 `/` 无害。
fn split_path(p: &str) -> Vec<String> {
    p.split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// `path` 的尾部是不是 `want`。
fn path_ends_with(path: &[String], want: &[String]) -> bool {
    if want.len() > path.len() {
        return false;
    }
    path[path.len() - want.len()..] == *want
}
