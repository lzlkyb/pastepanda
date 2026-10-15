# probe/embed — 本地 embedding 探针（A1 · fastembed-ort）

> **独立工程，不进主仓库构建**（同 `probe/iroh`、`probe/rc-encode`）。
> 上游：`docs/知识库-差距补全路线图-2026-10-14.md` §2 S0-P1。
> 回答的问题只有一个：**本地 embedding 值不值得做、走哪条路（A1 fastembed-ort / A2 复用 MNN）。**
> 探针产物不进包、不发布 ⇒ 零体积成本；结论写回路线图后才谈 S1 实施。

## 判据（先写死，改判据先改这里；跑完才想该看什么 = 白跑）

| # | 判据 | 怎么量 |
|---|---|---|
| 1 | 模型磁盘体积（MB） | 下载完成后量 fastembed 缓存目录 |
| 2 | 首启加载时间（ms） | `TextEmbedding::try_new` 到首次 embed 可用；cold（含下载）/ warm（缓存命中）分开报 |
| 3 | 吞吐 | 单条 embed p50/p95（ms）；批量 32 条一批的每条均摊（ms/条）→ **1k 篇索引耗时 = 1000 × 均摊（外推，注明）** |
| 4 | 内存峰值（MB） | 进程 PeakWorkingSetSize（Windows GetProcessMemoryInfo） |
| 5 | 中文召回对比 | 语料 = 真实库 **13 条 notes**（路线图写的 30 条 —— 真实库只有 13，偏差已记录）；查询两路：① 每条笔记标题（自检索 sanity）② 10 条**复述查询**（ synthetic，明确标注非真实查询 —— 真实查询校准等 S0-P2）。指标：源笔记在余弦 top-1/top-5 命中；**FTS5 复刻对照**（同库 DDL + `to_ngram` 双侧 + `to_match_expr` + bm25(10,1,0) 排序，忠于 `note.rs` 现状） |

两个必须随结果一起报的**集成成本事实**（已代码级确认，不是猜）：
- fastembed-rs 7.x **无 query/passage 区分**（单一 `embed()`），BGE-zh v1.5 官方查询前缀
  「为这个句子生成表示以用于检索相关文章：」不会自动加 ⇒ 走 A1 必须自己加。
- fastembed 的 `BGESmallZHV15` 拉的是 **Xenova/bge-small-zh-v1.5 的 fp32 ONNX**（~95MB），
  路线图体积表里「int8 ≈ 23MB」对 A1 **不成立**（fastembed 模型清单里没有中文量化变体）。

## 运行（顺序不能换）

```bash
# 0. 语料：从真实 clipboard.db 快照导出（只读拷贝，不碰活库；产物含用户真实内容 → data/ 已 gitignore）
python scripts/export_corpus.py

# 1. A1 数字表 + 召回对比（HF 需可达；不通就 HF_ENDPOINT=https://hf-mirror.com）
cargo run --release --bin a1_fastembed

# 2. 结果落在 data/a1_result.json；A2（MNN）见 ../mnn-bert/README.md
```

依赖口径：fastembed **pin 精确版本**（该 crate 两周三次 patch，10-14 记录 6.0.3 → 今天已 7.1.1）。
