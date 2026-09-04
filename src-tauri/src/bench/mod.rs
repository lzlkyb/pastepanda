//! AM-5 召回基准。**只在 `cargo test` 下编译，不进安装包。**
//!
//! # 它回答什么
//!
//! 两个问题，而且只有这两个：
//! 1. 改了排序之后，召回是变好了还是变差了？（AM-9 的前置闸门）
//! 2. 「关键词对不上、但语义对得上」那一类掉多少？（AM-10 向量层唯一可证伪的存在理由）
//!
//! # 三条硬规矩
//!
//! **① 测的必须是出货那套检索。** 本模块不自己实现任何检索或打分，
//! 一律走 [`DataStore::note_search_relevant`] + [`crate::mcp::tools::section_hits_for`]。
//! 自己重写一份 BM25 去测，量出来的数与线上无关——而这种错从报告上看不出来。
//!
//! **② 标注解析不上就报错，不静默算 0 分**（规则 #15.3）。
//! 一个写错的期望标签如果被当成「没召回」，它会安静地把分数压低，
//! 而我们会以为是检索差。宁可跑不起来。
//!
//! **③ 数字旁边必须钉住方法**（§7.5）：题数、谁标的、节级还是篇级、
//! `limit` 多少、库多少篇多少节、什么日期。报告头部自动带这些，不靠人记得写。
//!
//! # 口径
//!
//! 检索单元是**节**，不是篇：本机库 26 篇但 375 节（2026-09-04 实测），
//! 篇级 R@5 = 返回全库的 20%，区分度接近零。节级 R@10 = 2.7%。
//!
//! 一节的稳定标识是 `(笔记 id, 节序号)`，节序号即 [`crate::markdown::Section::index`]，
//! `0` 是引言节。

use crate::data_store::{question_terms, DataStore, NoteViewOpts};
use crate::mcp::tools::{section_hits_for, skips_section_hits};
use serde::Deserialize;
use std::collections::{BTreeMap, HashSet};

/// 一节的稳定标识：`(笔记 id, 节序号)`。
pub type SectionKey = (String, usize);

/// 节级召回取前几名。见模块文档「口径」。
pub const TOP_K: usize = 10;

// ===== 用例集 =====

/// 一道题。
#[derive(Debug, Clone, Deserialize)]
pub struct Case {
    /// 人可读的编号，只用于报告定位。
    pub id: String,
    /// 查询类型。**必须分组报，不报一个平均值**——平均值会把崩掉的那一类盖住
    /// （arXiv 2605.29630：召回随查询类型剧变）。见 [`QueryType`]。
    pub kind: QueryType,
    /// 真正发给 `kb_search` 的查询词。
    pub query: String,
    /// 期望命中的节。**由人标注，一个人标完**——不一致的标注比少量标注更糟。
    pub expect: Vec<Label>,
    /// 可选：拼在 `query` 前面的系统提示噪声（验收项①）。
    ///
    /// 有这个字段的用例会**跑两遍**（干净 / 污染），报告给出掉幅。
    /// 单报污染后的绝对值没有意义——要的是差值。
    #[serde(default)]
    pub prefix: Option<String>,
}

/// 查询类型。分组口径，改动会让历史报告不可比，**加不删**。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryType {
    /// 直接用笔记里出现过的词提问。BM25 的主场。
    Keyword,
    /// 问意图/做法，不含笔记原词。
    Intent,
    /// 带时间限定（「上个月那个」「最近改的」）。
    Temporal,
    /// 答案要跨多篇才凑得齐。
    CrossNote,
    /// 🔴 关键词对不上、但语义对得上。**AM-10 的判据就是这一组的数。**
    Semantic,
}

/// 一条期望标签。用「标题片段 + 标题行片段」而不是 uuid：uuid 人写不出来，
/// 而写不出来的标注格式最后一定没人标。
#[derive(Debug, Clone, Deserialize)]
pub struct Label {
    /// 笔记标题的片段，大小写不敏感。**必须唯一匹配一篇**，否则报错。
    pub note: String,
    /// 节标题的片段，大小写不敏感。**必须唯一匹配一节**，否则报错。
    ///
    /// 空串 = 引言节（`index 0`）。短笔记（出货时不做节级定位的那些）只能标空串。
    #[serde(default)]
    pub heading: String,
}

/// 一份用例集。
#[derive(Debug, Clone, Deserialize)]
pub struct CaseSet {
    /// 谁标的。写进报告——半年后没有署名的数字我们自己都不敢引用。
    pub labeler: String,
    pub cases: Vec<Case>,
}

// ===== 标注解析 =====

/// 库里的一篇及其大纲，解析标注用。
struct Indexed {
    id: String,
    title: String,
    /// `(节序号, 标题文字)`。短笔记只有一项 `(0, "")`。
    sections: Vec<(usize, String)>,
}

/// 把全库读进来建索引。基准是离线跑的，26 篇全读没有性能问题；
/// 而分页读会让「唯一匹配」的判定失去意义。
fn index_all(store: &DataStore) -> Result<Vec<Indexed>, String> {
    // limit 给一个远大于库规模的数：读不全会让标注静默解析失败（规矩②）。
    let notes = store.note_list("", &[], 100_000, 0)?;
    Ok(notes
        .into_iter()
        .map(|n| {
            let sections = if skips_section_hits(&n.content) {
                // 出货时这类笔记不做节级定位，只给 200 字摘要——
                // 那 200 字就是正文开头，记账上等同引言节。
                vec![(0usize, String::new())]
            } else {
                crate::markdown::outline(&n.content)
                    .into_iter()
                    .map(|s| (s.index, s.heading))
                    .collect()
            };
            Indexed {
                id: n.id,
                title: n.title,
                sections,
            }
        })
        .collect())
}

/// 把一条人写的标签解析成 `(笔记 id, 节序号)`。
///
/// 🔴 解析不上一律 `Err`（规矩②）。歧义也是错——「匹配到 3 篇」说明标签写得不够具体，
/// 随便挑一篇会让报告里的数悄悄变成另一个问题的答案。
fn resolve(idx: &[Indexed], case_id: &str, l: &Label) -> Result<SectionKey, String> {
    let want = l.note.to_lowercase();
    let hits: Vec<&Indexed> = idx
        .iter()
        .filter(|n| n.title.to_lowercase().contains(&want))
        .collect();
    let note = match hits.len() {
        1 => hits[0],
        0 => return Err(format!("[{}] 没有标题含「{}」的笔记", case_id, l.note)),
        n => {
            let names: Vec<&str> = hits.iter().map(|h| h.title.as_str()).take(5).collect();
            return Err(format!(
                "[{}] 标题片段「{}」匹配到 {} 篇（{}…），请写得更具体",
                case_id, l.note, n, names.join(" / ")
            ));
        }
    };
    if l.heading.trim().is_empty() {
        // 空串 = 引言节。但得确认这篇真有引言节：整篇以标题开头的笔记没有 [0]，
        // 标了也永远命不中——那是标注错误，不是召回失败。
        return if note.sections.iter().any(|(i, _)| *i == 0) {
            Ok((note.id.clone(), 0))
        } else {
            Err(format!(
                "[{}] 笔记「{}」没有引言节（开头就是标题），heading 不能留空",
                case_id, note.title
            ))
        };
    }
    let want_h = l.heading.to_lowercase();
    let sec: Vec<&(usize, String)> = note
        .sections
        .iter()
        .filter(|(_, h)| h.to_lowercase().contains(&want_h))
        .collect();
    match sec.len() {
        1 => Ok((note.id.clone(), sec[0].0)),
        0 => Err(format!(
            "[{}] 笔记「{}」里没有标题含「{}」的节",
            case_id, note.title, l.heading
        )),
        n => Err(format!(
            "[{}] 笔记「{}」里「{}」匹配到 {} 节，请写得更具体",
            case_id, note.title, l.heading, n
        )),
    }
}

// ===== 检索 =====

/// 一次检索返回的东西。**两种节序都留着**，它们的差就是 AM-9 的量化理由。
struct Retrieved {
    /// 命中的笔记 id，BM25 序。节级召回的天花板由它决定。
    notes: Vec<String>,
    /// 篇序优先：第一篇的 3 节、第二篇的 3 节……
    /// **这就是 `kb_search` 输出里模型实际看到的顺序**，是正指标。
    note_major: Vec<SectionKey>,
    /// 分数优先：把所有节按各自的节分全局重排。
    /// 出货时**没有**这一步；它是「若把排序收口到一处能好多少」的上界估计。
    score_major: Vec<SectionKey>,
}

fn retrieve(store: &DataStore, query: &str, limit: u32) -> Result<Retrieved, String> {
    // 切词走同一份出口（规则 #11）：各写一套会让「篇级命中了、节级一节都不中」变成常态。
    let terms = question_terms(query);
    let opts = NoteViewOpts::default();
    // folder / tag 传空 = 全库。基准不测范围过滤（那是 AM-1a，行为上看得出来）。
    let notes = store.note_search_relevant(query, "", &[], &opts, limit)?;

    let mut note_ids = Vec::with_capacity(notes.len());
    let mut flat: Vec<(SectionKey, f32)> = Vec::new();
    for n in &notes {
        note_ids.push(n.id.clone());
        if skips_section_hits(&n.content) {
            // 短笔记：出货给的 200 字摘要就是正文开头 → 记作命中引言节。
            // 分给 0.0，让它在分数序里排在真正有词命中的节后面。
            flat.push(((n.id.clone(), 0), 0.0));
            continue;
        }
        for h in section_hits_for(&n.content, &terms) {
            flat.push(((n.id.clone(), h.index), h.score));
        }
    }

    let note_major: Vec<SectionKey> = flat.iter().map(|(k, _)| k.clone()).collect();
    let mut sm = flat;
    // `sort_by` 是稳定排序：同分时保持篇序。
    // 🔴 这正是 AM-9「破同分」要补的口子——此处只是把现状如实记下来，不在基准里偷偷修。
    sm.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let score_major = sm.into_iter().map(|(k, _)| k).collect();

    Ok(Retrieved {
        notes: note_ids,
        note_major,
        score_major,
    })
}

// ===== 打分 =====

/// 节级 Recall@k。
fn recall_at(ranked: &[SectionKey], expect: &HashSet<SectionKey>, k: usize) -> f64 {
    if expect.is_empty() {
        return 0.0;
    }
    let seen: HashSet<&SectionKey> = ranked.iter().take(k).collect();
    let hit = expect.iter().filter(|e| seen.contains(e)).count();
    hit as f64 / expect.len() as f64
}

/// 篇级命中率。**它是节级召回的天花板**：BM25 没返回那篇，它的节一节都不可能中。
///
/// 分开报是为了把失败拆成两类：漏在篇级（`limit` 太紧 / BM25 没匹配上，归 AM-9）
/// vs 篇中了但指错节（归 AM-2）。合成一个数就分不出该改哪一头。
fn note_recall(notes: &[String], expect: &HashSet<SectionKey>) -> f64 {
    let want: HashSet<&String> = expect.iter().map(|(id, _)| id).collect();
    if want.is_empty() {
        return 0.0;
    }
    let got: HashSet<&String> = notes.iter().collect();
    want.iter().filter(|w| got.contains(**w)).count() as f64 / want.len() as f64
}

/// 一道题的成绩。
#[derive(Debug, Clone)]
pub struct CaseResult {
    pub id: String,
    pub kind: QueryType,
    /// 期望标注了几节。
    pub expect_n: usize,
    pub note_recall: f64,
    /// 正指标：节级 R@k，篇序（出货顺序）。
    pub r_note_major: f64,
    /// 参考：节级 R@k，分数序。
    pub r_score_major: f64,
    /// 有 `prefix` 的用例才有：污染后的节级 R@k（篇序）。
    pub r_contaminated: Option<f64>,
}

// ===== 跑一轮 =====

/// 一整份报告。带齐方法脚注所需的全部字段——**不靠人记得写**（规矩③）。
#[derive(Debug, Clone)]
pub struct Report {
    /// 跑的日期。由调用方传入（测试传固定值，真跑传当天），不在库里现编。
    pub date: String,
    pub labeler: String,
    pub lib_notes: usize,
    pub lib_sections: usize,
    pub top_k: usize,
    /// 每个 `limit` 一组结果。扫 `limit` 是为了分开
    /// 「节排得不好」和「篇级只取 5 篇太紧」——后者就是 §7 里那个待量的 `k`。
    pub by_limit: Vec<(u32, Vec<CaseResult>)>,
}

/// 跑完整份用例集。
///
/// `limits` 通常给 `&[5, 10, 20]`：5 是 `kb_search` 的默认值，20 是它的上限。
pub fn run(
    store: &DataStore,
    set: &CaseSet,
    limits: &[u32],
    date: &str,
) -> Result<Report, String> {
    let idx = index_all(store)?;
    let lib_sections: usize = idx.iter().map(|n| n.sections.len()).sum();

    // 🔴 先把**所有**标签解析一遍再开跑：一份用例集里有错标就整份不跑，
    //    而不是跑到一半才炸——后者会留下一份「跑了一部分」的报告，最容易被误引用。
    let mut expects: Vec<HashSet<SectionKey>> = Vec::with_capacity(set.cases.len());
    for c in &set.cases {
        if c.expect.is_empty() {
            return Err(format!("[{}] 没有标注期望命中的节", c.id));
        }
        let mut e = HashSet::new();
        for l in &c.expect {
            e.insert(resolve(&idx, &c.id, l)?);
        }
        expects.push(e);
    }

    let mut by_limit = Vec::new();
    for &limit in limits {
        let mut out = Vec::with_capacity(set.cases.len());
        for (c, expect) in set.cases.iter().zip(&expects) {
            // 错误一律带上题号：没有题号的「检索失败」在 50 题里定位不到是哪一条。
            let r = retrieve(store, &c.query, limit)
                .map_err(|e| format!("[{}] 检索失败：{}", c.id, e))?;
            let r_contaminated = match &c.prefix {
                Some(p) => {
                    let dirty = format!("{} {}", p, c.query);
                    // 🔴 污染查询报错**不能吞成 0 分**：FTS5 对超长表达式有上限，
                    //    真撞上了那本身就是结论的一部分（「客户端拼系统提示会让检索直接失败」），
                    //    而记成 0 分会让它看起来只是「召回差」。
                    let rd = retrieve(store, &dirty, limit).map_err(|e| {
                        format!(
                            "[{}] 污染查询检索失败（这本身就是一条结论，不要改成 0 分绕过）：{}",
                            c.id, e
                        )
                    })?;
                    Some(recall_at(&rd.note_major, expect, TOP_K))
                }
                None => None,
            };
            out.push(CaseResult {
                id: c.id.clone(),
                kind: c.kind,
                expect_n: expect.len(),
                note_recall: note_recall(&r.notes, expect),
                r_note_major: recall_at(&r.note_major, expect, TOP_K),
                r_score_major: recall_at(&r.score_major, expect, TOP_K),
                r_contaminated,
            });
        }
        by_limit.push((limit, out));
    }

    Ok(Report {
        date: date.to_string(),
        labeler: set.labeler.clone(),
        lib_notes: idx.len(),
        lib_sections,
        top_k: TOP_K,
        by_limit,
    })
}

fn mean(xs: impl Iterator<Item = f64>) -> f64 {
    let v: Vec<f64> = xs.collect();
    if v.is_empty() {
        0.0
    } else {
        v.iter().sum::<f64>() / v.len() as f64
    }
}

fn kind_name(k: QueryType) -> &'static str {
    match k {
        QueryType::Keyword => "关键词型",
        QueryType::Intent => "意图型",
        QueryType::Temporal => "时间型",
        QueryType::CrossNote => "多篇跨文型",
        QueryType::Semantic => "语义型（关键词对不上）",
    }
}

impl Report {
    /// 渲染成 Markdown。归档的就是这段文字。
    pub fn to_markdown(&self) -> String {
        let mut s = String::new();
        let n_cases = self.by_limit.first().map(|(_, v)| v.len()).unwrap_or(0);
        s.push_str(&format!("# AM-5 召回基准 · {}\n\n", self.date));

        // —— 方法脚注放最前面，不放脚注区：放在末尾的方法说明没人读。
        s.push_str("## 方法（引用这些数字时必须一并引用）\n\n");
        // 总标注节数 = 分母规模。只报题数会让人以为每题只标了一节，
        // 而多篇跨文型的题动辄标三四节——两者的 R@10 不是同一回事。
        let labeled: usize = self
            .by_limit
            .first()
            .map(|(_, v)| v.iter().map(|r| r.expect_n).sum())
            .unwrap_or(0);
        s.push_str(&format!(
            "- 口径：**节级 Recall@{}**（不是篇级）。一节 = `(笔记 id, 节序号)`，`0` 为引言节\n\
             - 用例：**{} 题 / 共标注 {} 节**，标注人 **{}**，一人标完\n\
             - 库规模：**{} 篇 / {} 节**\n\
             - 检索：出货同一条路径（`note_search_relevant` → `section_hits_for`），每篇取前 3 节\n\
             - 日期：{}\n\n",
            self.top_k, n_cases, labeled, self.labeler, self.lib_notes, self.lib_sections, self.date
        ));
        if self.lib_notes < 100 {
            s.push_str(&format!(
                "> ⚠ **库只有 {} 篇（<100），本报告只归档、不作决策依据。**\n\
                 > 这是 §0.7 ② 立的安全阀，防止「没基准就不改排序」退化成「样本永远不够 → 排序永远不改」。\n\n",
                self.lib_notes
            ));
        }

        for (limit, rs) in &self.by_limit {
            s.push_str(&format!(
                "## limit = {}（kb_search 一次返回几篇）\n\n",
                limit
            ));
            s.push_str("| 查询类型 | 题数 | 篇级命中率 | 节级 R@10（篇序·正指标） | 节级 R@10（分数序·参考） |\n");
            s.push_str("|---|---:|---:|---:|---:|\n");
            let mut groups: BTreeMap<QueryType, Vec<&CaseResult>> = BTreeMap::new();
            for r in rs {
                groups.entry(r.kind).or_default().push(r);
            }
            for (k, g) in &groups {
                s.push_str(&format!(
                    "| {} | {} | {:.0}% | **{:.0}%** | {:.0}% |\n",
                    kind_name(*k),
                    g.len(),
                    mean(g.iter().map(|r| r.note_recall)) * 100.0,
                    mean(g.iter().map(|r| r.r_note_major)) * 100.0,
                    mean(g.iter().map(|r| r.r_score_major)) * 100.0,
                ));
            }
            // 🔴 全体平均只放在分组之后，且明说它不能单独引用。
            s.push_str(&format!(
                "| _（全体平均，**不要单独引用**）_ | {} | {:.0}% | {:.0}% | {:.0}% |\n\n",
                rs.len(),
                mean(rs.iter().map(|r| r.note_recall)) * 100.0,
                mean(rs.iter().map(|r| r.r_note_major)) * 100.0,
                mean(rs.iter().map(|r| r.r_score_major)) * 100.0,
            ));
        }

        // —— 验收项①：系统提示污染。只有差值有意义，所以成对报。
        if let Some((limit, rs)) = self.by_limit.first() {
            let dirty: Vec<&CaseResult> = rs.iter().filter(|r| r.r_contaminated.is_some()).collect();
            if !dirty.is_empty() {
                s.push_str(&format!(
                    "## 验收项① 系统提示污染（limit = {}）\n\n\
                     | 用例 | 干净 | 污染后 | 掉幅 |\n|---|---:|---:|---:|\n",
                    limit
                ));
                for r in &dirty {
                    let c = r.r_contaminated.unwrap();
                    s.push_str(&format!(
                        "| {} | {:.0}% | {:.0}% | {:+.0}pp |\n",
                        r.id,
                        r.r_note_major * 100.0,
                        c * 100.0,
                        (c - r.r_note_major) * 100.0
                    ));
                }
                let d = mean(dirty.iter().map(|r| r.r_contaminated.unwrap() - r.r_note_major));
                s.push_str(&format!("\n**平均掉幅 {:+.0}pp。**\n\n", d * 100.0));
            }
        }

        // —— 验收项③：AM-10 的判据。单独拎出来，不埋在分组表里。
        if let Some((_, rs)) = self.by_limit.first() {
            let sem: Vec<&CaseResult> =
                rs.iter().filter(|r| r.kind == QueryType::Semantic).collect();
            if !sem.is_empty() {
                s.push_str("## 验收项③ 语义型 —— AM-10 向量层的唯一判据\n\n");
                s.push_str(&format!(
                    "{} 题，节级 R@10 = **{:.0}%**。\n\n\
                     - 低 → 向量层有硬理由，且已有基线可对照\n\
                     - 尚可 → 向量层性价比要重估，**不是自动该做**\n\n",
                    sem.len(),
                    mean(sem.iter().map(|r| r.r_note_major)) * 100.0
                ));
            }
        }
        s
    }
}

#[cfg(test)]
mod tests;
