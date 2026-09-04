//! 正文里的**约定行**（AM-7 记忆类型）。
//!
//! # 语法
//!
//! ```markdown
//! - [decision] 新工具复用现有开关档位，不新增 WriteKind
//! - [fact] tools/list 序列化后 13622 字节
//! - [todo] 要建召回基准
//! ```
//!
//! 取 Basic Memory 的行内写法而不是容器层级，理由在设计文档 AM-7：
//! **一篇会议纪要里本来就同时含着决定、事实和待办**，
//! 做成容器就强迫它只能选一个。
//!
//! # 🔴 与任务复选框 100% 撞车
//!
//! `- [todo]` 和 Markdown 任务复选框 `- [ ]` / `- [x]` 同形。
//! 本机库实测：形如 `- [X] 文字` 的命中里 **3/3 全是任务复选框**，
//! 剔除后真正的类别命中 **0**（2026-09-04，25 篇活笔记）。
//!
//! 所以排除规则不是防御性编程，是**已经躺在库里的数据**逼出来的。
//! 判定收口在 [`is_kind_label`] 一处——AM-3 将来加 relation 行时复用它，
//! 不要再写一份「哪些方括号算类别」。

use super::sections::fence_at;

/// 一条行内观察。
#[derive(Debug, Clone, PartialEq)]
pub struct Observation {
    /// 类别名，已归一化为小写。
    pub kind: String,
    /// 方括号之后的正文，已 trim。
    pub text: String,
    /// 所在行号（0 起）。
    pub line: usize,
}

/// 类别名长度上限（字符）。超了就不是类别，是别的语法。
///
/// 12 的来历：`decision` / `question` / `技术选型` 这类词都在 8 以内，
/// 留一点余量；再长的方括号内容基本都是链接标题或引用标记。
const MAX_KIND_CHARS: usize = 12;

/// 方括号里的串能不能当类别名？
///
/// 🔴 **这是本模块唯一的判定出口**（规则 #11）。四条排除，每条都有具体的撞车对象：
///
/// | 排除 | 撞的是 |
/// |---|---|
/// | 空串 / 纯空白 | 任务复选框 `- [ ]` |
/// | 单个 `x` / `X` | 任务复选框 `- [x]` |
/// | 含空白字符 | `- [my note]` 这类裸链接/引用标题 |
/// | 含 `[A-Za-z0-9_-]` 与中文之外的字符，或超长 | 脚注 `[^1]`、链接 `[见 §3](..)` 等 |
pub fn is_kind_label(inner: &str) -> bool {
    if inner.is_empty() || inner.chars().any(char::is_whitespace) {
        return false;
    }
    if inner == "x" || inner == "X" {
        return false;
    }
    let n = inner.chars().count();
    if n > MAX_KIND_CHARS {
        return false;
    }
    inner.chars().all(is_kind_char)
}

/// 类别名允许的字符：ASCII 字母数字、`_`、`-`、中日韩统一表意文字。
///
/// 中文范围只取基本区与扩展 A：够用，且不会把标点、表情、全角符号放进来
/// ——那些出现在方括号里时，几乎一定不是类别。
fn is_kind_char(c: char) -> bool {
    c.is_ascii_alphanumeric()
        || c == '_'
        || c == '-'
        || matches!(c, '\u{3400}'..='\u{4DBF}' | '\u{4E00}'..='\u{9FFF}')
}

/// 扫一篇正文里的所有约定行。
///
/// ❗ **跳过代码块**：围栏判定复用 [`fence_at`]，与 `outline` 同一份，
/// 否则「大纲认为在代码块里、类别扫描认为不在」这种不一致
/// 只会在某些嵌套围栏的笔记上才冒出来。
pub fn parse_observations(content: &str) -> Vec<Observation> {
    let mut out = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    for (i, line) in content.split('\n').enumerate() {
        if let Some((ch, n)) = fence_at(line) {
            match fence {
                None => fence = Some((ch, n)),
                Some((fc, fl)) if fc == ch && n >= fl => fence = None,
                _ => {}
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        if let Some((kind, text)) = observation_at(line) {
            out.push(Observation {
                kind,
                text,
                line: i,
            });
        }
    }
    out
}

/// 解析单行。不是约定行就返 `None`。
fn observation_at(line: &str) -> Option<(String, String)> {
    let s = line.trim_start();
    // 列表符号后必须有空白：`-[x]` 不是列表项。
    let rest = s
        .strip_prefix("- ")
        .or_else(|| s.strip_prefix("* "))
        .or_else(|| s.strip_prefix("+ "))?;
    let rest = rest.trim_start();
    let inner_end = rest.strip_prefix('[')?.find(']')?;
    let inner = &rest[1..=inner_end];
    if !is_kind_label(inner) {
        return None;
    }
    let text = rest[inner_end + 2..].trim();
    // 类别后面没内容的不算观察：`- [note]` 这种孤零零的方括号多半是
    // 链接引用或占位，把它当成「记了一条 note」会凭空造出命中。
    if text.is_empty() {
        return None;
    }
    Some((inner.to_lowercase(), text.to_string()))
}

/// 一篇正文里出现过的类别（去重，保持首次出现顺序）。
///
/// `kb_search` 的 `kind` 筛选用它——**筛选只看有没有，不看有几条**：
/// 「这篇里记过决定吗」是个是非题，出现次数不改变答案。
pub fn kinds_of(content: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for o in parse_observations(content) {
        if !out.contains(&o.kind) {
            out.push(o.kind);
        }
    }
    out
}
