# 判别实验：onnxruntime 跑原始 ONNX（与 a1 的 fastembed 同一模型文件、同一组 ids）。
# onnx ≈ fastembed → ONNX 没问题，锅在 MNN 转换；否则 ONNX/pooling 理解有问题。

import json
import os
import sys

import numpy as np
import onnxruntime as ort

CRATE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DUMP = os.environ.get(
    "A2_DUMP_IDS", os.path.join(CRATE_ROOT, "target", "a2_dump.json")
)
BASELINE = os.path.join(CRATE_ROOT, "..", "embed", "data", "a1_baseline.json")
ONNX = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.environ.get("TEMP", "/tmp"), "mnn_probe", "bge-small-zh.onnx"
)

sess = ort.InferenceSession(ONNX, providers=["CPUExecutionProvider"])
print("onnx inputs:", [(i.name, i.type, i.shape) for i in sess.get_inputs()])
print("onnx outputs:", [(o.name, o.type, o.shape) for o in sess.get_outputs()])

dump = json.load(open(DUMP, encoding="utf-8"))
baseline = json.load(open(BASELINE, encoding="utf-8"))
base_vecs = np.array(baseline["embeddings"], dtype=np.float64)

cos_all = []
for i, row in enumerate(dump):
    seq = len(row["ids"])
    ids = np.array([row["ids"]], dtype=np.int64)
    mask = np.array([row["attention"]], dtype=np.int64)
    types = np.array([row["type_ids"]], dtype=np.int64)
    out = sess.run(None, {
        "input_ids": ids,
        "attention_mask": mask,
        "token_type_ids": types,
    })[0]
    # Xenova 导出的 last_hidden_state: [1, seq, dim]
    if out.ndim == 3:
        cls = out[0, 0].astype(np.float64)
    else:  # 已含 pooling
        cls = out[0].astype(np.float64)
    n = np.linalg.norm(cls)
    v = cls / n if n > 0 else cls
    c = float(np.dot(v, base_vecs[i]) / (np.linalg.norm(v) * np.linalg.norm(base_vecs[i])))
    cos_all.append(c)
    print(f"{i:>3} cos_vs_fastembed={c:.4f}  out_shape={out.shape}  {row['text'][:24]}")

print(f"\n[判读] min={min(cos_all):.4f} max={max(cos_all):.4f}")
print("ONNX 层正确" if min(cos_all) > 0.99 else "ONNX 层就不对——pooling/模型理解有误")
