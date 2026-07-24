//! tree-sitter 语言仲裁层（方案 B）
//!
//! 对规则引擎判定为"代码但语言存疑"的片段，用真实语法解析做二次裁定：
//! 依次用候选语言的语法解析片段，统计 ERROR/MISSING 节点覆盖的字节占比，
//! 错误率最低且低于阈值的语言胜出。解析器是"这段代码在该语言里是否合法"的
//! 权威裁判，可消除关键词计分在 C 系语言（JS/TS/Java）之间的互串。
//!
//! 性能约束：仅在规则引擎低置信时触发，输入截断到 4KB，单条耗时约 1~3ms。

use tree_sitter::{Language, Node, Parser};

/// 仲裁输入最大字节数（超过截断，防御畸形长内容拖慢解析）
const MAX_ARBITRATE_BYTES: usize = 4096;

/// 胜出语言的错误率上限；高于此值视为"没有语言能良好解析"，返回 None
const MAX_ERROR_RATIO: f64 = 0.25;

struct GrammarDef {
    /// 与 LANGUAGE_PROFILES 一致的语言标签
    label: &'static str,
    /// 语法构造器（惰性调用，避免启动时一次性构造全部 Language）
    language: fn() -> Language,
}

const GRAMMARS: &[GrammarDef] = &[
    GrammarDef {
        label: "Python",
        language: || Language::new(tree_sitter_python::LANGUAGE),
    },
    GrammarDef {
        label: "JavaScript",
        language: || Language::new(tree_sitter_javascript::LANGUAGE),
    },
    GrammarDef {
        label: "TypeScript",
        language: || Language::new(tree_sitter_typescript::LANGUAGE_TYPESCRIPT),
    },
    GrammarDef {
        label: "Rust",
        language: || Language::new(tree_sitter_rust::LANGUAGE),
    },
    GrammarDef {
        label: "Java",
        language: || Language::new(tree_sitter_java::LANGUAGE),
    },
    GrammarDef {
        label: "Go",
        language: || Language::new(tree_sitter_go::LANGUAGE),
    },
    GrammarDef {
        label: "SQL",
        language: || Language::new(tree_sitter_sequel::LANGUAGE),
    },
    GrammarDef {
        label: "HTML",
        language: || Language::new(tree_sitter_html::LANGUAGE),
    },
    GrammarDef {
        label: "CSS",
        language: || Language::new(tree_sitter_css::LANGUAGE),
    },
    GrammarDef {
        label: "Shell",
        language: || Language::new(tree_sitter_bash::LANGUAGE),
    },
];

/// 仲裁代码片段的语言。
///
/// `candidates` 为规则引擎按得分排序的候选标签（只传得分 > 0 的，
/// 避免 HTML/Bash 等宽松语法在无关文本上以零错误率"赢过"真实语言）。
/// 返回错误率最低的语言；无人低于阈值或无法解析时返回 None（调用方回退规则结果）。
pub fn arbitrate(text: &str, candidates: &[&str]) -> Option<&'static str> {
    if candidates.is_empty() {
        return None;
    }
    let snippet = clip(text);

    let mut best: Option<(&'static str, f64)> = None;
    for label in candidates {
        let Some(def) = GRAMMARS.iter().find(|g| &g.label == label) else {
            continue;
        };
        let Some(ratio) = error_ratio(def, snippet) else {
            continue;
        };
        // 严格小于 → 平局时保留先出现的候选（即规则得分更高者）
        if best.map_or(true, |(_, r)| ratio < r) {
            best = Some((def.label, ratio));
        }
    }

    match best {
        Some((label, ratio)) if ratio < MAX_ERROR_RATIO => Some(label),
        _ => None,
    }
}

/// 计算某语言语法解析该文本的错误字节占比（0.0 = 完美解析）
fn error_ratio(def: &GrammarDef, text: &str) -> Option<f64> {
    let language = (def.language)();
    let mut parser = Parser::new();
    parser.set_language(&language).ok()?;
    let tree = parser.parse(text, None)?;
    let root = tree.root_node();

    // 快速路径：无任何错误节点
    if !root.has_error() {
        return Some(0.0);
    }

    let total = root.end_byte().max(1) as f64;
    let mut error_bytes = 0usize;
    collect_error_bytes(root, &mut error_bytes);
    Some((error_bytes as f64 / total).min(1.0))
}

/// 递归统计 ERROR/MISSING 节点覆盖的字节数。
/// 命中错误节点后不再深入其子树（避免一个错误根节点下的合法子节点被重复计数）。
fn collect_error_bytes(node: Node, error_bytes: &mut usize) {
    if node.is_error() || node.is_missing() {
        *error_bytes += node.end_byte().saturating_sub(node.start_byte());
        return;
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_error_bytes(child, error_bytes);
    }
}

/// 按 UTF-8 字符边界截断到 MAX_ARBITRATE_BYTES
fn clip(text: &str) -> &str {
    if text.len() <= MAX_ARBITRATE_BYTES {
        return text;
    }
    let mut end = MAX_ARBITRATE_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_smoke_js_parses_cleanly() {
        // 依赖冒烟：JS 语法能零错误解析合法代码
        let ratio = error_ratio(&GRAMMARS[1], "const x = foo();").unwrap();
        assert_eq!(ratio, 0.0);
    }

    #[test]
    fn test_disambiguate_ts_from_java() {
        // TS 接口：TS 语法零错误，Java 语法报错（name: string 非合法 Java）
        let text = "interface User {\n  name: string;\n  age: number;\n}";
        let winner = arbitrate(text, &["TypeScript", "Java"]);
        assert_eq!(winner, Some("TypeScript"));
    }

    #[test]
    fn test_disambiguate_java_from_ts() {
        // Java 接口方法签名：Java 零错误，TS 报错（void process(...) 非合法 TS 签名）
        let text = "public interface PaymentService {\n  void process(Order order);\n}";
        let winner = arbitrate(text, &["TypeScript", "Java"]);
        assert_eq!(winner, Some("Java"));
    }

    #[test]
    fn test_single_line_sql() {
        let winner = arbitrate("select id, name from users where id = 1", &["SQL", "JavaScript"]);
        assert_eq!(winner, Some("SQL"));
    }

    #[test]
    fn test_garbage_returns_none() {
        // 无语言能良好解析 → None（调用方回退规则结果）
        // 注意避开 # 等字符——Python 会把 # 之后当注释，导致错误率虚低
        let winner = arbitrate("!!! === ,,, ::: !!!", &["JavaScript", "Python"]);
        assert_eq!(winner, None);
    }

    #[test]
    fn test_empty_candidates() {
        assert_eq!(arbitrate("const x = 1;", &[]), None);
    }

    #[test]
    fn test_unknown_label_skipped() {
        // 未知标签被跳过，不报错
        let winner = arbitrate("const x = foo();", &["不存在的语言", "JavaScript"]);
        assert_eq!(winner, Some("JavaScript"));
    }

    #[test]
    fn test_clip_respects_char_boundary() {
        let text = "码".repeat(2000); // 每字符 3 字节，共 6000 字节
        let clipped = clip(&text);
        assert!(clipped.len() <= MAX_ARBITRATE_BYTES);
        assert!(clipped.chars().count() > 0);
    }

    #[test]
    fn test_rust_wins_over_go() {
        let text = "fn main() {\n    let mut v = Vec::new();\n    v.push(1);\n    println!(\"{:?}\", v);\n}";
        let winner = arbitrate(text, &["Go", "Rust"]);
        assert_eq!(winner, Some("Rust"));
    }
}
