//! 应用一次正文级编辑。**纯函数**：进一个字符串出一个字符串，不碰库。
//!
//! 落库的原子性由 `mcp/source.rs` 的 `edit_content` 负责（读—变换—写在同一个
//! `with_store` 闭包里）。把变换抽成纯函数的好处是：所有边界情况都能用字符串单测钉住。

use super::sections::{locate, outline, Section, SectionRef};

/// 插入位置。三个位置全部无歧义——不用 `before: bool`，
/// 因为「插在这一节后面」本身就歧义（标题行之后？还是整节正文之后？）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InsertAt {
    /// 插在**标题行之前**。用于在某节前面新开一节。
    BeforeHeading,
    /// 插在标题行之后、本节正文的**开头**。
    BodyStart,
    /// 插在本节正文的**末尾**（下一个标题之前）。
    BodyEnd,
}

/// 一次正文级编辑。
#[derive(Debug, Clone)]
pub enum ContentEdit {
    /// 替换某一节的**正文**。
    ///
    /// 标题行不动、子节不动。不提供「连标题一起替」：那一口气能删掉标题，
    /// 把后面的子节静默过继给上一节——要重构结构就用整篇的 `kb_update`。
    UpdateSection { locator: SectionRef, body: String },
    /// 在某节的指定位置插入一段。
    InsertAtSection { locator: SectionRef, text: String, at: InsertAt },
    /// 按原文片段替换。**要求唯一匹配**，理由见 [`apply`]。
    ReplaceText { find: String, replace: String },
    /// 插到正文最开头（frontmatter 之后）。
    Prepend { text: String },
}

/// 编辑报告。给模型回话用——它需要知道**到底改了什么、什么没被动**。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditReport {
    /// 人读的一句话。
    pub summary: String,
    /// 未被触及的子节数。`> 0` 时必须告知，
    /// 否则 AI 以为自己重写了整棵子树。
    pub untouched_children: usize,
}

/// 应用编辑。失败时返的字符串是**直接给模型看**的中文文案。
///
/// # `ReplaceText` 为何必须唯一匹配
///
/// 多处匹配时若默认「全部替换」，AI 想改第一处、结果改了七处，而它不会知道。
/// 若默认「只改第一处」，AI 以为改完了、实际还剩六处，同样不知道。
/// **两种默认都是静默的错**（规则 #15.3），所以命中数 ≠ 1 一律报错并告知实际几处。
pub fn apply(content: &str, op: &ContentEdit) -> Result<(String, EditReport), String> {
    match op {
        ContentEdit::UpdateSection { locator, body } => {
            let s = locate(content, locator).map_err(|e| e.to_string())?;
            let lines: Vec<&str> = content.split('\n').collect();
            let out = splice(&lines, s.body_start, s.body_end, body);
            Ok((
                out.join("\n"),
                EditReport {
                    summary: format!("已重写 {} 的正文。", s.label()),
                    untouched_children: s.child_count,
                },
            ))
        }

        ContentEdit::InsertAtSection { locator, text, at } => {
            if text.trim().is_empty() {
                // 空插入不当成功：否则模型以为它写进去了（规则 #15.3）。
                return Err("要插入的内容是空的，没有执行任何修改。".into());
            }
            let s = locate(content, locator).map_err(|e| e.to_string())?;
            let lines: Vec<&str> = content.split('\n').collect();
            let at_line = insert_line(&s, *at);
            let out = splice(&lines, at_line, at_line, text);
            Ok((
                out.join("\n"),
                EditReport {
                    summary: format!("已在 {} 的{}插入一段。", s.label(), at.label()),
                    untouched_children: 0,
                },
            ))
        }

        ContentEdit::ReplaceText { find, replace } => {
            if find.is_empty() {
                return Err("find 不能为空。".into());
            }
            let (pat, hits) = match_variant(content, find);
            match hits {
                1 => Ok((
                    content.replacen(&pat, replace, 1),
                    EditReport {
                        summary: "已替换 1 处。".into(),
                        untouched_children: 0,
                    },
                )),
                0 => Err("正文里找不到这段原文，没有执行任何修改。\
                          请先用 kb_read 取回当前正文，照原文一字不改地拷 find。"
                    .into()),
                n => Err(format!(
                    "这段原文在笔记里出现了 {} 处，无法确定要改哪一处，所以**一处也没改**。\
                     请把 find 向前后加长到全文唯一再试，或改用 kb_update_section 改指定的一节。",
                    n
                )),
            }
        }

        ContentEdit::Prepend { text } => {
            if text.trim().is_empty() {
                return Err("要插入的内容是空的，没有执行任何修改。".into());
            }
            let lines: Vec<&str> = content.split('\n').collect();
            // 不能直接插在第 0 行：若有 frontmatter，那会把它撑坏。
            // 大纲的第一节天然就在 frontmatter 之后，直接拿它的起点。
            let first = outline(content);
            let at = first
                .first()
                .map(|s| s.heading_line.unwrap_or(s.body_start))
                .unwrap_or(0);
            let out = splice(&lines, at, at, text);
            Ok((
                out.join("\n"),
                EditReport {
                    summary: "已插到正文开头。".into(),
                    untouched_children: 0,
                },
            ))
        }
    }
}

impl InsertAt {
    fn label(self) -> &'static str {
        match self {
            InsertAt::BeforeHeading => "标题之前",
            InsertAt::BodyStart => "正文开头",
            InsertAt::BodyEnd => "正文末尾",
        }
    }
}

fn insert_line(s: &Section, at: InsertAt) -> usize {
    match at {
        // 引言节没有标题行，「标题之前」就是正文开头。
        InsertAt::BeforeHeading => s.heading_line.unwrap_or(s.body_start),
        InsertAt::BodyStart => s.body_start,
        InsertAt::BodyEnd => s.body_end,
    }
}

/// 把 `[from, to)` 换成 `new_text`，并**自动维护段落间的空行**。
///
/// 空行不是美观问题。Markdown 里两个段落没空行隔开会**渲染成同一段**，
/// `## 标题` 紧贴上一行文字也可能不再被当标题。插入后排版静默塌陷，
/// 正是「AI 改完看着像对的、实际坏了」那一类。
fn splice(lines: &[&str], from: usize, to: usize, new_text: &str) -> Vec<String> {
    let from = from.min(lines.len());
    let to = to.clamp(from, lines.len());

    let mut out: Vec<String> = lines[..from].iter().map(|s| s.to_string()).collect();
    let tail: Vec<String> = lines[to..].iter().map(|s| s.to_string()).collect();

    // 插入块自带的首尾空行先去掉，空行统一由下面补——
    // 否则反复插入会攒出一堆空行。
    let mut mid: Vec<String> = new_text.split('\n').map(|s| s.to_string()).collect();
    while mid.first().is_some_and(|l| l.trim().is_empty()) {
        mid.remove(0);
    }
    while mid.last().is_some_and(|l| l.trim().is_empty()) {
        mid.pop();
    }

    let head_needs_gap = out.last().is_some_and(|l| !l.trim().is_empty());
    let tail_needs_gap = tail.first().is_some_and(|l| !l.trim().is_empty());

    if mid.is_empty() {
        // 清空一节的正文：标题行与下一个标题之间仍要留一个空行。
        if head_needs_gap && tail_needs_gap {
            out.push(String::new());
        }
    } else {
        if head_needs_gap {
            out.push(String::new());
        }
        out.extend(mid);
        if tail_needs_gap {
            out.push(String::new());
        }
    }

    out.extend(tail);
    out
}

/// 找出 `find` 在 `content` 里真正能匹配的形式，以及命中几处。
///
/// # 为何需要这一层
///
/// 🔴 剪贴板内容在 Windows 上**大量是 CRLF**，而 AI 发来的 `find` 几乎必然是 LF。
/// 直接字符串匹配会得到「找不到」——而那段原文就在那里、AI 刚刚还读过。
/// 这类「看得见、改不了」最让模型困惑而反复重试，而每次重试都失败。
///
/// 做法：按原样 → 全换 CRLF → 全换 LF 依次试，用第一个能命中的形式。
/// 三种都不命中就真的是没这段文字，那时报「找不到」才是准确的。
fn match_variant(content: &str, find: &str) -> (String, usize) {
    let crlf = find.replace("\r\n", "\n").replace('\n', "\r\n");
    let lf = find.replace("\r\n", "\n");
    for pat in [find.to_string(), crlf, lf] {
        let n = content.matches(&pat).count();
        if n > 0 {
            return (pat, n);
        }
    }
    (find.to_string(), 0)
}
