# PastePanda 首批 8 条短视频

本批依照《PastePanda短视频系列-整体规划-2026-10-12.md》的源码方式制作。每条只介绍一个功能与痛点，使用实际 TSX 组件、原 CSS 和图标，没有采集桌面窗口，没有从 180 秒长片裁切。

## 片单

| 编号 | 功能 | 痛点 | 时长 |
|---|---|---|---:|
| S01 | 历史找回 | 刚复制的地址被下一次复制覆盖 | 15 秒 |
| S02 | 截图取字 | 图片文字要逐字手打 | 20 秒 |
| S03 | 常用片段 | 重复回复每次重打 | 15 秒 |
| S04 | JSON 格式化 | 单行 JSON 难读 | 15 秒 |
| S05 | 文本对比 | 两个版本不知道哪里变了 | 15 秒 |
| S06 | 记录转笔记 | 有用的剪贴板内容没有整理保存 | 20 秒 |
| S07 | 依次粘贴 | 三个字段来回切窗口复制 | 25 秒 |
| S08 | 灵动岛待办 | 临时想法忙完忘了 | 15 秒 |

当前输出：`videos/pastepanda-shorts/out/S01…S08-PastePanda-功能名称-时长s-UI校正版.mp4`。总计 140 秒，8 条独立文件。使用独立文件名，避免聊天或浏览器复用旧版媒体缓存。

## UI 校正（2026-10-13）

软件区域保留 `ocean / 月白`，直接引用产品 `src/styles/theme.css`；独立标题／字幕区采用深色衬底，不为软件画面施加压暗或变色滤镜。软件画面的几何占比从 47.53% 提升到 61.38%，S01 搜索时增加聚焦镜头。

移除自写的白色“粘贴效果示意”面板。S01、S02、S03 的粘贴镜头改用原文本编辑器；S06 使用原知识库页面和笔记弹窗；S07 仅展示原队列与进度，不虚构外部应用的三个输入框；S08 使用原灵动岛的月白材质及 compose/list 尺寸。

`source/reference.tsx` 挂载真实 `src/App.tsx`，使用同一组隔离数据。S01 的主题变量、搜索框、记录卡片、弹窗和编辑区的颜色／尺寸／位置均与演示宿主一致，报告为 `out/qa/ui-reference.json`。它是实际 App 源码的浏览器对照，不是桌面截图。

完整中文配音和音乐继续沿用。8 条校正版的编码音频流 SHA256 与修改前逐条一致，见 `out/qa/audio-retained.json`。

## 源码与呈现边界

- 顶栏、记录页面与右键菜单：原 `TopBar`、`CardList`、`Sidebar`、`SuggestionBar`、`ContextMenu`；复制／保存反馈使用原 `ToastProvider`。
- 截图取文字：原 `AnnotToolbar`、`OcrDrawer`。两行示例图片与识别结果一致，画面标明“识别结果示意”。本片没有启动原生 OCR 引擎。
- 常用片段：原 `SnippetsDialog`，通过关闭的影片 IPC 适配层加载固定回复。
- JSON：原 `ItemEditorDialog` 与 `JsonEditor`；点击原“格式化”处理函数，真实执行本地解析与格式化。截帧前同时检查文本值和异步 Shiki 可见高亮，避免数据正确、画面仍旧的问题。
- 对比：原 `DiffDialog` 与 `useDiff`；实际计算两个文本的变更，仅日期 2026-10-15 → 2026-10-18 不同。
- 笔记：原 `NoteDialog` 与完整 `KnowledgeView`；同一份固定内容贯穿卡片、草稿、列表与详情。保存反馈为影片状态，不写真实数据库。
- 队列：原 `SequentialPasteDialog`，姓名、邮箱、部门按序出现，进度按 0 / 3 → 3 / 3 推进。目标应用不入镜，不以队列状态声称已经完成原生跨应用粘贴。
- 待办：原 `TodoIslandList` 与 `TodoIslandCompose`；输入“整理会议资料”与出现的任务完全一致，新增保存由影片状态驱动。

全部原生命令只进入影片专用适配层，不转发到真实数据库、设备或模型。AI 功能关闭。演示状态不作为原生执行、真实性能或识别准确率的证明；软件区域内不再新增辅助输入面板。

## 制作与复现

工程：`videos/pastepanda-shorts/`。

1. `film.build.config.mjs` 将真实源码页面编译到 `frozen/`，在端口 1493 提供此冻结版本。
2. `source/` 用固定输入与帧时钟驱动状态；弹窗位移、透明度由适配器求值。`node scripts/capture-source.mjs` 直接从冻结源码页面输出 DPR 2 的高清状态帧与真实 DOM 控件位置；保持相同状态的时段复用同一帧，动画段逐帧保留。S01 的聚焦镜头由合成层处理，鼠标位置使用同一缩放与平移计算。
3. `src/` 注册 S01–S08 八个 Remotion composition。字幕绑定 `audio/manifest.json` 实测配音起止时间。
4. `node scripts/pipeline.mjs preview`：每条三个关键节点，各检查节点与后续 12 帧。
5. `node scripts/pipeline.mjs render`：并发 1，输出 JPEG 序列，FFmpeg 编码，然后以 `-c:v copy` 合入音频。
6. `scripts/check-frames.mjs` 沿用原门槛：平铺异常 3 dB，整帧亮度跳变 25。不能通过放宽门槛掩盖问题。
7. `scripts/qa-source.mjs` 验证可见 JSON、原文本编辑器输入、笔记保存前完整标题、关闭的菜单、队列内容／进度和新增待办。
8. `scripts/check-ui-fidelity.mjs` 检查原组件结构、主题来源、软件区域占比与额外面板；`scripts/check-scene-content.mjs` 检查队列内容与顺序。二者均保留修改前的失败报告与修改后的通过报告。

音频：Xiaoxiao 中文声音，语速 +0%、音高 -2Hz，不拉伸语音；48kHz 双声道。沿用原创音乐，在旁白时降低约 9.63dB。42 句实测均落在时间窗内，约 -16 LUFS，峰值不高于 -2dBTP。音频 SRT、逐词时点和测量结果在 `audio/`。

## 动作时间

以实际配音音节结束时间微调动作，避免旁白说完成而画面尚未执行：S01 8.8 秒复制；S02 6.4 秒开始取字、8 秒显示结果、11 秒复制；S03 7.7 秒复制；S04 5.3 秒格式化；S05 5.6 秒显示对比；S06 11.4 秒保存、13 秒列表、16 秒详情；S07 9.5 / 13.9 / 17.8 秒逐项填入；S08 8.1 秒出现任务。

最终视频流、音频流、全帧质量门和浏览器播放检查的实际结果记录在 `out/`，以生成后的验证报告为准。聊天播放器受宿主影响；本地文件通过检查不代表所有聊天端播放环境都已验证。

## 渲染问题与修复

S03 首次采用实时嵌入源码 iframe，450 帧中 104、113、178、239、245、300 帧的组件层变成白板，亮度跳变约 35.7–35.8，原质量门确定失败。红结果在 `out/S03-frame-gate-before.log`，对应画面在 `out/S03-failure.jpg`。没有提高门槛或交付这版。

修复将真实源码页面先渲染成高清状态图，再使用 Remotion 的普通、不透明 `Img` 层合成；关闭弹窗时交接前后真实源码状态。没有改成桌面录制，也没有重新画界面。最终 8 条统一使用这个方式。S03 的重新渲染结果是 450 帧、平铺异常 0、超过 25 的亮度跳变 0，原质量门由红变绿，结果在 `out/S03-frame-gate.log`。

原版有 138 个状态图，UI 校正版使用 209 个高清状态图，均通过非空检查；14 个跨片抽查点与对应源码页面逐像素一致。JSON 与粘贴文本的异步高亮完成后才冻结画面。`node scripts/verify-snapshots.mjs` 与 `python scripts/check-snapshots.py` 可以复查这项，后者也拒绝一个全白反例。这项证明冻结图与源码宿主一致，实际 App 的控件对照由 `verify-ui-reference.mjs` 另外执行。

S08 初版在第 89 → 90 帧打开深色灵动岛时有 29.6 的亮度硬切，记录在 `out/S08-frame-gate-before.log`。为该出现节点补入 0.4 秒前后源码状态的平滑交接后，450 帧在原门槛下通过，结果在 `out/S08-frame-gate.log`。

UI 校正时还修复了两项问题：其一，直接注入 history 后没有失效产品筛选缓存，S07 读到了前一场景的记录；现统一清除派生缓存，姓名／邮箱／部门的顺序检查由红变绿。其二，S07 第 119 → 120 帧从记录页切到队列面板时亮度跳变 36.2；为该交接补入 0.4 秒前后原画面的渐变后，750 帧在原门槛下通过。证据分别为 `out/qa/scene-content-before.json`／`out/qa/scene-content-after.json` 和 `out/qa/S07-ui-gate-before.log`／`out/S07-frame-gate.log`。

## 启动冻结源码页面

在项目根目录执行：

```powershell
node node_modules/vite/bin/vite.js build --config videos/pastepanda-shorts/film.build.config.mjs
```

随后在 `videos/pastepanda-shorts` 目录的独立终端执行 `node scripts/serve.mjs`，保持 1493 服务运行，再执行前述截图、预览、渲染命令。片单页位于 `design/pastepanda-shorts-first8-2026-10-13.html`，服务地址为 `http://127.0.0.1:1493/design/pastepanda-shorts-first8-2026-10-13.html`。

`out/` 根目录只保留 8 个最终 MP4；工作画面与本轮备份放在 `out/work/`。最终封装检查由 `node scripts/verify-deliveries.mjs` 执行，正常速度本地播放检查由 `node scripts/verify-playback.mjs` 执行。

## 最终验收

- 8 个独立 MP4，总计 140 秒、4200 帧，1080×1920、30fps、H264/AAC、48kHz 双声道。
- 8 条全帧检查通过；音视频包的时间戳连续，MP4 的 moov 信息在媒体数据前，音轨合入后的画面编码哈希保持一致。
- UI 校正版在私有 Edge 中按正常速度播放全部 8 条：中途缓冲 0、解码错误 0、掉帧 0。各片最大帧回调间隔为 77–224ms。这是本地 HTTP 播放检查，不代表聊天宿主播放器的实测结果。交付后仅更改了文件名，媒体数据未修改。
- 封装报告：`out/verification.json`；播放报告：`out/playback.json`；状态图验证：`out/qa/snapshot-verification.json`；音频验证：`audio/verification.json` 与 `audio/validation.json`。
