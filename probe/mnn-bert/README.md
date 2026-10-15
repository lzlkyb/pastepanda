# probe/mnn-bert — 本地 embedding 探针（A2 · 复用 vendored MNN）

> **独立工程，不进主仓库构建**（同 `probe/iroh`、`probe/rc-encode`）。
> 上游：`docs/知识库-差距补全路线图-2026-10-14.md` §1 选择 A 的 🔴 附加项：
> **「MNN 能否加载并正确跑通 BERT 类模型」——这是 A2 成立的前提，必须在写实现之前探明。**

## 已代码级确认的起点（不是猜，是读过 `vendor/ocr-rs`）

`ocr-rs` 的 `cpp/src/mnn_wrapper.cpp` 是 **OCR 专用**封装，按现状跑不了 BERT：

| 局限 | 代码位置 | 对 BERT 的后果 |
|---|---|---|
| 只取**第一个**输入 tensor | `init_engine_tensors`：`input_map.begin()->second` | BERT 有 3 个输入（input_ids / attention_mask / token_type_ids），另两个被丢弃 |
| 输入**只吃 float** | `mnnr_run_inference(..., const float *input_data, ...)` + `host<float>()` | token id 是整数，float 化会改变语义（大 id 丢精度）或直接类型不匹配 |
| 输出只取第一个 | `output_map.begin()->second` | BERT 默认输出 last_hidden_state（第一个，通常是它）—— 这条影响最小 |

⇒ 本探针要分离的问题是：**卡在 wrapper，还是卡在 MNN 本身？**
wrapper 的账已经算清（多输入 + int dtype + 按名取输出，约 150 行 C++）；
本探针用一个**有意重写的 purpose-built wrapper**（`cpp/mnn_bert_probe.cpp`）
验证后半句：MNN 3.6.0（vendored prebuilt）加载 ONNX 转出的 BGE 并跑通前向。

## 判据（先写死）

| # | 判据 | 通过标准 |
|---|---|---|
| 1 | ONNX→MNN 转换 | MNNConvert 3.6.1 能转出 `.mnn`；记录转换后体积 |
| 2 | MNN 加载+前向 | `mnn_bert_run` 跑通，不崩、输出形状 [1, seq, 512] |
| 3 | **数值正确性** | 与 fastembed（ONNX Runtime）同文本 embedding 的余弦相似度 **≥ 0.99** |
| 4 | int8 量化损失 | `--weightQuantBits 8` 后体积与余弦掉幅（A2 正式方案的体积前提） |
| 5 | 推理耗时 / 加载耗时 | 与 A1 数字表同口径（单条 p50，20 条真实中文语料） |

## 运行

```bash
# 0. 前置：probe/embed 的 A1 已跑过（提供 data/a1_baseline.json 与模型缓存）
# 1. prebuilt MNN（与 build.rs 下载源一致）解压到 /tmp/mnn_probe/mnn-dev-windows-x86_64
# 2. 转换工具链：venv + MNN==3.6.1 wheel（含 MNNConvert）；scripts/convert.py 可复现转换
# 3. 编译运行（构建期需要 cl.exe；链接 MNN.dll 的 import lib，跑之前把 MNN.dll 拷到 exe 同目录）：
MNN_PROBE_INCLUDE=/tmp/mnn_probe/mnn-dev-windows-x86_64/include \
MNN_PROBE_LIB=/tmp/mnn_probe/mnn-dev-windows-x86_64/lib \
cargo build --release
A2_DUMP_IDS=/tmp/mnn_probe/a2_dump.json \
  ./target/release/mnn-bert-probe.exe /tmp/mnn_probe/bge-small-zh-fp32.mnn
```

## 结论（2026-10-15 实测）

**判据 3 不通过——但根因在上游转换器，不在 MNN 运行时本身。**

三层二分实验（`scripts/verify_mnn.py`、`scripts/verify_onnx.py`，同一组 token ids）：

| 层 | 结果 | 结论 |
|---|---|---|
| onnxruntime 跑原始 ONNX | cos vs fastembed = **1.0000 ×20** | tokenizer / CLS pooling / L2 全链路理解无误 |
| MNN 运行时（pip 3.6.1 转换） | cos ≈ 0 / 部分 NaN，**静默无告警** | 转换产物语义错误 |
| `--optimizeLevel 0` 对照 | 输出与默认逐位相同 | 图优化不是元凶，转换本体 bug |

旁证：**MNN 上游 2026-10-14（比本次实验早一天）合入
`[LLM:Bugfix] Fix bge/bert embedding and qwen2_vl/qwen2_5_vl export`**（github.com/alibaba/MNN master），
正是 bge/bert embedding 的导出修复——本探针踩中的就是它，pip 3.6.1（2026-07 发）不带此修复。

其他实测记录（重测时直接用）：
- session 输入张量被转换器转成 **int32**（喂 `Halide_Type_Int64` 整批 `Input type not match`）；
- 动态模型必须**三个输入都 resize** 再 `resizeSession`，只 resize 一个会拒绝 runSession；
- 图内输出张量是 NC4HW4，直读 `host<float>()` 是乱码，必须包一层
  `Tensor(out, TENSORFLOW)` 再 `copyToHostTensor`；shape 向量报的是 4D 化维序（如 `1 512 106`），
  按 `总元素数 == seq*dim` 校验、内存按 `[seq][dim]` 行主序解读；
- `MNN_static.lib`（57MB）是 /MT 编译，与 Rust /MD 冲突（LNK2038）→ 用 `MNN.dll` + import lib；
- `--saveStaticModel --inputConfigFile` 在 3.6.1 报 `Key Error!`（连 config 格式
  `input_names = a,b` 官方写法也不行），静态 shape 路径暂死；
- 运行时数字（错误的输出也照跑不误，故只能看性能口径）：cold_load≈140-340ms、
  均摊 5-26ms/条（seq 2-106）、**peak RSS 197MB**（A1/ort 是 1463MB，差 7 倍——这是 MNN 路线最大的性能吸引力）。

## 重测路径（A2 是否复活）

1. **等 pip MNN > 3.6.1**（含 10-14 修复），重跑 `convert.py` + 本探针，判据 3 过了再谈判据 4；
2. 或 master 源码自编译 MNNConvert（成本高，MNN C++ 全量编译）；
3. 转换正确性一旦通过，A2 相对 A1 的账不变：fp16 模型 45.4MB、RSS 197MB vs ort 1463MB。
