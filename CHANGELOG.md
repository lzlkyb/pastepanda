# Changelog

PastePanda 版本更新日志。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

## [5.1.2] - 2026-07-24

### 新增
- 统一细粒度编辑器架构（方案 A）：editorRegistry 按类型 / content_type / 默认三级解析 + ItemEditorDialog 共享外壳（Esc / Ctrl+Enter / 脏数据守卫）
- P4 专用编辑器：颜色（lib/color.ts 全链路 + 棋盘格色块 + HEX/RGB/HSL 三格式复制）、表格（表格/编辑双模式 + Markdown/JSON 导出 + 分隔符互转）、密钥（默认脱敏 + 15 秒倒计时自动回脱敏 + JWT/AWS/GitHub/Base64 类型徽章）
- Card 标题与 Popover 密钥自动脱敏（复制操作仍取真实值）
- ImageEditor 格式转换 + 压缩：PNG/JPG/WebP 分段切换、10-100 质量滑块、220ms 防抖真实体积估算、canvas.toBlob 转码（jpeg 先铺白底避免透明黑边）
- ImageEditor 裁剪：viewport canvas 按当前 scale/rotation 烘焙、8 手柄 + 三分线、Enter 确认、原图保留可还原
- FileDetailDialog 多文件支持：parseFilePaths 统一单/多路径，单文件顺修 JSON 数组旧数据，多文件汇总卡 + 逐文件操作 + 批量打开（按父目录去重）/ 复制全部路径
- FileDetailDialog 快速预览面板：图片缩略图、文本前 20 行带行号、二进制/不存在/空文件占位
- Rust 新命令 `read_text_file_preview`：UNC 路径安全校验 + 128KB 上限 + 8KB 内 NUL 二进制检测 + lossy UTF-8 解码

### 技术
- src/lib/imageFormat.ts 纯逻辑模块：EXPORT_FORMATS / withExportExt / formatBytes
- src/lib/csv.ts、src/lib/secret.ts 纯逻辑模块（与 Rust 分类器规则对齐）
- src-tauri/src/lang_arbiter.rs：tree-sitter 语法 ERROR/MISSING 字节比例投票（阈值 0.25），规则置信低时仲裁
- 测试覆盖 498/498（+12 imageFormat.test.ts，23 个测试文件）
- useImagePreview 新增导出与裁剪状态机，bakeImage 返回 Promise<canvas>

### UI/UX
- FileDetailDialog 单文件 w380 / 多文件 w420 自适应宽度，多文件行点击切换预览（选中高亮）
- ImagePreviewDialog 工具栏新增裁剪按钮（active 高亮）与导出选项行
- 裁剪叠加层：55% 黑色遮罩 + 白色虚线选区 + 8 个带 accent 描边的手柄 + 深色尺寸提示标签

## [5.1.1] - 2026-07-23

### 新增
- 更新说明弹框（UpdateNotesDialog）：检测到新版本时自动弹出，展示结构化更新日志（分类卡片 + 摘要 + 数量徽章），支持跳过版本和一键下载
- 更新日志浏览器（ChangelogView）：嵌入设置 → 关于 tab，可折叠的版本历史列表，当前版本高亮，支持"查看全部 N 个版本"
- 关于 tab 未读红点：有新版本可用或有未查看的更新日志时，"关于" tab 显示脉冲红点提醒，切换后自动标记已读
- DownloadRing 下载进度环：Header 徽章内 14px SVG 圆环，确定态显示百分比弧，不确定态整体旋转
- 下载速率显示：前端实时计算下载速度（如"1.2 MB/s"），Header 徽章和 Banner 进度条均展示

### 技术
- gen-changelog.mjs 构建脚本：解析 CHANGELOG.md 生成结构化 TypeScript 数据（15 版本 8 分类），prebuild 自动运行
- changelog.ts 类型层：ChangelogEntry/ChangeCategory 类型 + 版本比较 + lastSeen 工具函数
- UpdateContext 新增 progressIndeterminate（total 为 null 时 true）和 bytesPerSec 状态
- 更新后端多源 failover：Gitee manifest → ghproxy → GitHub 直连，指数退避重试
- 跳过版本：localStorage 按版本号存储跳过标记，支持"跳过此版本"操作
- 主题 CSS 新增 --accent-glow 和 --hero-glow 变量（7 套主题独立 RGB）
- CI Gitee 镜像同步：生成 updater-gitee.json + releases 分支 latest/ 目录覆盖式推送

### 修复
- api-images.test.ts Blob instanceof 跨域失败：改用 duck-type 检查（.type + .size）

## [5.1.0] - 2026-07-22

### 新增
- 代码架构重构：Rust 父目录 mod.rs + 多 impl 块拆分模式（data_store→7 模块、commands→11 模块）
- content_type 统一：Rust classify() 单次分类→labels+content_type 入 DB，前端 contentTypes.ts 纯映射，旧数据 null 回退前端检测兜底
- 自动清理定时：setInterval 每小时周期触发历史清理（cutoff 使用 chrono::Local::now 修复时区偏移）

### 技术
- 前端模块拆分：api.ts→11 模块，无文件超过 1000 行且 API 不变

## [5.0.148] - 2026-07-21

### 新增
- 剪贴板栈：Ctrl+Shift+K 进入栈模式，正常 Ctrl+C 复制的内容逐条入栈，Ctrl+Shift+P 逐条粘贴并弹出栈顶，栈空自动退出
- 栈模式横幅：列表上方橙色横幅，显示收集/粘贴进度，支持「全部粘贴」（300ms 间隔连续粘贴）和手动退出
- 入栈卡片标记：橙色左边框 + 左上角序号角标，栈顶（下一个粘贴）脉冲高亮，已粘贴条目变灰打勾
- 托盘图标状态：栈模式激活时图标右上角叠加橙色圆点
- 入栈规则：与栈顶内容相同自动去重，上限 50 条，支持文本/图片/文件全类型
- 栈快捷键可自定义：设置 → 快捷键新增「栈模式开关」「栈顶粘贴」两行录制器，修改后即时重注册，失败自动回滚

### 技术
- appStore 新增 stackMode / stackItems / stackDoneIds / stackCollected 状态及对应 actions
- hotkey_manager 注册栈切换 + 栈粘贴全局热键；HotkeyConfig 新增 stack_toggle / stack_paste 字段，快捷键从配置读取（不再硬编码）
- AppConfig 新增 stack_toggle_hotkey / stack_paste_hotkey（默认 ctrl+shift+k / ctrl+shift+p），reregister_hotkeys 与启动注册均读取
- tray_manager 新增 set_tray_stack_mode：程序化绘制橙色圆点覆盖层切换托盘图标
- 新增 StackBanner 组件 + 卡片栈标记样式；栈模式下依次粘贴 FAB 自动隐藏（互斥）

### 修复
- 粘贴抑制恢复"hash 主检查 + 时间兜底"双重机制：监听循环补回时间窗口检查，修复 hash 清除后轮询竞态导致的自粘贴重复记录，以及无 hash 路径（文件粘贴）抑制失效的问题（同时消除 is_suppressed 死代码警告）

### UI/UX 体验专项（58 项全部修复，详见 docs/UI-UX审计报告-5.0.148.md）

**High（10 项）**
- U1 仅粘贴成功时弹"已粘贴"，失败弹具体错误（原成功失败都弹成功）
- U2 收藏/置顶即时持久化到数据库（原重启即丢失）
- U3 右键菜单打开时不再双重处理键盘事件（原可能误触发删除/粘贴）
- U4 Esc 分层优先级：先关对话框 → 再取消多选 → 最后才隐藏窗口
- U5 启动/开机自启不再弹窗抢焦点，遵循"隐藏到托盘"设置
- U6 首次"隐藏到托盘"提示改走系统级可见通道（原发进已隐藏窗口永远看不到）
- U7 默认全局热键改为低冲突组合（原劫持常用系统快捷键）
- U8 内容提取对话框复制/存片段给出明确 toast 反馈
- U9 正则预置规则编辑走规范流程（原静默失败），删自定义规则增加确认
- U10 片段库批量删除增加确认对话框

**Medium（26 项）**
- U11/U12/U13/U14 删除统一为"直接删 + 撤销 toast"；点空白/Esc 可退出多选；删除后焦点移到最近存活邻居；Home/End 选中并滚动到对应位置
- U15/U16 依次粘贴 FAB 计数与遍历改用同一过滤数据源、筛选变化重置指针；重置按钮改为独立 button（原嵌套 span 键盘不可达）
- U17/U18 快捷键面板按实际配置渲染；单击去掉 200ms 延迟即时选中
- U19/U20 文件卡片标题显示"a.txt 等 3 个文件"（原显示原始 JSON）；空状态识别任意活动筛选并给出"清除全部筛选"按钮
- U21/U22 卡片悬浮操作层在顶部自动向下翻转（原被裁切不可见）；正则替换子菜单伪表头改为非交互标题
- U23/U24 剪贴板捕获改为静默记录（原每次弹 toast 刷屏）；栈模式补全快捷键面板说明与可见入口
- U25 片段库：使用次数显示真实值、"最近使用"按真实时间排序、空名称禁止保存、编辑未保存弹确认、复制给 toast
- U26 热键录制器：支持清除热键、Esc 取消给提示、校验提示常驻、显示格式化为 Ctrl + Shift + K
- U27/U28 设置新增"恢复默认设置"；"栈"术语改为"收集模式"等用户友好表述
- U29/U30 二维码生成失败给出原因（文本过长）+ 重试按钮；"全部存为片段"改名"存为片段（已选）"
- U31/U32 全部 15 个对话框加焦点陷阱 + aria-modal；设置页脚增加"所有设置修改后自动保存"提示并删除死保存代码
- U33 托盘弹窗点图片/文件条目走真实粘贴通道（原粘贴"[图片] WxH"占位文本）
- U34/U35 热键注册失败弹"N 个快捷键被占用 + 去设置"可操作 toast；热键冲突回滚时明确告知冲突项并回显实际生效值
- U36 敏感内容防护：应用排除名单 + 密钥/凭证模式不记录开关 + 局域网同步跳过敏感条目

**Low（22 项）**
- U37 索引粘贴越界给出 toast 提示（原静默失败）
- U38 图片预览工具条提示与实际一致（滚轮平移 · Ctrl+滚轮缩放 · 0 重置）
- U39 方向键/Home/End 导航改经 Lenis + virtualizer 滚动（原 scrollIntoView 与平滑滚动打架）
- U40 Shift+F10 菜单弹在焦点卡片旁（原弹在列表中央）
- U41 搜索占位符改为"输入即搜"，搜索范围覆盖文件路径/图片文件名
- U42 悬浮弹层增加 180ms 悬停意图延迟（原鼠标扫过连续弹出）
- U43 aria-live 从虚拟列表容器移到专用隐藏状态节点（原对读屏器极吵）
- U44 Space 快速预览支持图片/文件（原仅文本、按键被吞零反馈）
- U45 对话框宽度类名实相符（w400/w420/w380/w460）+ max-width 响应式防溢出
- U46 Diff 跳转按真实行高计算并双栏同步滚动；按钮文案改"复制旧文本/新文本"
- U47 编辑对话框打开自动聚焦编辑器
- U48 正则规则管理器内联"试一试"输入框（ReDoS 安全）
- U49 正则预览对话框调好的参数可存回自定义规则
- U50 片段库空状态文案与实际按钮名一致
- U51 文件详情对话框支持 Esc 关闭并纳入全局对话框状态管理
- U52 设置"通用"页顶部增加吸顶搜索框，按关键词过滤设置项、自动隐藏空分区
- U53 Toast 下移避开标题栏右上角窗口控制按钮
- U54 托盘图标双击去抖（600ms 内第二下忽略），不再闪烁后停在相反状态
- U55 未处理 Promise 拒绝改弹友好文案（技术细节仅入日志）
- U56 快速预览长行改横向滚动 + 行号列吸附左侧、固定行高逐行对齐（原换行致行号错位）
- U57 粘贴抑制收紧：hash 设防时仅匹配刚粘贴内容才跳过，粘贴后 3 秒内的新复制正常记录（原静默丢数据）
- U58 栈"全部粘贴"增加进度条 + 中止按钮，全局热键（再按 Ctrl+Alt+P）/ Esc 可中止，中止给 toast

### 安全（代码审计专项，详见 docs/代码审计报告-5.0.148.md）
- C1 粘贴前前台窗口确认失败时中止粘贴并报错（原静默继续，可能粘错窗口）
- C2/C3 局域网同步改为 AES-256-GCM 加密 + 随机 nonce + 时间窗口重放防护（M12），拒绝 UNC/非本地路径；配对密钥强度校验（M14），弱密钥自动重新生成
- C14-C18 资源限制：图片解码尺寸/体积上限、正则执行 300ms 时间预算 + 按行分块（ReDoS 防护，C17）、导入条数上限 5 万
- M16 CSP 收紧：移除失效的 unsafe-eval / esm.sh / Google Fonts / https: 通配
- device_id 改用完整 UUID（原 32bit 前缀易碰撞/伪造）
- 配对密钥明文存储属共享密钥配对的固有设计取舍，评估后接受（密钥需可跨设备粘贴）

### 崩溃与数据完整性
- C4 ToastProvider 位置修正，恢复全部错误反馈（此前 toast 空转无输出）
- C6/M10 粘贴操作加互斥锁 + 原子弹栈，修复快速连按重复粘贴/跳过条目
- C7 pasteImage 错误上抛（原吞掉），C8 监听器失败后复位 running（原无法重启）
- C9 图片抑制 hash 口径统一，C10 改 ON CONFLICT DO UPDATE，C13 initBackend 先加载配置再拉历史
- 新增 clear_history_with_undo：读取被删记录 + 加载标签 + 事务删除在同一连接锁内原子完成，消除命令层先读后删的竞态
- find_latest_by_md5 增加 workspace 过滤，修复跨工作区智能合并误合并
- data_store 全部锁获取改用 lock_conn()（Mutex 中毒后自动恢复，避免 panic 永久毒化 DB 连接）
- hotkey_manager 注册失败自动回滚到最近一次成功配置（OnceLock 保存 last-good）
- tray_manager / clipboard_monitor 引入 RAII drop 守卫复位标志/计数（panic-safe），分类线程并发上限 4
- SystemParametersInfoW 失败时托盘弹窗定位回退 1920×1080（原定位到屏幕外）

### 性能
- M17/M18 虚拟列表滚动优化：模块级 memo 行组件 + 稳定回调（itemsRef 模式），Toast Context 值 memo 化
- M25 缩略图按可视窗口加载，M26 滚动定位改用 getOffsetForIndex + 动画后校正
- 图片复制改用 fetch(dataUrl) 浏览器原生解码，替代主线程 atob + 逐字节循环（大图阻塞数百毫秒）
- OCR 词框 DOM 测量从每词一次提升为整层一次，消除渲染期 O(n) 强制布局
- ExtractDialog 类型计数 memo 化，Card 标题/菜单 memo + 截断保护

### 其他修复（Low）
- 依次粘贴/索引粘贴改用与 UI 一致的过滤后列表；非循环模式到末尾给出提示（原静默）
- 栈进度分母改用真实收集总数 stackCollected，修复 50 条上限截断后进度虚高
- 栈内同 id 条目（智能合并复用 id）：序号徽章取最靠栈顶位置，置灰仅在条目不再位于栈内时生效
- EditDialog 有未保存修改时关闭（Esc/×/遮罩）先弹确认，避免静默丢弃编辑
- ExtractDialog 电话/IP 正则收紧（数字边界 + 0-255 段校验），减少误报
- HotkeyRecorder 重写：需修饰键、冲突检测、Esc 取消，修复 Ctrl+Space 无法录制
- localStorage 旧 pasteship_* 键一次性迁移到 pastepanda_*（保留老用户提示状态）
- Zustand 反模式清理：set updater 内 _filterCache 改为返回 partial 清除，updateConfig 副作用移出 updater

## [5.0.147] - 2026-07-19

### 新增
- 正则过滤/替换：右键「粘贴并变换 → 正则替换」分组，展示已启用规则，点击后弹出预览对话框
- 正则预览对话框：左右分栏（原文高亮匹配 / 替换结果高亮变更），顶部可临时编辑正则+替换串+标志调试
- 正则规则管理弹窗：预设 8 条规则（去空行/去空格/合并空格/移除行号/URL解码/手机号脱敏/身份证脱敏/去HTML标签）可开关，自定义规则可增删改
- 规则存储于 localStorage，无需后端改动；ReDoS 防护（try/catch + 大文本截断）

### 技术
- 新增 regexRules.ts 数据层（预设规则 + CRUD + safeApplyRegex）
- RegexPreviewDialog / RegexRulesDialog 独立 chunk 懒加载
- ContextMenu buildTransformMenu 新增正则替换分组 + 管理入口

## [5.0.146] - 2026-07-19

### 新增
- 历史对比 (Diff)：Ctrl 多选恰好 2 条文本记录 → 批量工具栏「对比」按钮，打开全屏 Diff 对话框
- Diff 对话框支持左右分栏、行号列、同步滚动、差异统计（+N / -N）
- 按行 / 按词两种对比模式切换，支持「忽略空白」选项
- 差异跳转导航：上一处 / 下一处按钮 + 当前位置指示，目标行蓝色描边高亮
- 列头标注旧/新文本来源和时间，底部支持复制左侧 / 复制右侧

### 技术
- 新增 diff (jsdiff) 依赖 + @types/diff，DiffDialog 组件独立 chunk 懒加载
- 组件拆分：DiffDialog.tsx（主框架）+ DiffPane.tsx（单侧面板）+ useDiff hook（diff 计算 + 对齐 + 词级高亮）

## [5.0.145] - 2026-07-19

### 新增
- 二维码生成：右键菜单「生成二维码」，支持 URL/文本（≤300字）生成 QR Canvas，可复制图片或保存 PNG
- HTML 转纯文本：右键菜单「粘贴并变换 → 剥离 HTML 标签」，使用 DOMParser 安全去除标签保留文本
- EditDialog 变换工具栏新增「去标签」按钮（仅 HTML 内容时显示）

### 技术
- 新增 qrcode 依赖 + @types/qrcode，QRCodeDialog 组件独立 chunk 懒加载
- 新增 isHtml() / stripHtml() 工具函数（lib/utils.ts），DOMParser 解析 + 正则回退

## [5.0.144] - 2026-07-19

### 新增
- Markdown 实时预览：检测到 MD 内容时，EditDialog 顶部出现「编辑 | 预览」切换按钮，默认进入预览模式
- Markdown 渲染支持 GFM（标题/列表/代码块/表格/引用/任务列表/图片），代码块自动语法高亮（highlight.js）
- 预览模式底部新增「复制为 HTML」「复制为纯文本」快捷操作
- 卡片 hover 弹窗支持 Markdown 渲染预览（compact 模式，限高 120px）
- 卡片副标题新增蓝色「MD」徽标标识 Markdown 内容
- 右键菜单新增「Markdown 预览」入口（仅 MD 内容显示）
- 新增 isMarkdown() 检测函数（11 条语法规则，命中 2 条以上判定为 MD）

### 技术
- 新增 marked + dompurify 依赖，MarkdownRenderer 组件独立 chunk 懒加载（~72KB）
- DOMPurify 防 XSS，marked 输出 HTML 先过 sanitize 再渲染

## [5.0.143] - 2026-07-19

### 新增
- 颜色值拾取预览：剪贴板内容若整体是 Hex/RGB/HSL 颜色值，卡片上直接显示实时色块预览 + 格式小徽标
- 右键菜单新增“复制为 HEX/RGB/HSL”，支持三种颜色格式互转（保留 alpha 透明度）

## [5.0.142] - 2026-07-19

### 修复
- 修复 read_file_as_base64/get_image_data_url/save_image_file 缺少路径校验导致的任意文件读写风险，新增图片扩展名白名单 + 敏感目录黑名单
- 修复 open_file_with_system 通过 cmd /C start 存在命令行注入风险，改用 explorer.exe
- 修复局域网同步无鉴权、同网段任意设备可伪造消息注入剪贴板历史，新增配对密钥签名校验
- 修复数据库迁移失败被静默吞掉导致后续操作报错、搜索关键词未转义 SQL 通配符、批量打标签非事务性
- 修复数据库初始化失败直接崩溃无提示，改为弹窗提示后退出
- 修复粘贴后 3 秒抑制窗口内会丢失真实剪贴板变化、分组状态与前端展示不同步
- 修复筛选缓存失效遗漏（新增/置顶/拖拽排序后列表不刷新）、置顶与加载更多的并发竞态
- 修复图片预览快速切换时的竞态覆盖、多文件路径变换损坏输出、右键菜单需点两次才关闭
- 修复更新检测过期定时器覆盖新状态、下载按钮无防抖、事件监听器泄漏、计数刷新竞态
- 修复内容分类三处误判（短 JSON 被当纯文本、命令行检测误判英文单词、驼峰标识符误判为密钥）
- 修复极端宽高比图片生成缩略图可能崩溃、高 DPI 缩放下来源图标尺寸错误
- 修复热键注册冲突无提示、托盘右键连点阻塞界面、图片置顶窗口单实例保护失效
- 修复粘贴时前台窗口切换未校验，可能粘贴到错误窗口
- 修复长文本截断可能切断 emoji 等多字节字符

## [5.0.141] - 2026-07-07

### 修复
- 修复 CI 测试失败 — pasteText 增加 invoke 返回空值保护；sequentialPaste 非循环模式下指针越界直接 return 而非重置
- 测试 beforeEach 中 invoke mock 设置默认返回值 `{ success: true }`

## [5.0.140] - 2026-07-07

### 修复
- 修复依次粘贴在微信/企业微信等现代应用中失效 — 粘贴引擎从 WM_PASTE 消息改为 SendInput 模拟 Ctrl+V 按键
- 修复 sequential paste 第 2+ 条粘贴目标窗口错误 — last_foreground_hwnd 加 2 秒 TTL 过期机制，不再在每次粘贴后清除

### 变更
- 热键触发时第一时间调用 save_foreground_hwnd 保存目标窗口
- PasteResult 增加 target_hwnd/clipboard_written/wm_paste_sent 诊断字段

## [5.0.126] - 2026-07-06

### 修复
- 修复窗口状态恢复 — window-state 插件从 .plugin() 链移至 .setup() 闭包，确保先恢复后显示
- 修复侧边栏开关时窗口宽度漂移问题

### 变更
- 侧边栏宽度 220px → 180px，内容区更宽敞
- 侧边栏开关改为纯 CSS transition，窗口宽度不再随侧边栏变化

### 重构
- 移除 Rust animate_window_width 命令及相关代码（~70行）
- 简化 App.tsx 侧边栏切换逻辑，删除 isTogglingRef/logicalWidthRef/初始化宽度同步

## [5.0.118] - 2026-07-05

### 新功能
- 侧边栏改版 — macOS Finder 风格，独立背景色，来源分组带颜色标识

### 变更
- 优化更新检查与状态展示，新增侧边栏设计稿和方案文档

### 修复
- FAB 依次粘贴悬浮按钮移至卡片面板内，侧边栏打开时不再遮挡

## [5.0.117] - 2026-07-05

### 变更
- 参考 CC Switch 架构全面优化
- CSP connect-src 改为 https: 通配模式

### 修复
- 修复自动更新检查失败 — CSP 缺失 GitHub 域名
- 修复 BackToTop 回到顶部按钮点击失效问题

## [5.0.113] - 2026-07-04

### 变更
- SettingsDialog 重构为子组件模式，优化各组件代码

### 修复
- 添加缺失的 settings 子组件文件，修复 CI 构建报错

## [5.0.112] - 2026-07-04

### 变更
- 移除快捷键悬浮按钮并优化布局间距
- 引入 Lenis 平滑滚动库替换自实现滚动引擎

### 重构
- Tab 计数改为后端查询 + 30s 缓存，移除前端增量维护

## [5.0.111] - 2026-07-03

### 新功能
- Timeline Mini 模式优化 — 方案 C+D 组合
- 设置页面滚动隐藏 Tab Bar + Tab 切换动画

### 变更
- 时间轴多项优化 + 节点间距自动对齐

### 重构
- 样式模块化 — 从全局 CSS 拆分为组件级 CSS Module
