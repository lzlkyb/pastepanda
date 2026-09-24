#!/usr/bin/env python3
"""统计裸 H.264 Annex-B 流里的 NAL 类型序列，判定每个 IDR 前是否带 SPS/PPS。"""
import sys

NAMES = {1: "P", 5: "IDR", 6: "SEI", 7: "SPS", 8: "PPS", 9: "AUD"}


def nals(d):
    out = []
    i = 0
    while i < len(d) - 3:
        if d[i] == 0 and d[i + 1] == 0 and d[i + 2] == 1:
            p = i + 3
            if p < len(d):
                out.append((p, d[p] & 0x1F))
            i = p
        else:
            i += 1
    return out


def main(path):
    d = open(path, "rb").read()
    ns = nals(d)
    seq = [NAMES.get(t, str(t)) for _, t in ns]
    print(f"文件 {path}  总字节 {len(d)}   NAL 总数 {len(ns)}")
    print("完整 NAL 序列：")
    print("  " + " ".join(seq))
    print()
    # 每个 IDR 前最近的一对 SPS/PPS（允许中间夹 SEI/AUD）
    idr_pos = [i for i, (_, t) in enumerate(ns) if t == 5]
    print(f"IDR 个数 = {len(idr_pos)}，各 IDR 之前夹的 NAL 与 SPS/PPS 归属：")
    results = []
    for i in idr_pos:
        k = i - 1
        skipped = []
        while k >= 0 and ns[k][1] in (6, 9):        # 跳过 SEI / AUD
            skipped.append(NAMES[ns[k][1]])
            k -= 1
        ok = k >= 1 and ns[k][1] == 8 and ns[k - 1][1] == 7   # PPS 且其前是 SPS
        results.append(ok)
        print(f"  IDR#{i:<5} 中间夹 = {' '.join(skipped) or '(无)':<10} "
              f"更前 = {NAMES.get(ns[k][1],'?')} {NAMES.get(ns[k-1][1],'?') if k>=1 else ''}   "
              f"{'✅ 带 SPS+PPS' if ok else '❌ 缺 SPS/PPS'}")
    ok = all(results)
    print()
    print("结论：" + ("✅ 每个 IDR 都自带 SPS/PPS，可直接喂 WebCodecs"
                    if ok else "❌ 有 IDR 缺 SPS/PPS，需 bsf 或 extradata"))


if __name__ == "__main__":
    main(sys.argv[1])
