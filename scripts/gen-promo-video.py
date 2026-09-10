# -*- coding: utf-8 -*-
"""
PastePanda 推广短视频生成器（竖屏 1080x1920 / 30fps / 30s）

设计原则：
- 画面全部为「概念可视化」——抽象卡片、按键提示、几何图形，
  绝不伪造产品界面截图（伪造界面在推广里是致命伤）。
- 逐帧用 PIL 渲染，ffmpeg 编码，无外部素材依赖（除 logo）。
- 改文案只动 SCENES 常量区，不碰渲染代码。

用法：
    python scripts/gen-promo-video.py [--out design/promo/xxx.mp4]
依赖：pip install pillow imageio-ffmpeg
"""

import math
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H, FPS = 1080, 1920, 30
DUR = 30.0
N = int(DUR * FPS)

FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"
FONT_REG = "C:/Windows/Fonts/msyh.ttc"
LOGO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "icon.png")

BG_TOP = (14, 16, 28)
BG_BOT = (30, 24, 62)
ACCENT = (124, 92, 240)
ACCENT_L = (150, 160, 255)
WHITE = (255, 255, 255)
DIM = (138, 144, 172)
CARD = (34, 38, 58)
CARD_EDGE = (58, 64, 92)


# ---------------------------------------------------------------- 基础工具

def f(path, size):
    return ImageFont.truetype(path, size)


def ease_out(t):
    t = max(0.0, min(1.0, t))
    return 1 - (1 - t) ** 3


def ease_in_out(t):
    t = max(0.0, min(1.0, t))
    return 3 * t * t - 2 * t * t * t if t < 0.5 else 1 - ((-2 * t + 2) ** 3) / 2


def clamp01(t):
    return max(0.0, min(1.0, t))


def ramp(t, a, b):
    """t 在 [a,b] 区间内映射到 0..1"""
    if b <= a:
        return 1.0 if t >= b else 0.0
    return clamp01((t - a) / (b - a))


def build_background():
    """静态渐变底 + 两团光晕，只生成一次"""
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):
        k = y / (H - 1)
        d.line([(0, y), (W, y)], fill=(
            int(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * k),
            int(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * k),
            int(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * k),
        ))
    glow = Image.new("RGB", (W, H), (0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([-260, 180, 700, 1140], fill=(64, 46, 130))
    gd.ellipse([420, 1180, 1500, 2080], fill=(40, 34, 96))
    glow = glow.filter(ImageFilter.GaussianBlur(190))
    return Image.blend(img, Image.blend(img, glow, 0.55), 0.85)


BG = build_background()


def draw_text_center(d, y, text, font, fill, max_width=880, line_gap=22):
    """居中多行文本，返回总高"""
    lines = []
    for raw in text.split("\n"):
        cur = ""
        for ch in raw:
            if d.textlength(cur + ch, font=font) > max_width:
                lines.append(cur)
                cur = ch
            else:
                cur += ch
        lines.append(cur)
    sizes = [d.textbbox((0, 0), ln, font=font) for ln in lines]
    heights = [s[3] - s[1] for s in sizes]
    total = sum(heights) + line_gap * (len(lines) - 1)
    cy = y - total / 2
    for ln, h in zip(lines, heights):
        d.text(((W - d.textlength(ln, font=font)) / 2, cy), ln, font=font, fill=fill)
        cy += h + line_gap
    return total


def round_rect(d, box, radius, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def draw_card(d, cx, cy, w, h, alpha=255, highlight=False, lines=3, seed=0):
    """抽象的剪贴板条目卡片（不含任何产品 UI 文字）"""
    x0, y0 = cx - w / 2, cy - h / 2
    box = [x0, y0, x0 + w, y0 + h]
    a = int(alpha)
    fill = (46, 52, 80, a) if highlight else (CARD[0], CARD[1], CARD[2], a)
    edge = ACCENT + (a,) if highlight else (CARD_EDGE[0], CARD_EDGE[1], CARD_EDGE[2], a)
    round_rect(d, box, 22, fill=fill, outline=edge, width=3 if highlight else 2)

    # 卡片内的抽象内容条
    bar_x = x0 + 34
    bar_w = w - 68 - 120
    top = y0 + 28
    for i in range(lines):
        frac = [0.92, 0.74, 0.55, 0.8, 0.62][(seed + i) % 5]
        bh = 14
        by = top + i * 30
        if by + bh > y0 + h - 24:
            break
        col = (95, 104, 138, a) if highlight else (78, 85, 112, a)
        round_rect(d, [bar_x, by, bar_x + bar_w * frac, by + bh], 7, fill=col)
    # 右侧小方块（模拟类型标记）
    sq = 34
    round_rect(d, [x0 + w - 34 - sq, y0 + (h - sq) / 2, x0 + w - 34, y0 + (h + sq) / 2], 10,
               fill=(ACCENT[0], ACCENT[1], ACCENT[2], a) if highlight else (70, 76, 104, a))


def draw_keycap(d, cx, cy, label, alpha=255, font=None):
    font = font or f(FONT_BOLD, 46)
    tw = d.textlength(label, font=font)
    padx, pady = 40, 26
    w, h = tw + padx * 2, 96
    x0, y0 = cx - w / 2, cy - h / 2
    round_rect(d, [x0, y0 + 8, x0 + w, y0 + h + 8], 24, fill=(20, 22, 38, alpha))
    round_rect(d, [x0, y0, x0 + w, y0 + h], 24,
               fill=(52, 58, 88, alpha), outline=(110, 120, 170, alpha), width=2)
    d.text((cx - tw / 2, y0 + h / 2 - 26), label, font=font, fill=WHITE + (alpha,))


def draw_check(d, cx, cy, alpha):
    r = 26
    round_rect(d, [cx - r, cy - r, cx + r, cy + r], r, fill=(ACCENT[0], ACCENT[1], ACCENT[2], alpha))
    d.line([(cx - 11, cy + 1), (cx - 3, cy + 9), (cx + 12, cy - 9)],
           fill=(255, 255, 255, alpha), width=5, joint="curve")


# ---------------------------------------------------------------- 场景

CARD_W, CARD_H, GAP = 780, 104, 18
STACK_TOP = 760


def scene_hook(d, t):
    """0 - 3.2s 钩子"""
    a1 = ramp(t, 0.15, 1.15)
    txt = "你复制过的东西"
    font = f(FONT_BOLD, 104)
    full = txt
    k = int(len(full) * ease_out(a1))
    shown = full[:k]
    draw_text_center(d, 860, shown, font, WHITE + (255,))

    a2 = ramp(t, 1.7, 2.6)
    sub = f(FONT_BOLD, 76)
    draw_text_center(d, 1030, "10 分钟后就没了", sub, ACCENT_L[:3] + (int(255 * a2),))


def scene_pain(d, t):
    """3.2 - 8.0s 痛点：卡片不断被顶掉"""
    head = f(FONT_BOLD, 62)
    draw_text_center(d, 590, "Ctrl+V 只记得最后一条", head, WHITE + (255,))

    speed = 150.0
    scroll = (t * speed) % (CARD_H + GAP)
    for i in range(9):
        cy = STACK_TOP + i * (CARD_H + GAP) - scroll
        if cy < STACK_TOP - CARD_H or cy > STACK_TOP + 7 * (CARD_H + GAP):
            continue
        fade = clamp01((STACK_TOP + 6.4 * (CARD_H + GAP) - cy) / (CARD_H + GAP))
        draw_card(d, W / 2, cy, CARD_W, CARD_H, alpha=int(255 * fade), seed=i)

    note = f(FONT_REG, 40)
    a = ramp(t, -0.2, 0.8)
    draw_text_center(d, 1660, "新的进来，旧的就没了", note, DIM + (int(255 * a),))


def scene_keep(d, t):
    """8.0 - 14.0s 转机：全部留下来"""
    head = f(FONT_BOLD, 62)
    draw_text_center(d, 520, "其实它全在这儿", head, WHITE + (255,))

    for i in range(7):
        cy = STACK_TOP + 40 + i * (CARD_H + GAP)
        app = ramp(t, 0.15 + i * 0.05, 0.55 + i * 0.05)
        if app <= 0:
            continue
        draw_card(d, W / 2, cy, CARD_W, CARD_H, alpha=int(255 * app), seed=i)

    ka = ramp(t, 1.6, 2.3)
    draw_keycap(d, W / 2, 1660, "Ctrl + Alt + V", alpha=int(255 * ka))


def scene_note(d, t):
    """14.0 - 20.5s 沉淀 + 调用"""
    if t < 3.4:
        lt = t
        prog = ease_in_out(ramp(lt, 0.0, 1.4))
        h = CARD_H + (300 - CARD_H) * prog
        cy = 1000 - 60 * prog
        draw_card(d, W / 2, cy, CARD_W, CARD_H, alpha=int(255 * (1 - prog * 0.35)), seed=2)
        draw_card(d, W / 2, cy, CARD_W, h, alpha=int(255 * prog), highlight=True, lines=5, seed=2)

        a = ramp(lt, 1.0, 1.8)
        draw_text_center(d, 1520, "右键 → 转为笔记", f(FONT_BOLD, 66), WHITE + (int(255 * a),))
        a2 = ramp(lt, 2.2, 3.0)
        draw_text_center(d, 1630, "一步，它就不是临时的了", f(FONT_REG, 42), DIM + (int(255 * a2),))
    else:
        lt = t - 3.4
        draw_card(d, W / 2, 940, CARD_W, 300, alpha=255, highlight=True, lines=5, seed=2)
        # 抽象的提问气泡（几何图形，不是产品界面）
        qa = ramp(lt, 0.0, 0.8)
        q = "上次那个报错怎么解决的？"
        qf = f(FONT_BOLD, 48)
        tw = d.textlength(q, font=qf)
        bw, bh = tw + 72, 116
        bx0, by0 = (W - bw) / 2, 1280
        round_rect(d, [bx0, by0, bx0 + bw, by0 + bh], 30,
                   fill=(70, 62, 128, int(230 * qa)), outline=(ACCENT_L[0], ACCENT_L[1], ACCENT_L[2], int(200 * qa)), width=2)
        d.text((bx0 + 36, by0 + 34), q, font=qf, fill=WHITE + (int(255 * qa),))

        aa = ramp(lt, 1.0, 1.8)
        draw_text_center(d, 1520, "下次不用翻，直接问它", f(FONT_BOLD, 60), ACCENT_L[:3] + (int(255 * aa),))


def scene_trust(d, t):
    """20.5 - 26.0s 三条信任"""
    items = ["内容全程存在你自己电脑上", "AI 默认是关的，不开就零上传", "Windows · 开源免费"]
    font = f(FONT_BOLD, 56)
    for i, s in enumerate(items):
        a = ramp(t, 0.2 + i * 0.55, 0.9 + i * 0.55)
        if a <= 0:
            continue
        y = 880 + i * 130
        tw = d.textlength(s, font=font)
        x0 = (W - tw) / 2 + 52
        d.text((x0, y - 40), s, font=font, fill=WHITE + (int(255 * a),))
        draw_check(d, x0 - 52, y - 8, int(255 * a))


def render_logo(size):
    p = os.path.abspath(LOGO)
    if not os.path.exists(p):
        return None
    im = Image.open(p).convert("RGBA")
    im = im.resize((size, size), Image.LANCZOS)
    return im


LOGO_IMG = render_logo(240)


def scene_cta(d, t):
    """26.0 - 30.0s CTA（logo 由 render_frame 贴到底层）"""
    a = ramp(t, 0.0, 0.7)
    draw_text_center(d, 1120, "PastePanda", f(FONT_BOLD, 92), WHITE + (int(255 * a),))
    draw_text_center(d, 1230, "复制即沉淀", f(FONT_REG, 52), ACCENT_L[:3] + (int(255 * a),))

    b = ramp(t, 0.9, 1.6)
    draw_text_center(d, 1440, "Windows 10/11 · 开源免费", f(FONT_REG, 40), DIM + (int(255 * b),))


# ---------------------------------------------------------------- 主渲染

SCENES = [
    (0.0, 3.2, scene_hook),
    (3.2, 8.0, scene_pain),
    (8.0, 14.0, scene_keep),
    (14.0, 20.5, scene_note),
    (20.5, 26.0, scene_trust),
    (26.0, 30.0, scene_cta),
]


def render_frame(i):
    now = i / FPS
    img = BG.copy().convert("RGBA")
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    if now >= 26.0 and LOGO_IMG is not None:
        layer.paste(LOGO_IMG, (int((W - LOGO_IMG.width) / 2), 780), LOGO_IMG)
    d = ImageDraw.Draw(layer)
    for start, end, fn in SCENES:
        if start <= now < end:
            fn(d, now - start)
            break
    img = Image.alpha_composite(img, layer)
    return img.convert("RGB")


def main():
    out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else None
    out = out or os.path.join("design", "promo", "pastepanda-promo-30s-vertical.mp4")
    os.makedirs(os.path.dirname(out), exist_ok=True)

    import imageio_ffmpeg
    exe = imageio_ffmpeg.get_ffmpeg_exe()

    cmd = [exe, "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
           "-c:v", "libx264", "-preset", "medium", "-crf", "18",
           "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    for i in range(N):
        frame = render_frame(i)
        proc.stdin.write(frame.tobytes())
        if i % 60 == 0:
            print(f"frame {i}/{N}", flush=True)
    proc.stdin.close()
    err = proc.stderr.read().decode("utf-8", "ignore")
    if proc.wait() != 0:
        print(err[-2000:])
        raise SystemExit(1)
    print("OK:", os.path.abspath(out), os.path.getsize(out), "bytes")


if __name__ == "__main__":
    main()
