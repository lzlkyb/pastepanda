# PastePanda 完整软件介绍视频分镜

当前阶段：19 章源码 UI 动画与 MP4 已完成，整片逐帧检查通过。

## 已确认与本次扩展

- 沿用用户已认可的月白主题、左侧标题与右侧真实 UI 排布。
- 从 15 秒单功能样片扩展为 180 秒软件总览；按记录、处理、沉淀、互联的顺序组织。
- 主要能力演示真实操作，同类小工具用清单字幕覆盖；不把每个小功能展开成教程。
- 记录、工具、知识、截图工具条、编辑器、同步设置、远程电脑、待办与统计直接引用产品组件及 CSS；录屏控制条复用真实组件结构，以视频帧控制状态。
- 所有示例材料来自公开仓库；AI 与统计输出须标为演示，不使用个人数据库、不实际调用模型。

## 180 秒分镜

| 时间 | 章节 | 操作与覆盖 | 源码 |
|---|---|---|---|
| 0–6s | 软件定位 | 从主窗口起镜，依次点亮三个真实模式入口。<br>记录 / 工具 / 知识三种模式 | `src/components/ModeSwitcher.tsx` |
| 6–18s | 记录与查找 | 新增复制内容进入列表 → 输入关键词 → 高亮命中 → 收藏并切换筛选。<br>文本、图片、文件、图文记录；搜索与拼音首字母；类型 / 时间 / 来源 / 标签筛选；收藏、分组、工作区；多选、批量操作、撤销删除 | `src/components/TopBar.tsx`、`src/components/CardList.tsx`、`src/components/Sidebar.tsx` |
| 18–28s | 高效粘贴 | 连续复制三段演示文本 → 收进栈 → 顺序粘贴到演示表单。<br>快捷粘贴面板；依次粘贴与索引粘贴；粘贴栈：逐条 / 全部 / 模板；纯文本粘贴与正则替换；自定义快捷键 | `src/components/QuickPastePanel.tsx`、`src/components/SequentialPasteDialog.tsx`、`src/components/StackTemplateDialog.tsx`、`src/components/RegexRulesDialog.tsx` |
| 28–36s | 片段与提取 | 选取模板并展开变量 → 提取链接 → 显示二维码。<br>片段库与动态变量；链接 / 邮箱 / 电话提取；二维码生成与识图解码 | `src/components/SnippetsDialog.tsx`、`src/components/ExtractDialog.tsx`、`src/components/QRCodeDialog.tsx` |
| 36–50s | 截图、标注与 OCR | 选区预览 → 箭头标注 → 打码 → OCR 选字；补充展示长截图与贴图。<br>窗口吸附与区域截图；矩形 / 椭圆 / 箭头 / 画笔 / 高亮 / 文字 / 序号 / 橡皮擦；马赛克 / 模糊 / 自动打码；去水印与自动去水印；本地 OCR 与选字；长截图、贴图置顶、固定区域 | `src/components/screenshot/ScreenshotOverlay.tsx`、`src/components/screenshot/tools.tsx`、`src/lib/screenshot/ocrSelect.ts`、`src/lib/screenshot/longshotEvents.ts` |
| 50–58s | 屏幕录制 | 框选区域 → 录制状态条 → 最近录制中的预览 / GIF 导出入口。<br>全屏 / 选区录屏；系统声音与麦克风；暂停 / 继续 / 停止；MP4、预览裁剪与 GIF 导出 | `src/components/recsel/RecSelectOverlay.tsx`、`src/components/recsel/RecRecentList.tsx`、`src/components/settings/sections/RecRows.tsx` |
| 58–68s | 编辑与预览 | 同一批材料在 Markdown、表格、图片与 Diff 视图之间切换。<br>全屏多标签编辑器与语法高亮；Markdown、CSV 表格与颜色预览；图片裁剪 / 压缩 / 格式转换；文件预览与批量管理；密钥限时查看与脱敏；文本 / 配置对比 | `src/components/editors/ItemEditorDialog.tsx`、`src/components/DiffDialog.tsx`、`src/components/ImagePreviewDialog.tsx`、`src/components/FileDetailDialog.tsx` |
| 68–82s | 开发者工具 | 打开工具模式 → 按分类筛选 → 展示 JSON、SQL 与日志的真实输入输出。<br>全部真实工具入口；Base64 / URL / Unicode / HTML 实体 / JWT；JSON 格式化、校验与压缩；SQL 格式化、IN / INSERT 转换；Properties / YAML / JSON 互转与语义 Diff；日志过滤、统计与错误提取；时间戳、进制、字节换算；编码转换、批量替换、内容提取 | `src/lib/toolbox.ts`、`src/components/ToolboxView.tsx`、`src/lib/transforms/codecTransforms.ts`、`src/lib/transforms/sqlTransforms.ts`、`src/lib/transforms/configConverts.ts` |
| 82–90s | 变换与动作链 | 网页文本 → 剥离 HTML → 去空行 → 输出；短切流程图与今日整理入口。<br>按内容推荐变换；本地文本 / 文档清洗与脱敏；自定义动作链与条件步骤；截图后自动执行本地链；新建流程图与今日整理 | `src/components/TransformHubDialog.tsx`、`src/components/ChainEditor.tsx`、`src/lib/chains/registry.ts`、`src/lib/toolbox.ts` |
| 90–104s | 内容沉淀 | 沿用前一章的材料 → 转为笔记 → 移入文件夹 → 编辑并回看版本。<br>卡片转笔记 / 新建笔记；文件夹、标签、收藏与多种视图；Markdown 编辑与今日速记；待沉淀区与待确认草稿；版本历史、回收站与恢复；Markdown 目录导入导出 | `src/components/KnowledgeView.tsx`、`src/components/notes/NoteList.tsx`、`src/components/notes/NoteDialog.tsx`、`src/components/notes/kbMoreMenu.tsx` |
| 104–112s | 知识检索与连接 | 检索已有笔记 → 跳到命中段落 → 沿双向链接打开关联内容。<br>本机全文检索与命中定位；双向链接与反向引用；库体检与失效链接检查 | `src/components/KnowledgeView.tsx`、`src/components/notes/KnowledgeToolbar.tsx`、`src/components/notes/KbHealthBar.tsx` |
| 112–124s | 可选 AI | 显示开启与配置入口 → 单条内容动作 → 知识库问答的引用回到原文。<br>翻译、摘要、改写、润色、提取要点；解释 / 修复代码、生成正则与 SQL；JSON 转类型、表格化、回复草稿；合并整理、周报、今日小结、流程图；带引用的知识库问答与 AI 成文；自定义服务商 / 动作与预算管理 | `src-tauri/src/ai/actions.rs`、`src/components/settings/AiTab.tsx`、`src/components/notes/KbQaPanel.tsx`、`src/lib/transforms/aiTransforms.ts` |
| 124–132s | 连接外部 AI 工具 | 从知识库更多菜单进入 MCP 设置 → 展示连接配置与工具入口。<br>MCP 配置与连接；外部工具检索 / 引用 / 读写笔记；本机服务与访问控制 | `src/components/settings/McpTab.tsx`、`src/components/notes/kbMoreMenu.tsx` |
| 132–140s | 跨设备同步 | 两个演示设备配对 → 复制内容到另一台 → 笔记同步状态变化。<br>剪贴板局域网同步；知识库配对与同步；电脑 / 手机互联入口 | `src/components/settings/LanSyncPanel.tsx`、`src/components/settings/KbSyncPanel.tsx`、`src-mobile/devices/RcDevicesView.tsx` |
| 140–152s | 远程电脑 | 打开真实远程电脑入口 → 选设备 → 同意连接 → 查看 / 操作 / 传文件。<br>设备配对与临时连接；远程查看 / 操作；会话权限与状态反馈；剪贴板与文件传输；手机端设备与会话入口 | `src/components/rc/RcWorkbench.tsx`、`src/components/settings/sections/RcSection.tsx`、`src-mobile/devices/RcFilesView.tsx` |
| 152–160s | 待办灵动岛 | 输入一条演示待办 → 收起为胶囊 → 提醒 → 勾选完成。<br>灵动岛折叠 / 悬停 / 展开；新建与完成待办；到点提醒、排序与停靠位置 | `src/components/todo/TodoIsland.tsx`、`src/components/settings/sections/IslandSection.tsx` |
| 160–166s | 使用回顾 | 展示来源 / 时段 / 常用动作统计，短切画像、学习记录与成就。<br>数据统计与周报；我的画像与学习记录；里程碑与成就 | `src/components/WeekReportDialog.tsx`、`src/components/ProfileDialog.tsx`、`src/components/LearningsDialog.tsx`、`src/components/AchievementsCard.tsx` |
| 166–174s | 外观、隐私与管理 | 原样切换主题 → 展示设置分区 → 用本地存储与可选 AI 收住隐私说明。<br>月白 / 深海 / 午夜 / 森林 / 美乐蒂 / 晨曦；快捷键、托盘与开机自启；历史导出 Excel / CSV / JSON 与数据导入；清理策略、备份与回收站；敏感内容防护、本地存储、本地 OCR；AI 默认关闭与自动更新 | `src/lib/theme.ts`、`src/components/SettingsView.tsx`、`src/components/settings/sections/DataSection.tsx`、`src/components/settings/sections/meta.ts` |
| 174–180s | 品牌收尾 | 回到同一组材料的最终状态；保留软件名与核心定位。<br>记录 · 处理 · 沉淀 · 互联 | `src/components/ModeSwitcher.tsx` |

## 从当前源码提取的功能清单

这些清单核对的是已存在的入口与注册定义，不代表逐项跑过原生端到端测试。AI 动作只在启用并配置后展示。

### 工具入口

依次粘贴 / 片段库 / 内容提取 / 新建流程图 / 今日整理 / 编码转换 / 批量替换 / 配置对比 / 文本对比 / 全屏文本对比 / 二维码 / SQL 工具 / JSON 工具 / 日志分析 / 时间戳 / 数字 / 屏幕录制 / 远程电脑

### 内容变换与动作（含联网动作）

SQL IN / SQL IN（按列） / SQL IN（分隔值） / 拆解 IN 列表 / INSERT 语句 / 表格 → INSERT / 大写 / 小写 / 去空白 / 去空行 / 剥离 HTML 标签 / Markdown 链接 / 代码块 / HEX / RGB / HSL / 反斜杠路径 / 正斜杠路径 / 文件名 / 合并为单行 / 转为 YAML / 转为 JSON / 转为 Properties / Base64 编码 / Base64 解码 / URL 编码 / URL 解码 / Unicode 编码 / Unicode 解码 / HTML 转义 / HTML 反转义 / JWT 解析 / 时间戳 → 日期 / 日期 → 时间戳 / SQL 格式化 / SQL 压缩 / SQL 关键字大写 / 日志统计 / 提取错误行 / 进制转换 / 字节换算 / 千分位 / 时间戳解读 / 格式清洗 / 转 Markdown / 表格 → Markdown / PDF 断行修复 / 打开链接 / 在资源管理器打开 / 发送邮件 / 查询 IP / 域名 / 粘贴脱敏 / 链接摘要 / JSON 格式化

### 截图标注工具

矩形 / 椭圆 / 箭头 / 画笔 / 高亮 / 马赛克 / 模糊 / 去水印 / 自动打码 / 自动去水印 / 文字 / 序号 / 橡皮擦

### 可选 AI 动作

翻译 / 一句话摘要 / 建议标签 / 清洗成知识库文章 / 解释代码 / 改写语气 / 润色纠错 / 提取要点 / 写 commit message / JSON → 类型定义 / 修复代码 / 生成正则 / 生成 SQL / 继续处理 / 表格化 / 回复草稿 / 合并整理 / 生成周报 / 生成今日小结 / 生成流程图 / 展开子流程 / 润色节点文字 / 问知识库 / AI 成文

## 制作验收

- 19 个分镜总长 180 秒；每章功能与其源码对应。
- 主要功能有独立操作镜头；辅助能力可在清单字幕中逐项找到。
- 所有 UI 的文案、布局、图标和配色来自当前源码，演示数据明确标注。
- AI 未开启的章节不展示可执行 AI 动作，不产生模型请求。
- 先检查各章关键帧，再渲染 MP4 并检查闪烁、缺帧和字幕可读性。

## 视频工程与复现

工程目录：`videos/pastepanda-demo`。采用 `agentic-product-demo` 的 Remotion 工作流，输出 1280×720、30 fps、180 秒的无声首版。

源码展示页由独立 Vite 服务提供，Remotion 每帧发送章节与帧号，收到真实 React UI 完成布局的确认后截图。主题变量从 `src/styles/theme.css` 提取；字体使用产品的 Microsoft YaHei。鼠标坐标取自实际按钮位置。

```powershell
# 在项目根目录启动源码展示页，保持此进程运行
npx vite --config videos/pastepanda-demo/film.vite.config.mjs

# 另一个终端进入视频工程
Set-Location videos/pastepanda-demo
npm install --ignore-scripts --registry=https://registry.npmmirror.com
npx tsc --noEmit
node scripts/qa-source.cjs
node scripts/pipeline.mjs preview
node scripts/pipeline.mjs render
```

`out/preview-manifest.json` 保存 19 章的 38 张关键帧。完整输出为 `out/PastePanda-完整介绍-180s.mp4`；JPEG 序列以单并发渲染后用 FFmpeg 编码，最终运行 `check-frames.mjs --standalone`，检查画面重复与亮度跳变。检测阈值沿用技能原值。

演示层拦截原生 IPC，不读取个人数据库，不建立真实设备连接，也不调用模型。知识库回答标为“回答示意”；录屏列表引用本项目已有的本地录制文件。统计来自五条公开仓库演示材料。视频是功能总览：主功能有 UI 场景，同类辅助能力由章节字幕概括；并非逐个按钮的端到端测试或操作教程。

## 最终验证记录

- `npx tsc --noEmit`：通过。
- `node scripts/qa-source.cjs`：19 章、38 次页面检查通过，运行错误与未处理 IPC 警告均为 0；截图高度和录屏控制条尺寸守卫通过。
- 视频新增布局的 UI 检查：0 个阻断问题；4 条间距建议保留已确认的视频版式。
- 对 19 章的关键帧完成视觉检查。修正截图容器高度、录屏控制条尺寸、待办悬浮层尺寸与宽屏字幕遮挡。
- 首次整片检查发现第 928 帧界面空白，宽屏修订后检查发现第 1779 帧界面空白；均以源码重新渲染修补，原 JPEG 序列保留。
- 最终 `check-frames.mjs --standalone`：5400 帧、1280×720，重复画面检测为 0，亮度跳变检测为 0。阈值未放宽。
- 无声首版保留；另已完成中文配音与背景音乐版。

## 中文配音与背景音乐版

输出：`videos/pastepanda-demo/out/PastePanda-完整介绍-180s-中文配音音乐版.mp4`，180 秒、中文女声、立体声 AAC。声音使用 Microsoft Edge TTS 的 `zh-CN-XiaoxiaoNeural`，19 段文字来自 `audio/narration.json`；每段在章节开始后 0.4 秒进入，并在章节结束前留出间隙。少量较长段落使用不改变音高的轻微加速，最大 1.113 倍。

背景音乐复用 `videos/pastepanda-story/audio/bgm-original.wav` 的项目原创素材，以完整和声循环延长到 180 秒。音乐做首尾淡化，并在人声出现时降低约 9.6 dB。`audio/audio_meta.json` 记录音色、文字、实际起止时间和冻结音频路径；`audio/中文解说.srt` 单独保存解说字幕，不烧入原画面。

```powershell
# 在项目根目录运行；依赖使用项目已有 .cache/promo-python
python videos/pastepanda-demo/scripts/add-narration.py
python videos/pastepanda-demo/scripts/verify-audio.py
```

有声版使用 `-c:v copy` 合成。验证结果保存在 `audio/verification.json`：原版与有声版视频流 SHA-256 完全相同；19 段均在章节范围内；实测综合响度 -15.97 LUFS、真实峰值 -1.92 dBTP，人声相对背景音乐最小高出 15.11 dB。原画面逐帧检查结果继续有效。
