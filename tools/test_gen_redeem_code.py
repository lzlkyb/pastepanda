#!/usr/bin/env python3
"""兑换码生成脚本的自动化测试(G2)。

跑法:python tools/test_gen_redeem_code.py
验证:格式契约(前缀/长度/签名/序号唯一)+ 与 Rust 端 redeem_cross.rs 钉死的实测值一致。

本测试不依赖外部依赖,仅用标准库。
"""
import hashlib
import os
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).parent / "gen_redeem_code.py"
CODE_PREFIX = "P1"

# secret 同样从环境变量读——本文件之前也拄了一份明文，与生成器那份并列。
# 本测试以 subprocess 跑生成器，所以只要本进程有这个环境变量，子进程自然继承。
SECRET_ENV = "PASTEPANDA_REDEEM_SECRET"
SECRET = os.environ.get(SECRET_ENV, "").strip()
if not SECRET:
    print(
        f"跳过：未设环境变量 {SECRET_ENV}。\n"
        f"  Windows: set {SECRET_ENV}=<secret> && python tools/test_gen_redeem_code.py\n"
        f"  bash:    {SECRET_ENV}=<secret> python tools/test_gen_redeem_code.py"
    )
    sys.exit(0)


def sig_of(secret: str, payload: str) -> str:
    return hashlib.md5((secret + payload + secret).encode("utf-8")).hexdigest()[:8]


def run(args: list[str]) -> list[str]:
    out = subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert out.returncode == 0, f"脚本退出码非 0: {out.stderr}"
    # 解析输出:只保留形如 P1-... 的码行
    return [ln.strip().split()[0] for ln in out.stdout.splitlines() if "P1-" in ln]


def test_format_contract():
    """格式契约:P1-批次4+序号4+面额6+有效期8-签名8,总长 = 3+1+22+1+8 = 35"""
    codes = run(["GRP1", "100000", "20300101"])
    assert len(codes) == 1, codes
    code = codes[0]
    assert code.startswith("P1-"), code
    parts = code.split("-")
    assert len(parts) == 3, parts
    payload, sig = parts[1], parts[2]
    assert len(payload) == 22, f"payload 必须 22 位: {payload}"
    assert len(sig) == 8, f"签名必须 8 位: {sig}"
    assert payload[0:4] == "GRP1", "批次"
    assert payload[4:8] == "0001", "序号默认 1"
    assert payload[8:14] == "100000", "面额"
    assert payload[14:22] == "20300101", "有效期"
    # 签名 = md5(secret+payload+secret) 前 8 位(与 Rust 端一致)
    assert sig == sig_of(SECRET, payload), "签名算法与客户端不一致"
    # 与 redeem_cross.rs 钉死的实测值一致(防跨语言漂移)
    assert code == "P1-GRP1000110000020300101-a68a964a", f"与 Rust 端实测值不一致: {code}"


def test_amount_padding():
    """面额必须 6 位零填充"""
    codes = run(["BETA", "5000", "20261231"])
    payload = codes[0].split("-")[1]
    assert payload[8:14] == "005000", payload


def test_batch_lowercase_upper():
    """批次大小写规范化:生成端统一大写"""
    codes = run(["beta", "5000", "20261231"])
    payload = codes[0].split("-")[1]
    assert payload[0:4] == "BETA", payload


def test_batch_generate_multiple_unique():
    """一次生成 N 个,每个都唯一(序号递增)且通过自校验"""
    codes = run(["GRP1", "10000", "20300101", "5"])
    assert len(codes) == 5, codes
    seen = set()
    for c in codes:
        assert c not in seen, f"重复码: {c}"
        seen.add(c)
        parts = c.split("-")
        assert parts[0] == CODE_PREFIX
        assert parts[2] == sig_of(SECRET, parts[1]), "签名必须可验"
        payload = parts[1]
        assert payload[0:4] == "GRP1"
        assert payload[8:14] == "010000", "面额 6 位"
    # 序号应递增 0001..0005
    seqs = sorted(int(c.split("-")[1][4:8]) for c in codes)
    assert seqs == [1, 2, 3, 4, 5], f"序号必须递增: {seqs}"


def test_verify_rejects_tampered():
    """自校验能识破篡改(面额改动)"""
    codes = run(["GRP1", "100000", "20300101"])
    payload = codes[0].split("-")[1]
    tampered = f"P1-{payload[:8]}999999{payload[14:]}-00000000"
    # 脚本 verify 应返回 None
    from importlib.util import spec_from_file_location, module_from_spec
    spec = spec_from_file_location("gen_redeem_code", SCRIPT)
    mod = module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.verify(tampered) is None, "篡改的码不应通过校验"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  ✓ {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"  ✗ {t.__name__}: {e}")
        except Exception as e:
            failed += 1
            print(f"  ✗ {t.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
