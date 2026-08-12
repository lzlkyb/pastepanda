#!/usr/bin/env python3
"""PastePanda 兑换码生成器（开发者运营用，v6.9）。

用法：
    python gen_redeem_code.py <批次> <面额> <有效期> [数量]

    <批次>   4 位字母/数字，如 GRP1、BETA、V101
    <面额>   token 数量（整数，最多 999999；不设累计上限，安全上限 1 亿由客户端兜底）
    <有效期> yyyyMMdd，如 20300101（过期后客户端拒收）
    [数量]   生成 N 个同批次同面额的码（默认 1）

示例：
    python gen_redeem_code.py GRP1 100000 20300101      # 单个 10 万码
    python gen_redeem_code.py BETA 50000 20261231 20    # 20 个 5 万码

算法与客户端 `data_store/quota.rs` 的 generate_redeem_code / verify_redeem_code
完全一致（md5(secret+payload+secret) 前 8 位 hex；payload = 批次4+序号4+面额6+有效期8），
生成的码可直接在应用内兑换。批量时序号自动递增（1..N），保证每个码唯一。

注意：secret 从环境变量 `PASTEPANDA_REDEEM_SECRET` 读，**不写在本文件里**（本仓库远端
是公开的 GitHub，明文 secret 一推就等于任人可签任意面额的合法码）。
其值必须与客户端 `redeem_secret()` 还原出的值一致；本身仅是「防普通用户猜码」级别。
"""

import hashlib
import os
import sys

# secret 从环境变量读，**不得写回源码**。
#
# 原先这里是明文常量，三件事叠在一起很危险：
# ① tools/ 不在 check_no_plaintext_secrets.sh 的扫描范围内（那时只看 src-tauri/src），
#    所以守卫报“✅ 通过”的同时 secret 就明文躺在这里；
# ② tools/ 与 tools/__pycache__ 都没被 gitignore，会随提交进去（.pyc 里同样有）；
# ③ 远端是公开的 GitHub。一旦推上去，任何人能签出任意面额的合法兑换码，
#    花的是内置公共免费 key 的配额。
#
# 用法（Windows）：  set PASTEPANDA_REDEEM_SECRET=<secret>
# 用法（bash）：     export PASTEPANDA_REDEEM_SECRET=<secret>
# secret 的值 = 客户端 src-tauri/src/data_store/quota.rs::redeem_secret() 还原出的那个串。
SECRET_ENV = "PASTEPANDA_REDEEM_SECRET"
CODE_PREFIX = "P1"


def _secret() -> str:
    """取 secret；未设时**硬失败**。

    不能回退到空串：那会静默生成一批签名错误、客户端全拒收的废码，
    而发给用户后才发现。
    """
    s = os.environ.get(SECRET_ENV, "").strip()
    if not s:
        raise SystemExit(
            f"未设环境变量 {SECRET_ENV}——secret 不再写在本脚本里。\n"
            f"  Windows: set {SECRET_ENV}=<secret>\n"
            f"  bash:    export {SECRET_ENV}=<secret>"
        )
    return s


def sig_of(secret: str, payload: str) -> str:
    return hashlib.md5((secret + payload + secret).encode("utf-8")).hexdigest()[:8]


def generate(batch: str, amount: int, expiry: str, seq: int = 1) -> str:
    """生成单个码。seq(1~9999)保证同批次批量唯一,payload = 批次4+序号4+面额6+有效期8。"""
    payload = f"{batch}{min(seq, 9999):04d}{min(amount, 999_999):06d}{expiry}"
    return f"{CODE_PREFIX}-{payload}-{sig_of(_secret(), payload)}"


def verify(code: str) -> dict | None:
    """自检用：与客户端 verify_redeem_code 逻辑一致。"""
    parts = code.strip().upper().split("-")
    if len(parts) != 3 or parts[0] != CODE_PREFIX:
        return None
    payload, sig = parts[1], parts[2]
    if len(sig) != 8:
        return None
    # 新格式 22 位:批次4+序号4+面额6+有效期8;旧 18 位(无序号)仍接受
    if len(payload) == 22:
        batch, amount_s, expiry = payload[0:4], payload[8:14], payload[14:22]
    elif len(payload) == 18:
        batch, amount_s, expiry = payload[0:4], payload[4:10], payload[10:18]
    else:
        return None
    if sig.lower() != sig_of(_secret(), payload):
        return None
    amount = int(amount_s)
    import datetime

    if expiry < datetime.date.today().strftime("%Y%m%d"):
        return None
    if amount <= 0:
        return None
    return {"batch": batch, "amount": amount, "expiry": expiry}


def main() -> int:
    if len(sys.argv) < 4:
        print(__doc__)
        return 1
    batch = sys.argv[1].upper()
    try:
        amount = int(sys.argv[2])
    except ValueError:
        print("面额必须是整数 token 数")
        return 1
    expiry = sys.argv[3]
    count = int(sys.argv[4]) if len(sys.argv) > 4 else 1

    if len(batch) != 4:
        print("批次必须是 4 位（字母/数字）")
        return 1
    if not (0 < amount <= 999_999):
        print("面额必须在 1 ~ 999999 之间")
        return 1
    if len(expiry) != 8 or not expiry.isdigit():
        print("有效期必须是 yyyyMMdd（如 20300101）")
        return 1
    if count < 1 or count > 1000:
        print("数量必须在 1 ~ 1000 之间")
        return 1

    print(f"批次 {batch} · 面额 {amount:,} token · 有效期 {expiry} · 数量 {count}\n")
    for i in range(count):
        # 序号 1..count 保证同批次批量码唯一（G2 测试抓到的 bug 修复）
        code = generate(batch, amount, expiry, seq=i + 1)
        ok = verify(code) is not None
        # 用 ASCII 标记而不是 ✓/✗：中文 Windows 控制台默认代码页 936（GBK），
        # U+2713 在 GBK 里无映射 → print 直接抛 UnicodeEncodeError，
        # 码算出来了却一个都没打完，脚本以 1 退出——运营在本机根本拿不到码。
        print(f"  {code}   {'[OK] 自检通过' if ok else '[FAIL] 自检失败！'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
