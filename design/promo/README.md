# PastePanda 推广短视频（竖屏 30s）

## 文件

| 文件 | 规格 | 时长 |
|---|---|---|
| `pastepanda-promo-30s-vertical.mp4` | 1080×1920 / 30fps / H.264 / 1MB | 30s |
| `preview/f040.png` … `f850.png` | 关键帧预览（540×960 缩略） | — |

## 内容脚本（30 秒 / 6 场景）

| 时间 | 场景 | 画面 | 字幕 |
|---|---|---|---|
| 0:00–0:03 | 钩子 | 大字居中，淡入 | **你复制过的东西** / 10 分钟后就没了 |
| 0:03–0:08 | 痛点 | 7 张抽象卡片向上滚动，底部淡出 | **Ctrl+V 只记得最后一条** / 新的进来，旧的就没了 |
| 0:08–0:14 | 转机 | 7 张卡片全部保留静止 + 按键提示 | **其实它全在这儿** / 按 Ctrl+Alt+V |
| 0:14–0:20 | 沉淀 | 一张卡片放大成"笔记卡"（高亮） | **右键 → 转为笔记** / 下次不用翻，直接问它 |
| 0:20–0:26 | 信任 | 三条对勾逐条淡入 | ✓ 内容全程存在你自己电脑上 / ✓ AI 默认是关的 / ✓ Windows · 开源免费 |
| 0:26–0:30 | CTA | 真实 logo + 品牌名 | **PastePanda** / 复制即沉淀 / Windows 10/11 · 开源免费 |

> **设计原则：演示界面全部抽象化（卡片矩形+几何图形），绝不伪造产品截图。**
> 只有 logo 与产品名是真实素材。文案可改；改完跑一次脚本即可重生成。

## 改文案 / 改画面

打开 `scripts/gen-promo-video.py`，只动顶部 `SCENES` 列表和每个 `scene_*` 函数里的字符串。运行：

```bash
"C:/Users/19145/.workbuddy/binaries/python/envs/default/Scripts/python.exe" \
  scripts/gen-promo-video.py
```

可选参数：
```bash
python scripts/gen-promo-video.py --out design/promo/我的版本.mp4
```

## 已知局限（生成器侧）

- **无音轨**：BGM 留空，由发布者后期加（抖音上传时自带音乐库可选）。
- **竖屏 9:16**：专为抖音/小红书竖屏规格。B 站需要可改 `W, H = 1920, 1080` 与卡片尺寸；时间轴结构不变。
- **无真机界面演示**：这是有意设计。真实界面演示请按 `docs/短视频推广方案-2026-09-10.md` §5 的分镜用 OBS + Keyviz 录屏。

## 依赖

- Pillow ≥ 10.0
- imageio-ffmpeg（自带静态 ffmpeg 二进制，无需另装）
- 中文字体：`C:/Windows/Fonts/msyh.ttc` 与 `msyhbd.ttc`
- 品牌素材：`public/icon.png`

## 后续（待你决定）

- 加 BGM：把音频文件（如 mp3）放在 `design/promo/bgm.mp3`，可在生成器末尾追加 `ffmpeg -i 视频 -i 音频 -shortest -c:a aac 终版.mp4`。
- 做横屏版（1920×1080）：复制脚本改 `W, H` 与 `STACK_TOP`、`CARD_W`，可放在同一目录 `pastepanda-promo-30s-horizontal.mp4`。
- 加 AI 概念片段：使用 VideoGen（image-to-video 或 text-to-video）生成 2–3 段 5 秒抽象镜头，告诉我接在哪几个位置。