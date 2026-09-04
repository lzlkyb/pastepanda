//! 正文里的 wiki 链 `[[标题]]`（O-2 / M3-④）。
//!
//! # 链的目标是**标题**，不是 id
//!
//! 这不是选择，是既有事实：`note.rs` 的 O-9 注释写着
//! 「wiki 链按**标题**存（`[[标题]]`，不含 id、不含路径）」，
//! 而 `rewrite_wiki_links_on` 就是靠 `REPLACE(content, '[[旧]]', '[[新]]')` 改名时跟随的。
//!
//! 两个后果都得认：
//! - 换文件夹**不**断链（链里没有路径）
//! - 改标题**会**断链，靠 O-9 的全库重写兜住
//!
//! # 🔴 为什么不认 `[[标题|别名]]`
//!
//! 因为 O-9 的重写是**字面** `[[旧标题]]` → `[[新标题]]`。
//! 若这里把 `[[A|别名]]` 解析成指向 A，改名时那句 REPLACE 匹配不上它——
//! 于是**链表说链在，正文里其实已经断了**，而两边都不报错。
//! 宁可不把它当链（少一条记录），也不要一条永久错的记录。
//!
//! 与既有重写机制保持一致，比兼容 Obsidian 的写法重要。
//! 真要支持，得连 O-9 一起改，那是另一件事。
//!
//! ❗ `#` **不**排除：`[[C# 笔记]]` 里那个 `#` 是标题的一部分。
//! 整个方括号内容就是目标标题，不解析 Obsidian 的 `#节` 语义——
//! 理由同上，而且标题本身就可能带 `#`。

use super::sections::fence_at;

/// 一条出链。
#[derive(Debug, Clone, PartialEq)]
pub struct WikiLink {
    /// 方括号里的原文（已 trim）。就是目标笔记的标题。
    pub target: String,
    /// 所在行号（0 起）。
    pub line: usize,
}

/// 标题长度上限（字符）。超过就不当链——`notes.title` 现实里不会这么长，
/// 而正文里一长串 `[[...]]` 更可能是别的语法或粘贴事故。
const MAX_TARGET_CHARS: usize = 200;

/// 扫出一篇正文里的所有 wiki 链，**按出现顺序、去重后**返回。
///
/// ❗ 跳过代码块，围栏判定复用 [`fence_at`]（与 `outline` / `annotate` 同一份，规则 #11）。
/// 教人怎么写 `[[链接]]` 的代码示例不该产生真链。
pub fn parse_links(content: &str) -> Vec<WikiLink> {
    let mut out: Vec<WikiLink> = Vec::new();
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
        for target in targets_in_line(line) {
            // 同一篇里重复引用同一个目标只算一条链：
            // 反链面板要的是「谁引用了我」，不是「引用了几次」。
            if !out.iter().any(|l| l.target == target) {
                out.push(WikiLink { target, line: i });
            }
        }
    }
    out
}

/// 扫一行里的 `[[...]]`。
fn targets_in_line(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let b = line.as_bytes();
    let mut i = 0usize;
    while i + 3 < b.len() {
        if b[i] != b'[' || b[i + 1] != b'[' {
            i += 1;
            continue;
        }
        let rest = &line[i + 2..];
        let Some(end) = rest.find("]]") else { break };
        let inner = rest[..end].trim();
        // 排除三种：空、跨行（不可能有，但便宜）、以及带 `|` / `#` 的——见模块文档。
        let bad = inner.is_empty()
            || inner.chars().count() > MAX_TARGET_CHARS
            || inner.contains('|')
            || inner.contains('\r')
            || inner.contains('[')
            || inner.contains(']');
        if !bad {
            out.push(inner.to_string());
        }
        i += 2 + end + 2;
    }
    out
}
