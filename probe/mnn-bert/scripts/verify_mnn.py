# A2 对照实验：用 pip-MNN 的 Python 前端独立复跑同一 .mnn，
# 二分「C++ FFI 层 bug」vs「ONNX→MNN 转换本身坏」。
#
# 输入：a2 跑出来的 dump（A2_DUMP_IDS=path 落盘：ids + C++ 侧 mnn_out）
# 对照：embed/data/a1_baseline.json（fastembed 向量 = 真值）
#
# 判读：
#   python ≈ fastembed（cos≥0.99）→ .mnn 是好的，bug 在 C++ 层
#   python 也乱 → 转换坏（换转换参数或判 MNN 路线死刑）

import json
import os
import sys

import numpy as np

CRATE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = sys.argv[1] if len(sys.argv) > 1 else os.path.join(CRATE_ROOT, "model-fp32.mnn")
DUMP = os.environ.get(
    "A2_DUMP_IDS", os.path.join(CRATE_ROOT, "target", "a2_dump.json")
)
BASELINE = os.path.join(CRATE_ROOT, "..", "embed", "data", "a1_baseline.json")

import MNN  # noqa: E402

interpreter = MNN.Interpreter(MODEL)
session = interpreter.createSession()


def run_one(ids: list[int]) -> np.ndarray:
    seq = len(ids)
    input_all = interpreter.getSessionInputAll(session)
    for name, data in (
        ("input_ids", ids),
        ("attention_mask", [1] * seq),
        ("token_type_ids", [0] * seq),
    ):
        t = input_all[name]
        interpreter.resizeTensor(t, (1, seq))
    interpreter.resizeSession(session)
    # resize 后重新取，逐个 copyFrom
    input_all = interpreter.getSessionInputAll(session)
    for name, data in (
        ("input_ids", ids),
        ("attention_mask", [1] * seq),
        ("token_type_ids", [0] * seq),
    ):
        t = input_all[name]
        # session 张量是 int32（MNN 把 ONNX int64 输入转成了 int32；喂 Int64 会
        # 整批 "Input type not match"）。用 np.int32。
        arr = np.array([data], dtype=np.int32)
        ht = MNN.Tensor(
            (1, seq), MNN.Halide_Type_Int, arr, MNN.Tensor_DimensionType_Tensorflow
        )
        t.copyFrom(ht)
    code = interpreter.runSession(session)
    assert code == 0, f"runSession code={code}"
    out = interpreter.getSessionOutput(session, "last_hidden_state")
    shape = tuple(int(v) for v in out.getShape())
    ht = MNN.Tensor(
        shape,
        MNN.Halide_Type_Float,
        np.zeros(shape, dtype=np.float32),
        MNN.Tensor_DimensionType_Tensorflow,
    )
    out.copyToHostTensor(ht)
    hidden = np.asarray(ht.getData(), dtype=np.float32)
    # shape 可能被 4D 化，总元素数 = seq*512；按行主序 [seq][dim] 解读
    seq_real = len(ids)
    dim = hidden.size // seq_real
    hidden = hidden.reshape(seq_real, dim)
    cls = hidden[0].astype(np.float64)
    n = np.linalg.norm(cls)
    return cls / n if n > 0 else cls


dump = json.load(open(DUMP, encoding="utf-8"))
baseline = json.load(open(BASELINE, encoding="utf-8"))
base_vecs = baseline["embeddings"]

print(f"model={MODEL}")
print(f"{'idx':>3} {'py_vs_fe':>9} {'py_vs_cpp':>9}  text")
cos_py_fe, cos_py_cpp = [], []
for i, row in enumerate(dump):
    v = run_one(row["ids"])
    fe = np.array(base_vecs[i], dtype=np.float64)
    cpp = np.array(row["mnn_out"], dtype=np.float64)

    def cos(a, b):
        na, nb = np.linalg.norm(a), np.linalg.norm(b)
        if na == 0 or nb == 0:
            return float("nan")
        return float(np.dot(a, b) / (na * nb))

    c_fe, c_cpp = cos(v, fe), cos(v, cpp)
    cos_py_fe.append(c_fe)
    cos_py_cpp.append(c_cpp)
    print(f"{i:>3} {c_fe:>9.4f} {c_cpp:>9.4f}  {row['text'][:24]}")

valid_fe = [c for c in cos_py_fe if not np.isnan(c)]
print(
    f"\n[判读] python-vs-fastembed: min={min(valid_fe):.4f} "
    f"(n_valid={len(valid_fe)}/{len(cos_py_fe)}) | "
    f"python-vs-cpp: min={min(c for c in cos_py_cpp if not np.isnan(c)):.4f}"
)
if valid_fe and min(valid_fe) >= 0.99:
    print("结论：.mnn 本身是好的 → bug 在 C++ FFI 层")
else:
    print("结论：Python 前端也跑不出一致向量 → 转换/运行时层的问题")
