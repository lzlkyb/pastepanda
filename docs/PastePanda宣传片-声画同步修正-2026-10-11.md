# PastePanda 宣传片声画同步修正

成片：`videos/pastepanda-demo/out/PastePanda-完整介绍-180s-声画同步修正版.mp4`。保持 180 秒、19 个章节、1280×720、30 fps，以及源码 UI 和演示数据标注。

## 原因与修改

旧版配音按功能清单写成 19 个段落，每段统一从章节开始后 0.4 秒播放；它只与章节对齐，没有与具体操作对齐。编辑器画面实际依次展示 Markdown 正文、CSV 表格、文本对比，旁白却介绍图片裁剪和压缩。远程电脑画面只显示设备、权限和操作入口，旁白却描述进入远程会话。

新版将旁白改写为 43 条动作短句，并在 `audio/narration-sync.json` 显式记录播出区间和对应画面可见区间。所有句子统一使用原速，不用逐句加速适应时长。只讲当前画面展示的状态或动作；未实际演示的端到端操作不再当作已经发生的动作讲述。

原片段库弹窗只停留约 0.73 秒，无法容纳对应解说。本次将其调整为 29.233–31.333 秒，提取界面为 31.333–33.500 秒，二维码界面为 33.500–36.000 秒；重新渲染第 840–1079 帧。其余镜头保留原帧序列。旧版无声和有声 MP4 都保留，修正版使用新文件名。

## 验证

回归用例 `scripts/qa-sync.cjs` 修改前报红：`At frame 50, speech needs 片段库, but dialog is:`。调整镜头后，50 / 105 / 180 帧分别命中片段库 / 提取 / 二维码，通过。

43 条配音均处于对应可见区间内，没有人声重叠，语速均为 1.000 倍。另用 TTS 的 WordBoundary 时间定位关键词，检查其发音时刻的实际源码界面，18 项检查通过；JSON 格式化额外确认文本已从单行变为多行。结果保存在 `audio/sync/visual-sync-qa.json`。

| 解说关键词 | 实际发音检查时间 | 画面检查 |
|---|---:|---|
| 片段库 | 29.787 秒 | 片段库弹窗可见 |
| 链接 | 32.478 秒 | 内容提取弹窗可见 |
| 二维码 | 34.305 秒 | 二维码弹窗可见 |
| 箭头 | 39.658 秒 | 箭头正在绘制 |
| 马赛克 | 43.477 秒 | 遮挡区域可见 |
| 文字 | 47.533 秒 | OCR 结果可见 |
| 正文 | 59.459 秒 | Markdown 正文 |
| 表格 | 62.231 秒 | CSV 表格 |
| 对比 | 65.599 秒 | 文本对比弹窗 |
| 完成 | 158.819 秒 | 已完成待办 |

完整画面检查仍为 5400 帧，坏帧和亮度跳变检查通过，阈值未放宽。成片视频流与本次修正的无声视频流 SHA-256 一致。音轨采样时间戳连续；视频帧时间戳连续且恒定 30 fps。实测响度 -15.98 LUFS、真实峰值 -1.94 dBTP，人声相对音乐最小高出 14.70 dB。

这次修正针对旁白内容与动作时间的对应关系。此前发现的弹窗硬切和鼠标目标切换问题，不在本次修正中宣称已解决；独立浏览器播放检查也不能代表聊天播放器的表现。

独立 Edge 播放完整 180 秒，只有起播时出现 waiting，播放中无 waiting / stalled 事件或媒体时钟停顿；呈现仍丢帧 90/5400，前 15 秒记录到最长 1.217 秒的帧回调间隔。该段检查与音轨解码分析、源码 UI 核验同时运行。随后仅播放前 32 秒的复核仍记录到 40/965 帧呈现丢帧及约 0.37 秒的回调间隔。因此不能宣称卡顿已修复，也不能仅凭文件的连续时间戳把问题归因于聊天播放器。两次记录分别保存为 `audio/sync/browser-playback.json` 与 `audio/sync/browser-playback-short.json`。

## 复现

保持源码展示服务 1492 和项目预览服务 1491 运行。在视频工程目录执行局部画面渲染：

```powershell
node scripts/pipeline.mjs patch 840-1079 --sync
```

在项目根目录执行：

```powershell
python videos/pastepanda-demo/scripts/sync-narration.py
node videos/pastepanda-demo/scripts/qa-sync.cjs
python videos/pastepanda-demo/scripts/verify-audio.py --sync
python videos/pastepanda-demo/scripts/audit-playback.py --sync
node videos/pastepanda-demo/scripts/qa-playback.cjs --sync
```

新配音、逐词时间、字幕、混音和验证结果位于 `videos/pastepanda-demo/audio/sync/`。相关脚本继续支持原版输出，未覆盖原版文件。
