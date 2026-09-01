//! data_store/note_md.rs —— 笔记 ↔ Markdown 文本的互转（B1 #5 / D1）。
//!
//! 设计稿：design/PastePanda-MD导出导入-设计稿.html §3。
//!
//! # 为什么生成与解析写在同一个文件
//!
//! 它们是同一份格式约定的两面。分开放的结果是改了写忘了改读，
//! 而这个 bug 的表现是「导出再导回来，标签没了」——没人会立刻发现。
//!
//! # 为什么不引 YAML 库
//!
//! 写只需要三条转义规则；**读只需要认 5 个已知字段**，其余行直接忽略
//! （这正好让外部编辑器加的字段不会把导入弄挂）。引一个完整解析器换来的
//! 是它对错误缩进的整套报错语义，而那些情况我们反正都要降级成「当没有 frontmatter」。

use super::*;

/// 从 Markdown 文本里读出来的一篇笔记。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ParsedNote {
    pub title: String,
    pub tags: Vec<String>,
    /// 导出时写的 `pastepanda_id`。外部新建的文件没有它。
    pub id: Option<String>,
    pub content: String,
}

/// YAML 标量值的转义。规则就三条（设计稿 §3）。
fn yaml_scalar(v: &str) -> String {
    const RISKY_FIRST: &[char] = &[
        '[', ']', '{', '}', '-', '?', '&', '*', '!', '|', '>', '%', '@', '`', ',', '"', '\'',
    ];
    let needs_quote = v.is_empty()
        || v.contains(": ")
        || v.ends_with(':')
        || v.contains('#')
        || v.contains('\n')
        || v.contains('"')
        || v.trim() != v
        || v.chars().next().is_some_and(|c| RISKY_FIRST.contains(&c));

    if !needs_quote {
        return v.to_string();
    }
    let mut out = String::with_capacity(v.len() + 2);
    out.push('"');
    for c in v.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// 反向：去掉引号与转义。不合法的就原样返回（降级优于报错）。
fn yaml_unscalar(v: &str) -> String {
    let v = v.trim();
    if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
        let inner = &v[1..v.len() - 1];
        let mut out = String::with_capacity(inner.len());
        let mut esc = false;
        for c in inner.chars() {
            if esc {
                match c {
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    other => out.push(other),
                }
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else {
                out.push(c);
            }
        }
        return out;
    }
    if v.len() >= 2 && v.starts_with('\'') && v.ends_with('\'') {
        return v[1..v.len() - 1].replace("''", "'");
    }
    v.to_string()
}

/// 笔记 → 带 frontmatter 的 Markdown 全文。
///
/// 导出与前端的「复制为 Markdown」走的是同一个函数（规则 #11），
/// 否则两个出口的格式会慢慢漂成两种。
///
/// `with_id` 为 false 时不写 `pastepanda_id`：复制到剪贴板是给人看的，
/// 带一串 uuid 只是噪音；导出成文件才需要它来回写。
pub fn note_to_markdown(note: &Note, with_id: bool) -> String {
    let tags: Vec<String> = note.tags.iter().map(|t| t.name.clone()).collect();
    to_markdown(MdOut {
        title: &note.title,
        content: &note.content,
        tags: &tags,
        created: &note.created_at,
        updated: &note.updated_at,
        id: if with_id { Some(&note.id) } else { None },
    })
}

/// 生成侧的入参。存在的理由：**剪贴板那条路拿不到 `Note`**——
/// 用户可能正在改一篇还没保存的笔记，或者干脆还没建库。
/// 但它与导出共用同一个函数体（规则 #11）。
pub struct MdOut<'a> {
    pub title: &'a str,
    pub content: &'a str,
    pub tags: &'a [String],
    /// 空字符串 = 不输出这一行
    pub created: &'a str,
    pub updated: &'a str,
    pub id: Option<&'a str>,
}

pub fn to_markdown(v: MdOut) -> String {
    let mut s = String::from("---\n");
    s.push_str(&format!("title: {}\n", yaml_scalar(v.title)));

    // 块式列表而不是 [a, b]：标签名里有逗号或方括号时，后者直接碎。
    if !v.tags.is_empty() {
        s.push_str("tags:\n");
        for t in v.tags {
            s.push_str(&format!("  - {}\n", yaml_scalar(t)));
        }
    }
    if !v.created.is_empty() {
        s.push_str(&format!("created: {}\n", yaml_scalar(v.created)));
    }
    if !v.updated.is_empty() {
        s.push_str(&format!("updated: {}\n", yaml_scalar(v.updated)));
    }
    if let Some(id) = v.id {
        s.push_str(&format!("pastepanda_id: {id}\n"));
    }
    s.push_str("---\n\n");
    s.push_str(v.content);
    s
}

/// Markdown 全文 → 笔记。`fallback_title` 是文件名（去 .md）。
///
/// **任何解析失败都降级为「整文当正文」而不是报错**：
/// 一个文件的 frontmatter 坏了，不该让整次导入停下来（设计稿 §4）。
pub fn markdown_to_note(text: &str, fallback_title: &str) -> ParsedNote {
    let plain = |content: &str| ParsedNote {
        title: fallback_title.to_string(),
        tags: Vec::new(),
        id: None,
        content: content.trim_start_matches('\n').to_string(),
    };

    // BOM 会让首行匹不上 "---"，而 Windows 上的编辑器常常写它
    let text = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let Some(rest) = text.strip_prefix("---\n") else {
        return plain(&text);
    };
    // 不闭合 ⇒ 当没有 frontmatter
    let Some(end) = rest.find("\n---") else {
        return plain(&text);
    };

    let head = &rest[..end];
    let body = rest[end + 4..].trim_start_matches('\n');

    let mut out = ParsedNote {
        content: body.to_string(),
        ..Default::default()
    };
    let mut in_tags = false;

    for line in head.lines() {
        // 块式列表项：只在 tags: 之后才算
        if in_tags {
            if let Some(item) = line.trim_start().strip_prefix("- ") {
                let t = yaml_unscalar(item);
                if !t.is_empty() {
                    out.tags.push(t);
                }
                continue;
            }
            if line.starts_with(' ') || line.starts_with('\t') {
                continue; // 属于 tags 的其它缩进行，忽略
            }
            in_tags = false;
        }

        let Some((k, v)) = line.split_once(':') else {
            continue; // 认不出的行直接跳过（外部工具加的字段不能弄挂导入）
        };
        match k.trim() {
            "title" => out.title = yaml_unscalar(v),
            "pastepanda_id" => {
                let id = yaml_unscalar(v);
                out.id = if id.is_empty() { None } else { Some(id) };
            }
            "tags" => {
                let inline = v.trim();
                if inline.is_empty() {
                    in_tags = true; // 块式，标签在下几行
                } else {
                    // 兼容行内数组 [a, b]（旧版 noteToMarkdown 写的就是这个，
                    // 且 Obsidian 自己也常用）
                    let body = inline.trim_start_matches('[').trim_end_matches(']');
                    out.tags = body
                        .split(',')
                        .map(|t| yaml_unscalar(t))
                        .filter(|t| !t.is_empty())
                        .collect();
                }
            }
            _ => {} // created / updated 不导回来：库里的时间戳是库自己的事
        }
    }

    if out.title.trim().is_empty() {
        out.title = fallback_title.to_string();
    }
    out
}

/// 把标题变成合法文件名（不带 .md）。
///
/// 不可逆——所以导回来时**不靠文件名认人**，靠 frontmatter 的 id（设计稿 §2）。
pub fn safe_file_stem(title: &str, id: &str) -> String {
    const ILLEGAL: &[char] = &['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
    let cleaned: String = title
        .chars()
        .map(|c| {
            if ILLEGAL.contains(&c) || (c as u32) < 0x20 {
                '_'
            } else {
                c
            }
        })
        .collect();
    // Windows 不允许以空格或点结尾
    let cleaned = cleaned.trim().trim_end_matches('.').trim();
    if cleaned.is_empty() {
        return format!("无标题-{}", id.chars().take(8).collect::<String>());
    }
    // 截长：Windows 路径总长 260，三层文件夹加长标题很容易碰到
    cleaned.chars().take(80).collect()
}
