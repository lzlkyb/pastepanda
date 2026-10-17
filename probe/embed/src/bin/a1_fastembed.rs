//! A1 探针：fastembed-rs 7.1.1 + BGESmallZHV15（fp32 ONNX，Xenova 镜像）
//!
//! 判据先写死在 README.md（体积/首启/吞吐/内存/召回对比）。本文件只实现测量，
//! 不解释结论——结论连同偏差一起写回 `docs/知识库-差距补全路线图-2026-10-14.md`。
//!
//! FTS5 对照组复刻 `src-tauri/src/data_store/{note.rs,history.rs}` 的真实路径：
//! 裸 fts5(title, content, pinyin) + `to_ngram` 双侧预处理 + `to_match_expr`
//! + `bm25(notes_fts, 10.0, 1.0, 0.0)` 排序。pinyin 列取库内已写入的 `notes_fts.pinyin`。

use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows::Win32::System::Threading::GetCurrentProcess;

const DATA_DIR: &str = "data";
const BGE_QUERY_PREFIX: &str = "为这个句子生成表示以用于检索相关文章：";
const RECALL_DOC_CHARS: usize = 600;

// ---------- 数据 ----------

#[derive(Deserialize)]
struct Note {
    id: String,
    title: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    fts_pinyin: String,
}

#[derive(Deserialize)]
struct HistoryCard {
    #[allow(dead_code)]
    id: String,
    content: String,
    #[allow(dead_code)]
    #[serde(rename = "type")]
    card_type: String,
}

// ---------- FTS5 对照组（复刻 note.rs / history.rs，勿改语义） ----------

fn is_cjk(c: char) -> bool {
    matches!(c,
        '\u{4E00}'..='\u{9FFF}'
        | '\u{3400}'..='\u{4DBF}'
        | '\u{F900}'..='\u{FAFF}'
        | '\u{20000}'..='\u{2A6DF}'
    )
}

fn to_ngram(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let n = chars.len();
    let mut out: Vec<String> = Vec::with_capacity(n * 2);
    let mut i = 0;
    while i < n {
        let c = chars[i];
        if is_cjk(c) {
            out.push(c.to_string());
            if i + 1 < n && is_cjk(chars[i + 1]) {
                let mut pair = String::with_capacity(2);
                pair.push(c);
                pair.push(chars[i + 1]);
                out.push(pair);
            }
            i += 1;
        } else {
            let mut buf = String::new();
            while i < n && !is_cjk(chars[i]) {
                buf.push(chars[i]);
                i += 1;
            }
            out.push(buf);
        }
    }
    out.join(" ")
}

fn to_match_expr(kw: &str) -> String {
    let is_ascii_word = kw
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '_' || c == '-');
    if is_ascii_word {
        let cleaned: String = kw
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
            .collect();
        let terms: Vec<String> = cleaned
            .split_whitespace()
            .map(|t| format!("{}*", t))
            .collect();
        if !terms.is_empty() {
            return terms.join(" ");
        }
    }
    to_ngram(kw)
}

/// FTS5 检索：返回按 bm25(title 10x) 排序的笔记下标序列（与 note_search 同口径）。
fn fts5_rank(notes: &[Note], query: &str) -> Vec<usize> {
    let conn = Connection::open_in_memory().expect("in-memory sqlite");
    conn.execute_batch("CREATE VIRTUAL TABLE t USING fts5(title, content, pinyin);")
        .expect("create fts5");
    for (i, n) in notes.iter().enumerate() {
        conn.execute(
            "INSERT INTO t (rowid, title, content, pinyin) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                i as i64 + 1,
                to_ngram(&n.title),
                to_ngram(&n.content),
                to_ngram(&n.fts_pinyin),
            ],
        )
        .expect("insert fts5");
    }
    let mut stmt = conn
        .prepare("SELECT rowid FROM t WHERE t MATCH ?1 ORDER BY bm25(t, 10.0, 1.0, 0.0)")
        .expect("prepare match");
    let rows = stmt
        .query_map(rusqlite::params![to_match_expr(query)], |r| {
            r.get::<_, i64>(0)
        })
        .expect("query match");
    rows.filter_map(|r| r.ok())
        .map(|rid| (rid - 1) as usize)
        .collect()
}

// ---------- 工具 ----------

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    dot / (na.sqrt() * nb.sqrt())
}

fn peak_working_set_mb() -> f64 {
    unsafe {
        let mut pc = PROCESS_MEMORY_COUNTERS::default();
        // PeakWorkingSetSize 是单调水位线：一次调用即全程峰值，无需轮询采样。
        let _ = GetProcessMemoryInfo(
            GetCurrentProcess(),
            &mut pc as *mut PROCESS_MEMORY_COUNTERS,
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        );
        pc.PeakWorkingSetSize as f64 / 1048576.0
    }
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let idx = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

fn dir_size_mb(path: &PathBuf) -> f64 {
    if !path.exists() {
        return 0.0;
    }
    let mut total = 0u64;
    let mut stack = vec![path.clone()];
    while let Some(p) = stack.pop() {
        if let Ok(rd) = fs::read_dir(&p) {
            for e in rd.flatten() {
                let ft = match e.file_type() {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                if ft.is_dir() {
                    stack.push(e.path());
                } else if let Ok(m) = e.metadata() {
                    total += m.len();
                }
            }
        }
    }
    total as f64 / 1048576.0
}

// ---------- 主流程 ----------

#[derive(Serialize)]
struct A1Result {
    fastembed_version: String,
    model: String,
    model_dir_mb: f64,
    cold_init_ms: f64,
    warm_init_ms: f64,
    single_p50_ms: f64,
    single_p95_ms: f64,
    batch32_per_text_ms: f64,
    extrapolated_1k_index_ms: f64,
    peak_rss_mb: f64,
    self_retrieval: serde_json::Value,
    paraphrase: serde_json::Value,
    notes_count: usize,
    history_count: usize,
}

fn main() {
    let t_start = Instant::now();

    // 0. 语料
    let notes: Vec<Note> =
        serde_json::from_str(&fs::read_to_string(format!("{}/notes.json", DATA_DIR)).unwrap())
            .expect("notes.json（先跑 scripts/export_corpus.py）");
    let history: Vec<HistoryCard> = serde_json::from_str(
        &fs::read_to_string(format!("{}/history_1000.json", DATA_DIR)).unwrap(),
    )
    .expect("history_1000.json");
    println!(
        "[语料] notes={} history={}",
        notes.len(),
        history.len()
    );

    // 1. 首启加载（cold：缓存可能已存在则报 warm；本机首次跑为 cold）
    let cache_dir = PathBuf::from(format!("{}/models/fastembed", DATA_DIR));
    let opts = || {
        InitOptions::new(EmbeddingModel::BGESmallZHV15)
            .with_cache_dir(cache_dir.clone())
            .with_show_download_progress(false)
    };
    let t = Instant::now();
    let mut model = TextEmbedding::try_new(opts()).expect("fastembed 初始化（HF 需可达）");
    let cold_init_ms = t.elapsed().as_secs_f64() * 1000.0;
    let t = Instant::now();
    let mut model2 = TextEmbedding::try_new(opts()).expect("fastembed 二次初始化");
    let warm_init_ms = t.elapsed().as_secs_f64() * 1000.0;
    drop(model2);

    // 2. 模型体积（缓存目录整体，含 tokenizer 等）
    let model_dir_mb = dir_size_mb(&cache_dir);

    // 3. 吞吐：单条 p50/p95（200 样本，取 history 真实中文语料）
    let sample: Vec<String> = history
        .iter()
        .take(200)
        .map(|h| h.content.clone())
        .collect();
    for warm in sample.iter().take(3) {
        let _ = model.embed(std::slice::from_ref(warm), None).unwrap();
    }
    let mut single: Vec<f64> = Vec::with_capacity(sample.len());
    for s in &sample {
        let t = Instant::now();
        let _ = model.embed(std::slice::from_ref(s), None).unwrap();
        single.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    single.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let single_p50_ms = percentile(&single, 0.5);
    let single_p95_ms = percentile(&single, 0.95);

    // 4. 批量 32：1000 条全量（= 1k 篇索引基准，真实耗时非外推的上界参考）
    let batch_texts: Vec<String> = history.iter().map(|h| h.content.clone()).collect();
    let t = Instant::now();
    let mut batch_vecs: Vec<Vec<f32>> = Vec::with_capacity(batch_texts.len());
    for chunk in batch_texts.chunks(32) {
        let vs = model.embed(chunk, Some(32)).unwrap();
        batch_vecs.extend(vs.into_iter().map(|e| e.into()));
    }
    let batch_total_ms = t.elapsed().as_secs_f64() * 1000.0;
    let batch32_per_text_ms = batch_total_ms / batch_texts.len() as f64;
    let extrapolated_1k_index_ms = batch32_per_text_ms * 1000.0;

    // A2（mnn-bert）的 correctness 基线：同文本同模型的前 20 条向量。
    // 落盘而非让 A2 再拖一份 fastembed 依赖——两个探针 crate 保持独立。
    let baseline = serde_json::json!({
        "model": "BGESmallZHV15 fp32 (fastembed 7.1.1)",
        "texts": &batch_texts[..20],
        "embeddings": &batch_vecs[..20],
    });
    fs::write(
        format!("{}/a1_baseline.json", DATA_DIR),
        serde_json::to_string(&baseline).unwrap(),
    )
    .unwrap();

    let peak_rss_mb = peak_working_set_mb();

    println!(
        "[A1 数字] 模型目录={model_dir_mb:.1}MB | cold_init={cold_init_ms:.0}ms warm_init={warm_init_ms:.0}ms \
         | 单条 p50={single_p50_ms:.1}ms p95={single_p95_ms:.1}ms | 批量32均摊={batch32_per_text_ms:.2}ms/条 \
         | 1k索引外推={extrapolated_1k_index_ms:.0}ms | peak RSS={peak_rss_mb:.0}MB"
    );

    // 5. 召回对比
    // 5a. 自检索 sanity：查询 = 笔记标题（答案必中属预期，验链路不通则说明模型/管线坏了）
    let docs: Vec<String> = notes
        .iter()
        .map(|n| {
            let mut d = n.title.clone();
            if !n.summary.is_empty() {
                d.push('\n');
                d.push_str(&n.summary);
            }
            let head: String = n.content.chars().take(RECALL_DOC_CHARS).collect();
            if !head.is_empty() {
                d.push('\n');
                d.push_str(&head);
            }
            d
        })
        .collect();
    let doc_vecs: Vec<Vec<f32>> = model
        .embed(&docs, Some(16))
        .unwrap()
        .into_iter()
        .map(|e| e.into())
        .collect();

    let semantic_rank = |model: &mut TextEmbedding, q: &str| -> Vec<usize> {
        let qv: Vec<f32> = model.embed(&[q.to_string()], None).unwrap()[0]
            .clone()
            .into();
        let mut scored: Vec<(usize, f32)> = doc_vecs
            .iter()
            .enumerate()
            .map(|(i, v)| (i, cosine(&qv, v)))
            .collect();
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
        scored.into_iter().map(|(i, _)| i).collect()
    };

    let mut self_hit1_plain = 0;
    let mut self_hit5_plain = 0;
    let mut self_hit1_prefixed = 0;
    let mut self_hit5_prefixed = 0;
    let mut self_rows = Vec::new();
    for (i, n) in notes.iter().enumerate() {
        let r_plain = semantic_rank(&mut model, &n.title);
        let r_pre = semantic_rank(&mut model, &format!("{}{}", BGE_QUERY_PREFIX, n.title));
        let p1 = r_plain.first() == Some(&i);
        let p5 = r_plain.iter().take(5).any(|&x| x == i);
        let f1 = r_pre.first() == Some(&i);
        let f5 = r_pre.iter().take(5).any(|&x| x == i);
        self_hit1_plain += p1 as usize;
        self_hit5_plain += p5 as usize;
        self_hit1_prefixed += f1 as usize;
        self_hit5_prefixed += f5 as usize;
        self_rows.push(serde_json::json!({
            "title": n.title, "len": n.content.chars().count(),
            "plain_top1": p1, "plain_top5": p5, "prefixed_top1": f1, "prefixed_top5": f5,
        }));
    }
    let n = notes.len();
    println!(
        "[自检索 sanity] 查询=标题：无前缀 top1={}/{} top5={}/{} | 带BGE前缀 top1={}/{} top5={}/{}",
        self_hit1_plain, n, self_hit5_plain, n, self_hit1_prefixed, n, self_hit5_prefixed, n
    );

    // 5b. 复述查询（synthetic，非真实查询——真实查询校准等 S0-P2）
    //     查询按 5 条实质笔记各 2 条构造，问法自然、与正文用词部分错开。
    //     notes 按 updated_ms 倒序，5 条实质笔记排在**末尾**（indices 8..13），
    //     substantial[i] 即第 i 条实质笔记在语料中的下标。
    let substantial: Vec<usize> = notes
        .iter()
        .enumerate()
        .filter(|(_, n)| !n.summary.is_empty())
        .map(|(i, _)| i)
        .collect();
    let paraphrase_queries: Vec<(&str, usize)> = vec![
        ("新功能动手之前要先做什么", 0),
        ("一个文件最多可以写多少行", 0),
        ("vitest 为什么要加 forks 参数", 1),
        ("libclang 的路径配置在哪里", 1),
        ("MCP 的工具描述该怎么写", 2),
        ("工具列表的字节上限是多少", 2),
        ("自动更新停了怎么排查", 3),
        ("镜像同步需要哪些密钥", 3),
        ("截图标注的快捷键是什么", 4),
        ("知识库同步目前到哪个阶段", 4),
    ];
    // substantial 的顺序须与 export 时的 updated_ms 倒序一致（5 条实质笔记即其中后 5 条）
    debug_assert_eq!(substantial.len(), 5);

    let mut para_rows = Vec::new();
    let mut sem_hit1 = 0;
    let mut sem_hit3 = 0;
    let mut sem_pre_hit1 = 0;
    let mut sem_pre_hit3 = 0;
    let mut fts_hit1 = 0;
    let mut fts_hit3 = 0;
    for (q, expect_sub) in &paraphrase_queries {
        let target = substantial[*expect_sub];
        let r = semantic_rank(&mut model, q);
        let rp = semantic_rank(&mut model, &format!("{}{}", BGE_QUERY_PREFIX, q));
        let rf = fts5_rank(&notes, q);
        let s1 = r.first() == Some(&target);
        let s3 = r.iter().take(3).any(|&x| x == target);
        let sp1 = rp.first() == Some(&target);
        let sp3 = rp.iter().take(3).any(|&x| x == target);
        let f1 = rf.first() == Some(&target);
        let f3 = rf.iter().take(3).any(|&x| x == target);
        sem_hit1 += s1 as usize;
        sem_hit3 += s3 as usize;
        sem_pre_hit1 += sp1 as usize;
        sem_pre_hit3 += sp3 as usize;
        fts_hit1 += f1 as usize;
        fts_hit3 += f3 as usize;
        para_rows.push(serde_json::json!({
            "q": q, "target": notes[target].title,
            "sem_top1": s1, "sem_top3": s3,
            "sem_prefixed_top1": sp1, "sem_prefixed_top3": sp3,
            "fts_top1": f1, "fts_top3": f3,
            "sem_rank": r.iter().position(|&x| x == target),
            "sem_prefixed_rank": rp.iter().position(|&x| x == target),
            "fts_rank": rf.iter().position(|&x| x == target),
        }));
    }
    let pq = paraphrase_queries.len();
    println!(
        "[复述查询 x{}] 语义 top1={}/{} top3={}/{} | 语义+前缀 top1={}/{} top3={}/{} | FTS5 top1={}/{} top3={}/{}",
        pq, sem_hit1, pq, sem_hit3, pq, sem_pre_hit1, pq, sem_pre_hit3, pq, fts_hit1, pq, fts_hit3, pq
    );

    // 6. 结果落盘
    let result = A1Result {
        fastembed_version: "7.1.1".into(),
        model: "BGESmallZHV15 (Xenova/bge-small-zh-v1.5, fp32 onnx)".into(),
        model_dir_mb,
        cold_init_ms,
        warm_init_ms,
        single_p50_ms,
        single_p95_ms,
        batch32_per_text_ms,
        extrapolated_1k_index_ms,
        peak_rss_mb,
        self_retrieval: serde_json::json!({
            "n": n,
            "plain": {"top1": self_hit1_plain, "top5": self_hit5_plain},
            "prefixed": {"top1": self_hit1_prefixed, "top5": self_hit5_prefixed},
            "rows": self_rows,
        }),
        paraphrase: serde_json::json!({
            "n": pq,
            "note": "synthetic queries，非真实查询；真实查询校准等 S0-P2",
            "semantic": {"top1": sem_hit1, "top3": sem_hit3},
            "semantic_prefixed": {"top1": sem_pre_hit1, "top3": sem_pre_hit3},
            "fts5": {"top1": fts_hit1, "top3": fts_hit3},
            "rows": para_rows,
        }),
        notes_count: notes.len(),
        history_count: history.len(),
    };
    fs::create_dir_all(DATA_DIR).ok();
    fs::write(
        format!("{}/a1_result.json", DATA_DIR),
        serde_json::to_string_pretty(&result).unwrap(),
    )
    .unwrap();
    println!(
        "[完成] {:.1}s，结果 → {}/a1_result.json",
        t_start.elapsed().as_secs_f64(),
        DATA_DIR
    );
}
