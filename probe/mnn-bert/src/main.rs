//! A2 探针：MNN 3.6.0 prebuilt 静态库跑 BGE-small-zh-v1.5（BERT 类三输入）。
//!
//! 判据（README.md 同款）：
//!   ① model.mnn 转换可行 + 模型体积
//!   ② 冷加载耗时
//!   ③ 单条推理耗时（首条 + 均摊）
//!   ④ peak RSS
//!   ⑤ 与 A1 fastembed 同文本向量余弦相似度（≥0.99 视为「跑通且语义一致」）
//!
//! 语料 = A1 落盘的 a1_baseline.json（前 20 条 history 卡片文本 + fastembed 向量），
//! A2 不拖 fastembed/ort 依赖，保持「一题一仓」独立。
//!
//! 运行前提（见 README）：
//!   - MNN_PROBE_INCLUDE / MNN_PROBE_LIB 指向解压后的 prebuilt
//!   - model.mnn（由 scripts/convert.py 从 fastembed 缓存的 onnx 转出）
//!   - tokenizer.json 直接复用 fastembed 缓存快照（与 A1 输入逐 token 一致）

use serde::Deserialize;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::time::Instant;

#[path = "../common/peak_rss.rs"]
mod peak_rss;

extern "C" {
    fn mnn_bert_load(
        model_path: *const c_char,
        out_engine: *mut *mut c_void,
        err: *mut c_char,
        err_len: c_int,
    ) -> c_int;
    fn mnn_bert_run(
        engine: *mut c_void,
        input_ids: *const i64,
        attention_mask: *const i64,
        token_type_ids: *const i64,
        seq_len: c_int,
        dim: c_int,
        out_embedding: *mut f32,
        err: *mut c_char,
        err_len: c_int,
    ) -> c_int;
    fn mnn_bert_report(engine: *mut c_void, buf: *mut c_char, buf_len: c_int) -> c_int;
    fn mnn_bert_unload(engine: *mut c_void);
}

#[derive(Deserialize)]
struct Baseline {
    model: String,
    texts: Vec<String>,
    embeddings: Vec<Vec<f32>>,
}

fn ffi_err(tag: &str, err_buf: &[c_char]) -> String {
    let msg = unsafe { CStr::from_ptr(err_buf.as_ptr()) }.to_string_lossy().into_owned();
    format!("{tag}: {msg}")
}

fn main() {
    let crate_root = env!("CARGO_MANIFEST_DIR");
    let baseline_path = format!("{crate_root}/../embed/data/a1_baseline.json");
    let model_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| format!("{crate_root}/model.mnn"));

    // ---- 基线 ----
    let baseline: Baseline =
        serde_json::from_str(&std::fs::read_to_string(&baseline_path).unwrap()).unwrap();
    println!(
        "[基线] {} | texts={} dim={}",
        baseline.model,
        baseline.texts.len(),
        baseline.embeddings[0].len()
    );
    let dim = baseline.embeddings[0].len() as c_int;

    // ---- tokenizer：直接用 fastembed 缓存里的 tokenizer.json ----
    let snap_glob = format!(
        "{crate_root}/../embed/data/models/fastembed/models--Xenova--bge-small-zh-v1.5/snapshots/*"
    );
    let snap = glob::glob(&snap_glob)
        .expect("glob")
        .filter_map(Result::ok)
        .next()
        .expect("fastembed 缓存快照目录不存在——先跑 A1");
    let mut tok =
        tokenizers::Tokenizer::from_file(snap.join("tokenizer.json")).expect("tokenizer.json");
    tok.with_truncation(Some(tokenizers::TruncationParams {
        max_length: 512,
        ..Default::default()
    }))
    .expect("truncation");

    // 对照实验钩子：A2_DUMP_IDS=path 时把逐条 token ids + 本侧输出向量落盘，
    // 供 scripts/verify_mnn.py 用 pip-MNN 的 Python 前端独立复跑同一 .mnn，
    // 以此二分「C++ 层 bug」vs「ONNX→MNN 转换本身坏」。
    let dump_path = std::env::var("A2_DUMP_IDS").ok();
    let mut dump_rows: Vec<serde_json::Value> = Vec::new();

    // ---- 加载 MNN 模型 ----
    let c_model = CString::new(model_path.clone()).unwrap();
    let mut engine: *mut c_void = std::ptr::null_mut();
    let mut err = [0 as c_char; 512];
    let t = Instant::now();
    let rc = unsafe { mnn_bert_load(c_model.as_ptr(), &mut engine, err.as_mut_ptr(), 512) };
    if rc != 0 {
        panic!("{}", ffi_err("mnn_bert_load", &err));
    }
    let load_ms = t.elapsed().as_secs_f64() * 1000.0;
    let mut report = [0 as c_char; 1024];
    unsafe { mnn_bert_report(engine, report.as_mut_ptr(), 1024) };
    let report = unsafe { CStr::from_ptr(report.as_ptr()) }.to_string_lossy().into_owned();
    println!("[加载] {model_path} | cold_load={load_ms:.0}ms | {report}");

    // ---- 逐条推理 + 与 fastembed 基线比余弦 ----
    let mut out_vec = vec![0f32; dim as usize];
    let mut cosines = Vec::new();
    let mut first_infer_ms = None;
    let mut total_infer_ms = 0.0;
    let mut total_tokens = 0usize;

    for (i, text) in baseline.texts.iter().enumerate() {
        let enc = tok.encode(text.as_str(), true).unwrap();
        let ids: Vec<i64> = enc.get_ids().iter().map(|&v| v as i64).collect();
        let mask: Vec<i64> = enc.get_attention_mask().iter().map(|&v| v as i64).collect();
        let types: Vec<i64> = enc.get_type_ids().iter().map(|&v| v as i64).collect();
        let seq_len = ids.len() as c_int;
        total_tokens += ids.len();

        let t = Instant::now();
        let rc = unsafe {
            mnn_bert_run(
                engine,
                ids.as_ptr(),
                mask.as_ptr(),
                types.as_ptr(),
                seq_len,
                dim,
                out_vec.as_mut_ptr(),
                err.as_mut_ptr(),
                512,
            )
        };
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        if rc != 0 {
            panic!("{}", ffi_err("mnn_bert_run", &err));
        }
        if i == 0 {
            first_infer_ms = Some(ms);
        }
        total_infer_ms += ms;

        if dump_path.is_some() {
            dump_rows.push(serde_json::json!({
                "text": text,
                "ids": ids,
                "attention": mask,
                "type_ids": types,
                "mnn_out": out_vec,
            }));
        }

        let base = &baseline.embeddings[i];
        let dot: f32 = out_vec.iter().zip(base).map(|(a, b)| a * b).sum();
        cosines.push(dot as f64);
        println!(
            "[{i:>2}] len={:>3} cos={dot:.4} | infer={ms:.0}ms | {}",
            ids.len(),
            &text.chars().take(24).collect::<String>()
        );
    }

    let min_cos = cosines.iter().cloned().fold(f64::INFINITY, f64::min);
    if let Some(p) = &dump_path {
        std::fs::write(p, serde_json::to_string(&dump_rows).unwrap()).unwrap();
        println!("[dump] ids + mnn_out → {p}");
    }
    let avg_infer_ms = total_infer_ms / baseline.texts.len() as f64;
    let avg_tokens = total_tokens as f64 / baseline.texts.len() as f64;
    let peak_rss_mb = peak_rss::peak_working_set_mb();
    let model_mb = std::fs::metadata(&model_path)
        .map(|m| m.len() / 1048576)
        .unwrap_or(0);
    println!(
        "[A2 数字] model={model_mb}MB | cold_load={load_ms:.0}ms | 首条={:.0}ms 均摊={avg_infer_ms:.1}ms/条 | 平均token={avg_tokens:.0} | peak RSS={peak_rss_mb:.0}MB",
        first_infer_ms.unwrap_or(0.0)
    );

    println!("[A2 判据⑤] min cosine vs fastembed = {min_cos:.4}（≥0.99 通过）");

    unsafe { mnn_bert_unload(engine) };
}
