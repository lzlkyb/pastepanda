//! 节级相关性打分（AM-2）。
//!
//! # 它解决的问题
//!
//! `kb_search` 命中一篇后只回 200 字摘要，而本机库**平均一篇 9,043 字、中位 5,425 字**
//! （2026-09-04 实测 25 篇）。命中一篇 9,000 字的笔记只拿到 200 字 ≈ 什么都没拿到——
//! AI 要么据此瞎猜，要么再花一轮 `kb_read` 把全文拉回来，那更糟。
//!
//! 所以命中之后，**在篇内再定位到最相关的那几节**。
//!
//! # 边界
//!
//! 🔴 **本模块不改变「哪些篇被命中」**：BM25 仍在篇级跑（`notes_fts` 不动），
//! 这里只是纯叠加的返回层增强。做错了从行为上看得出来，不需要召回基准。
//!
//! 切词**不自己写**，用 `data_store::question_terms` 的同一份结果（规则 #11 收口）。
//! 各写一套的后果是「篇级命中了、节级一节都不命中」变成常态。

use super::sections::{outline, slice, Section};

/// 一条节级命中。
#[derive(Debug, Clone, PartialEq)]
pub struct SectionHit {
    /// 对应 [`Section::index`]，可直接喂给 `kb_read(section=)`。
    pub index: usize,
    /// 标题文字；引言节为空串。
    pub heading: String,
    /// 从根到本节的标题路径。
    pub path: Vec<String>,
    /// 相关性分。只用于排序，不对外承诺量纲。
    pub score: f32,
    /// 命中附近的上下文窗口。
    pub excerpt: String,
}

/// 摘录窗口（字符）。
const EXCERPT_CHARS: usize = 160;
/// 命中落在正文前这么多字内算「导语」。
const LEAD_CHARS: usize = 120;
/// 标题命中一个词的权重。标题命中通常就是主题命中——与 `bm25(notes_fts, 10.0, …)`
/// 给标题列 10 倍权重同源，只是这里的量纲小得多（那边是列权重，这边是加分）。
const TITLE_WEIGHT: f32 = 3.0;
/// 导语命中的额外加分。
const LEAD_WEIGHT: f32 = 1.5;

/// 只把 ASCII 转小写：**保持字符数与字节长度不变**，
/// 这样 `find` 拿到的字节偏移在原串上仍然有效（中文不受影响）。
fn fold(s: &str) -> String {
    s.chars().map(|c| c.to_ascii_lowercase()).collect()
}

/// 给一篇正文的各节打分，返回分最高的前 `top` 节（0 分的不返回）。
///
/// `terms` 传 `data_store::question_terms` 的输出（裸词，ASCII 不带 `*`）。
pub fn rank_sections(content: &str, terms: &[String], top: usize) -> Vec<SectionHit> {
    if terms.is_empty() || top == 0 {
        return Vec::new();
    }
    let folded: Vec<String> = terms.iter().map(|t| fold(t)).filter(|t| !t.is_empty()).collect();
    if folded.is_empty() {
        return Vec::new();
    }

    let mut hits: Vec<SectionHit> = Vec::new();
    for sec in outline(content) {
        if let Some(h) = score_one(content, &sec, &folded) {
            hits.push(h);
        }
    }
    // 分数降序；同分按出现顺序（index 升序）稳定排列——
    // 同分时先出现的更可能是导语/总述，排前面更有用。
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.index.cmp(&b.index))
    });
    hits.truncate(top);
    hits
}

fn score_one(content: &str, sec: &Section, folded: &[String]) -> Option<SectionHit> {
    let body = slice(content, sec, false);
    let body_f = fold(&body);
    let head_f = fold(&sec.heading);

    let mut score = 0.0f32;
    let mut first_at: Option<usize> = None;

    for t in folded {
        if !head_f.is_empty() && head_f.contains(t.as_str()) {
            score += TITLE_WEIGHT;
        }
        let n = body_f.matches(t.as_str()).count();
        if n == 0 {
            continue;
        }
        // 对数压缩：长节里同一个词出现二十次，不该压过短节里出现两次的那条。
        score += (1.0 + n as f32).ln();

        if let Some(byte_at) = body_f.find(t.as_str()) {
            let char_at = body_f[..byte_at].chars().count();
            if char_at < LEAD_CHARS {
                score += LEAD_WEIGHT;
            }
            first_at = Some(match first_at {
                Some(prev) => prev.min(char_at),
                None => char_at,
            });
        }
    }

    // ❗ 一个词都不在正文里就不返回：只靠标题命中的节，正文可能与查询毫无关系，
    //   给出去等于让模型去读一段无关内容。
    let first_at = first_at?;

    Some(SectionHit {
        index: sec.index,
        heading: sec.heading.clone(),
        path: sec.path.clone(),
        score,
        excerpt: excerpt_around(&body, first_at),
    })
}

/// 取命中位置附近的一个窗口，前后有截断就加省略号。
fn excerpt_around(body: &str, char_at: usize) -> String {
    let chars: Vec<char> = body.chars().collect();
    if chars.len() <= EXCERPT_CHARS {
        return body.trim().to_string();
    }
    // 让命中点大致居中，但不越界。
    let half = EXCERPT_CHARS / 4;
    let start = char_at.saturating_sub(half);
    let end = (start + EXCERPT_CHARS).min(chars.len());
    let start = end.saturating_sub(EXCERPT_CHARS).min(start);

    let mut s = String::new();
    if start > 0 {
        s.push('…');
    }
    s.push_str(chars[start..end].iter().collect::<String>().trim());
    if end < chars.len() {
        s.push('…');
    }
    s
}
