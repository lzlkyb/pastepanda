//! 切片层（O-4）：把一篇笔记切成【可寻址、可重算】的块。
//!
//! 口径定案见 `docs/O-4-切片层定案.md`，本模块是它的实现。一句话：
//! **切片 = section，超窗口的 section 再切**，坐标沿用 AM-2 的节层。
//!
//! # 为什么不另起一套坐标
//!
//! `section_index` 同时是 AM-2 节级命中与 O-8 精准编辑的地址。切片另搞一套的话，
//! 同一段文字在三处有三个地址，而它们还要互相翻译。
//!
//! # 🔴 最要紧的一条：切片 ID 必须可重算
//!
//! `(note_id, section_index, sub_index)` + [`Chunk::content_hash`]，**不能用自增**。
//! 用自增主键的话，重新切一遍就得全量重算向量——那正是 O-4 要避免的那个「全库重建」。
//!
//! 同理 [`content_hash`] 用 MD5 而不是 `DefaultHasher`：后者的值跨 Rust 版本
//! **不保证稳定**，而这个 hash 要落库、要跨版本拿来判「这个切片变了没」——
//! 升一次编译器就全库 hash 变，等于同一个坑换个姿势踩。
//!
//! # 不落库
//!
//! 切片**文本**不落库，纯运行时算（与 section 层一致）。将来落库的是切片**向量**，
//! 那是 M3-① `note_chunks` 的事；建表时照 [`Chunk::id`] 的形状做复合主键即可。

use super::sections::{outline, slice, Section};
use md5::{Digest, Md5};

/// 切片窗口（字符数）。
///
/// ⚠ **未经实测验证**：512 来自 bge-small-zh 的窗口（中文粗估 1 字 ≈ 1 token）。
/// 真正能验证它的是 AM-5 召回基准。
///
/// ❗ 改它会改变切片边界 → `content_hash` 变 → 向量需重算。**要改就在向量入库之前改。**
pub const CHUNK_WINDOW: usize = 512;

/// 硬切时相邻切片的重叠（字符数）。同样未经验证，64 是常见经验值。
///
/// 🔴 **只在硬切时加，段落装箱时不加**——这是实现时对定案的一层细化：
/// 段落边界本来就是语义边界，在那里重叠只会把同一段话算两遍向量；
/// 而硬切切在句子中间，重叠才能把被切断的语义救回来。
pub const CHUNK_OVERLAP: usize = 64;

/// 一个切片。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    /// 所属节序号，= [`Section::index`]。`0` 为引言节。
    pub section_index: usize,
    /// 节内再切的序号。**不再切时恒为 0**。
    pub sub_index: usize,
    /// 节标题；引言节为空串。
    pub heading: String,
    /// 从根到本节的标题路径。定案 §7 要求「每个切片都能反查到它的节标题路径」。
    pub path: Vec<String>,
    /// 切片正文。**不做 trim**，与 `char_start..char_end` 精确对应。
    pub text: String,
    /// 在【本节正文】内的字符偏移（含）。不是全文偏移。
    pub char_start: usize,
    /// 字符偏移终点（**不含**）。
    pub char_end: usize,
    /// 切片正文的 MD5。判「这个切片变了没」就看它。
    pub content_hash: String,
    /// 上下文增强卡片。**本次恒为 `None`，只留位**（定案 §5）。
    ///
    /// 它【不参与 `content_hash`】——否则开关一切换就全库重算向量。
    pub context_card: Option<String>,
}

impl Chunk {
    /// 可重算的确定性 ID。将来 `note_chunks` 的复合主键就是这三个字段。
    pub fn id(&self, note_id: &str) -> String {
        format!("{}#{}.{}", note_id, self.section_index, self.sub_index)
    }
}

/// 算切片正文的指纹。独立函数，方便调用方拿新正文对比旧 hash。
pub fn content_hash(text: &str) -> String {
    let mut h = Md5::new();
    h.update(text.as_bytes());
    format!("{:x}", h.finalize())
}

/// 把一篇笔记切成切片。纯函数：同一份正文连算两次结果完全一致。
///
/// 四条切分规则（定案 §3，按顺序应用）：
///
/// | # | 规则 | 依据 |
/// |---|---|---|
/// | ① | 空节不生成切片 | 4.0% 是纯标题节，算向量是白烧且会污染召回 |
/// | ② | ≤窗口的节直接成一个切片 | 70% 的节适用，零额外处理 |
/// | ③ | 超窗口的节二次切：先按段落边界，装不下再硬切 | 29.5% 的节 |
/// | ④ | **短节不合并** | 合并会让切片跨节，直接破掉可寻址性 |
pub fn chunk_note(content: &str) -> Vec<Chunk> {
    let mut out = Vec::new();
    for s in outline(content) {
        let body = slice(content, &s, false);
        // 规则①：正文全是空白的节（纯标题）不出切片。
        if body.trim().is_empty() {
            continue;
        }
        out.extend(chunk_section(&s, &body));
    }
    out
}

/// 切单一节。`body` 是 [`slice`] 拿到的本节正文（不含标题）。
fn chunk_section(s: &Section, body: &str) -> Vec<Chunk> {
    let chars: Vec<char> = body.chars().collect();

    // 规则②：装得下就一块，`sub_index` 恒 0。
    if chars.len() <= CHUNK_WINDOW {
        return vec![make(s, 0, &chars, 0, chars.len())];
    }

    // 规则③：先按段落装箱，单段自己就超窗口的再硬切。
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    let mut cur: Option<(usize, usize)> = None;

    for (ps, pe) in paragraphs(&chars) {
        let plen = pe - ps;
        if plen > CHUNK_WINDOW {
            // 这一段自己就装不下：先把手里攒的吐出去，再硬切它。
            if let Some(c) = cur.take() {
                ranges.push(c);
            }
            ranges.extend(hard_split(ps, pe));
            continue;
        }
        cur = match cur {
            // 装得下就接上去（区间首尾相接，所以只需推终点）。
            Some((cs, _)) if pe - cs <= CHUNK_WINDOW => Some((cs, pe)),
            // 装不下：收掉手里的，从本段重开一块。
            Some(c) => {
                ranges.push(c);
                Some((ps, pe))
            }
            None => Some((ps, pe)),
        };
    }
    if let Some(c) = cur {
        ranges.push(c);
    }

    ranges
        .into_iter()
        .enumerate()
        .map(|(i, (a, b))| make(s, i, &chars, a, b))
        .collect()
}

/// 把字符序列切成段落区间。
///
/// 🔴 **每个段落区间包含它后面的分隔空行**，这样所有区间首尾相接、覆盖全文无洞——
/// 定案 §7 要求「能拼回原文（无丢失）」，漏掉分隔空行就拼不回了。
fn paragraphs(chars: &[char]) -> Vec<(usize, usize)> {
    let lines = line_ranges(chars);
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    let mut i = 0;
    while i < lines.len() {
        let (ls, le) = lines[i];
        let blank = chars[ls..le].iter().all(|c| c.is_whitespace());
        if blank {
            // 空行：如果手里有段落，把连续空行一并归给它然后收段。
            if let Some(s0) = start.take() {
                let mut e = le;
                while i + 1 < lines.len() {
                    let (ns, ne) = lines[i + 1];
                    if chars[ns..ne].iter().all(|c| c.is_whitespace()) {
                        e = ne;
                        i += 1;
                    } else {
                        break;
                    }
                }
                out.push((s0, e));
            } else if let Some(last) = out.last_mut() {
                // 开头就是空行且前面已有段：归给上一段，不另起一段。
                last.1 = le;
            } else {
                // 整个节开头的空行：先攒着，等第一段真正开始时包进去。
                start = Some(ls);
            }
        } else if start.is_none() {
            start = Some(ls);
        }
        i += 1;
    }
    if let Some(s0) = start {
        out.push((s0, chars.len()));
    } else if let Some(last) = out.last_mut() {
        last.1 = chars.len();
    }
    if out.is_empty() {
        out.push((0, chars.len()));
    }
    out
}

/// 行区间（含行尾 `\n`）。首尾相接，覆盖全文。
fn line_ranges(chars: &[char]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut s = 0;
    for (i, c) in chars.iter().enumerate() {
        if *c == '\n' {
            out.push((s, i + 1));
            s = i + 1;
        }
    }
    if s < chars.len() {
        out.push((s, chars.len()));
    }
    out
}

/// 硬切一个超窗口的段落，相邻块重叠 [`CHUNK_OVERLAP`]。
///
/// 步长 = 窗口 − 重叠，必须 > 0（两个常量是 512/64，成立）；
/// 否则会无限循环，所以这里兵一下。
fn hard_split(start: usize, end: usize) -> Vec<(usize, usize)> {
    let step = CHUNK_WINDOW.saturating_sub(CHUNK_OVERLAP).max(1);
    let mut out = Vec::new();
    let mut a = start;
    loop {
        let b = (a + CHUNK_WINDOW).min(end);
        out.push((a, b));
        if b >= end {
            break;
        }
        a += step;
    }
    out
}

fn make(s: &Section, sub_index: usize, chars: &[char], a: usize, b: usize) -> Chunk {
    let text: String = chars[a..b].iter().collect();
    Chunk {
        section_index: s.index,
        sub_index,
        heading: s.heading.clone(),
        path: s.path.clone(),
        content_hash: content_hash(&text),
        text,
        char_start: a,
        char_end: b,
        context_card: None,
    }
}
