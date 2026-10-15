# A2 复现脚本：从 fastembed 缓存里找 bge-small-zh-v1.5 的 onnx，
# 用 venv 里的 MNNConvert（MNN 3.6.1，与 prebuilt 运行时同代）转出 model.mnn。
#
# 用法：python scripts/convert.py [--fp16]
# 前提：pip install <venv> MNN==3.6.1（wheel 见 README）；A1 已跑过（缓存里有模型）。

import argparse
import glob
import os
import shutil
import subprocess
import sys

VENV_PY = os.path.expandvars(
    r"C:\Users\19145\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
)

CRATE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_GLOB = os.path.join(
    CRATE_ROOT, "..", "embed", "data", "models", "fastembed",
    "models--Xenova--bge-small-zh-v1.5", "snapshots", "*", "onnx", "model.onnx",
)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fp16", action="store_true", help="转 fp16（默认 fp32）")
    args = ap.parse_args()

    hits = glob.glob(CACHE_GLOB)
    if not hits:
        print("未找到 onnx：先跑 A1（会缓存 Xenova/bge-small-zh-v1.5）", file=sys.stderr)
        return 1
    onnx = hits[0]
    print(f"[onnx] {onnx} ({os.path.getsize(onnx) / 1048576:.1f}MB)")

    suffix = "fp16" if args.fp16 else "fp32"
    out = os.path.join(CRATE_ROOT, f"model-{suffix}.mnn")
    cmd = [
        VENV_PY, "-m", "MNN.tools.mnnconvert",
        "--framework", "ONNX",
        "--modelFile", onnx,
        "--MNNModel", out,
    ]
    if args.fp16:
        cmd.append("--fp16")
    print("[convert]", " ".join(cmd))
    r = subprocess.run(cmd, capture_output=True, text=True)
    tail = "\n".join(
        line for line in (r.stdout + r.stderr).splitlines()
        if "convert" in line.lower() or "tensor" in line.lower() or "error" in line.lower()
    )
    print(tail)
    if r.returncode != 0:
        print("转换失败", file=sys.stderr)
        return r.returncode
    print(f"[out] {out} ({os.path.getsize(out) / 1048576:.1f}MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
