"""对照实验：同一张图，libjpeg-turbo(PIL) vs 纯 Rust image crate 的 JPEG 编码耗时。

为什么做这个：probe/rc-encode 实测出
    2560x1440 q85 = 196.78 ms/帧（理论上限 5.1 fps）
这个数接近「真机 JPEG 兜底 190ms/帧」的整圈耗时。若 196ms 里绝大部分是
**编码器本身**，那么换一个有 SIMD 的实现就能直接提速；若大头在采集/转换，
换编码器（包括引 libx264）就没用。

本脚本用 PIL(libjpeg-turbo, 带 SIMD) 编**逐像素完全相同**的合成图，
与 Rust 探针的数字严格可比。另外补一组真实桌面截图，避免只用最坏情况下结论。
"""
import io
import time

from PIL import Image, ImageGrab

W, H = 2560, 1440
QUALITIES = [40, 70, 85]
ROUNDS = 4


def synth_rgb():
    """复现 probe/rc-encode/src/main.rs 的 build_test_image（高熵伪随机图案）。"""
    import numpy as np

    x = np.arange(W, dtype=np.int32)[None, :]
    y = np.arange(H, dtype=np.int32)[:, None]
    r = ((x * 7 + y * 3) % 256).astype(np.uint8)
    g = (((x // 3) + (y // 5)) % 256).astype(np.uint8)
    b = ((x ^ y) % 256).astype(np.uint8)
    return Image.fromarray(np.dstack([r, g, b]), "RGB")


def bench(img, q, rounds=ROUNDS):
    """与 Rust 探针同口径：丢掉第 1 次预热，其余取中位数。"""
    times = []
    size = 0
    for i in range(rounds):
        buf = io.BytesIO()
        t0 = time.perf_counter()
        # subsampling=2 -> 4:2:0，实时编码场景的常规选择
        img.save(buf, format="JPEG", quality=q, subsampling=2)
        ms = (time.perf_counter() - t0) * 1000.0
        if i > 0:
            times.append(ms)
            size = buf.tell()
    times.sort()
    return times[len(times) // 2], size


def report(tag, img):
    print(f"\n  [{tag}]")
    for q in QUALITIES:
        ms, size = bench(img, q)
        print(
            f"    质量 {q:>3}：{ms:>8.2f} ms/帧   {size / 1024.0:>7.1f} KB   "
            f"理论上限 {1000.0 / ms:>5.1f} fps"
        )


def main():
    print("=" * 59)
    print(" JPEG 编码器对照：纯 Rust image crate  vs  libjpeg-turbo(PIL)")
    print(f" 尺寸 {W}x{H}（截屏后按宽缩放到该尺寸）")
    print("=" * 59)

    print("\n【1】合成高熵图案（与 Rust 探针图像逐像素相同）")
    report("合成图案（最坏情况）", synth_rgb())

    print("\n【2】真实桌面截图（真实内容分布）")
    try:
        shot = ImageGrab.grab().convert("RGB")
        if shot.width > W:
            shot = shot.resize((W, shot.height * W // shot.width), Image.LANCZOS)
        print(f"  截图原始尺寸已归一为 {shot.width}x{shot.height}")
        report("真实桌面", shot)
    except Exception as e:  # noqa: BLE001
        print(f"  ✗ 截屏失败（可能锁屏）：{e}")

    print("\n─── 对照结束 ───")


if __name__ == "__main__":
    main()
