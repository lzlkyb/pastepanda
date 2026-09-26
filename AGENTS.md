# PastePanda 项目开发规则

> 2026-09-26 精简：规则编号保持原样不重排（历史文档 / 记忆都按编号引用）。
> 低频资料性内容整体搬到 `docs/`，改为**按需加载**；本文件只留每轮都要过一遍的硬规则。
> 搬出位置：规则 17 / 18 → `docs/交互设计范式.md`；dev 排障细节 → `docs/dev-运行手册.md`。

## 1. 先出方案再动手
修改代码前先出方案让用户确认，至少提供 2-3 个方案对比（含优缺点分析），让用户选择。

## 2. 版本号不自动递增（须经用户明确许可）
默认**不**更新版本号。无论本次做了多少功能、改了多少文件，都**不要**在未经用户明确指令的情况下递增版本号。版本号唯一来源仍是 `src-tauri/tauri.conf.json`，若升级则同步更新 `src-tauri/Cargo.toml` 的 `version` 字段，两处保持一致；`package.json` 的版本号始终是占位 `0.1.0`，不管它。可以主动**建议**「是否升到 X.Y.Z」，但由用户拍板。

## 3. 构建 exe 前要询问用户
用户确认后才执行 `npx tauri build`。

## 4. 改动 UI 要先出 HTML 设计稿
涉及 UI 变更时先生成 HTML 预览让用户确认效果。

## 5. 显式升级版本号后，等用户验证确认再提交 git
仅当本次**显式**升级了版本号时适用：不要自动提交，等用户说「提交」或「commit」再操作。

## 6. 预览测试用 Tauri dev 启动方式
项目根目录：`D:\AItool\winapp\pastePanda`（旧称 `clipboard-manager-tauri` 已废弃）。低频排障（后台常驻 dev、1420 端口占用、报错速查）见 `docs/dev-运行手册.md`。

### ⚠️ 硬性前置：Rust 编译必须设 `LIBCLANG_PATH`
ocr-rs（vendored PP-OCR 引擎）的 bindgen 阶段需要 `libclang.dll`，项目自带于 `src-tauri/.libclang/`。不设会在 `Compiling ocr-rs` 时崩。项目约定**不**持久化 `.cargo/config`，所以每个新终端都要先设这个变量。

### 启动命令（必须先在项目根目录下执行）
- **Git Bash**：注意是 `pwd -W`。裸 `pwd` 给的是 `/d/...`，bindgen 是原生 Windows 程序不认 MSYS 路径。
  ```bash
  export LIBCLANG_PATH="$(pwd -W)/src-tauri/.libclang" && npm run tauri dev
  ```
- **PowerShell**：
  ```powershell
  $env:LIBCLANG_PATH = "$(Get-Location)/src-tauri/.libclang"; npm run tauri dev
  ```
- **cmd.exe**（`set` 不加引号；跨盘切目录要 `cd /d`）：
  ```cmd
  set LIBCLANG_PATH=D:\AItool\winapp\pastePanda\src-tauri\.libclang
  cd /d "D:\AItool\winapp\pastePanda"
  npm run tauri dev
  ```

### 关键说明（踩坑点）
1. **用 `npm run tauri dev`，不要裸 `npx tauri dev`**：`npm run tauri` 会先跑 `prebuild`（sync-version + gen-changelog）再把本地 `node_modules/.bin/tauri` 加入 PATH；裸 `npx tauri dev` 会去 registry 拉到同名废弃包 `tauri@0.15.0`（无 bin），报 `could not determine executable to run`。
2. **目录必须正确**：命令失败最常见原因是在主目录执行，导致本地 `.bin/tauri` 找不到。先 `cd` 进项目根目录。
3. **一劳永逸**：`setx LIBCLANG_PATH "D:\AItool\winapp\pastePanda\src-tauri\.libclang"` 写进用户环境变量，重开终端后只需 `npm run tauri dev`。
4. **首次编译约 1 分钟**（727 个 crate），之后 Vite HMR 热更新。
5. **无害日志**：启动时 `tauri_plugin_updater ... update endpoint did not respond` 忽略即可。
6. **重启前务必彻底释放 1420 端口**：Vite node 子进程仍占着 1420 会导致下次启动窗口空白，详见 `docs/dev-运行手册.md` §3。

## 7. 方案设计需考虑代码架构
模块化、可维护性、扩展性，遵循项目已有的架构模式。

**组件文件大小限制**（硬性规则）：
- 单个 `.tsx` 组件文件 **禁止超过 300 行**（不含样式和类型定义）。
- 如果功能增长导致文件膨胀，**必须先拆分再继续**，不能无限制堆积。
- 拆分策略：自定义 Hook（`hooks/useXxx.ts`）/ 子组件（`components/XxxPanel.tsx`）/ 纯函数（`lib/xxx.ts`）。
- 新增功能时：如果目标文件已接近 300 行，默认创建新文件而非追加代码。

## 8. 做任何功能都要考虑性能
内存占用、加载速度、渲染效率、缓存策略。**不只在「设计方案」阶段，每次动手都要过下面的清单。**

- **8.1 常驻循环与动画**：新增 `animation: … infinite`、`requestAnimationFrame` 递归、`setInterval` 之前先问「不可见时会停吗？」；元素数量由数组长度决定的（粒子、装饰点），**数量就是常驻合成层数**——写死之前先算最坏情况。
- **8.2 多窗口乘法**：本项目有 4 个窗口（主窗 / 托盘弹窗 / 快捷面板 / 全屏编辑器），辅助窗口关闭走 `window.hide()` 而非 `close()`，**WebView 与 DOM 仍存活，动画照跑**。任何常驻开销默认要乘以窗口数；对策是监听失焦 / 可见性，不可见时暂停。
- **8.3 backdrop-filter（玻璃拟态）**：只要值不是 `none` 就会创建合成层并采样背后内容——**`blur(0px)` 省不掉**。不要加在会重复出现的元素上（每张卡片、每个节点），N 个元素就是 N 个层。
- **8.4 filter: blur()**：与几何形变（`skewX`/`scale`/`rotate`）一起动画时每帧重算，半径越大越贵；纯 `translate` 可缓存纹理。不动的元素上的大半径 blur 是一次性成本，不必优化（如 `.haze` 的 40px）。
- **8.5 不要写没测过的性能结论**：注释 / 文档写「开销极小」「已优化」之前必须先实测。

## 9. 方案设计需考虑用户体验
交互流畅度、反馈及时性、边界状态处理（加载中/空状态/错误）。

## 10. 改完代码不需要重启 dev
如果 dev 已在运行，Vite HMR 会自动热更新。直接看效果即可，不要每次改完代码都尝试重新启动 dev。

## 11. 公共工具函数统一放 lib/utils.ts
多个组件共用的纯函数（如 `cn`、`relativeTime`、`truncate`、`stripHtml`、`parseFilePaths`、`getImageOcrFullText`、`resolveImageCardDisplay` 等）**必须**在 `src/lib/utils.ts` 中定义并 `export`，各组件通过 `import { xxx } from "@/lib/utils"` 引用。禁止在组件文件内重复定义相同的工具函数。确保单一数据源，便于统一维护和修改。

### 11.1 新增「某类特殊处理」必须找全同类调用点并收口
本条管的不是纯函数，而是**分支逻辑**——它比重复的工具函数更难发现，失败方式是 401 / 静默错误。
- 加任何「某类 X 要特殊处理」的分支前，先 `grep` 出**所有做同一件事的取值点**，收口成一个函数，把全部调用点改为调用它，而不是逐处补 `if`。
- 收口后补一条**守卫单测**钉住不变量。需要运行环境的部分（AppHandle / IO）与纯判断分开，纯判断那半单独抽函数以便无环境测试。
- 验收标准：**如果第 7 个调用点被人新写出来时仍会走错，说明还没收口。**

## 12. 改动 UI 前必须读取真实组件源码
生成 HTML 设计稿前，必须先读取相关组件的 `.tsx` 和 `.module.css` 源码，设计稿中的样式、结构、图标、文案必须与真实代码一致，不能凭空自创样式。

## 13. 文件存放目录规范
| 文件类型 | 存放目录 |
|---------|---------|
| `.md` 文档 | `docs/`（项目根目录下） |
| `.html` 设计稿 | `design/`（项目根目录下） |

找历史设计稿前先读 `design/README.md`（由 `npm run gen:design-index` 生成）。注意该索引**不标「已落地/已废弃」**，别改成靠它猜。

## 14. git push 优先使用 SSH
本机 HTTPS 访问 GitHub 经常超时（系统代理 `127.0.0.1:26561` 不稳定），但 SSH (`git@github.com`) 始终可用。
- remote URL 用 SSH 格式：`git@github.com:lzlkyb/pastepanda.git`；若 `git push` 报 `Failed to connect` / `Connection was reset`，先 `git remote get-url origin` 检查，是 HTTPS 就 `git remote set-url origin git@github.com:lzlkyb/pastepanda.git`。
- pre-push hook 会跑完整测试（vitest + cargo test），约 3 分钟，push 的 timeout 需 ≥ 300s。

## 15. 反馈必须和触发在同一「可见性域」
- **15.1 触发常驻可见，结果就必须常驻可见。** 把操作按钮提到卡头 / 摘要卡 / 工具栏时，**同一次改动**里要把它的成功与失败展示提到同一层级。按钮和它的反馈被拆进两个可见性域 = 用户眼里的「点了没反应」。
- **15.2 条件渲染 children 的容器会卸载子组件。** `{open && children}` 在收起时**卸载**子树。把折叠态从子组件上提到父级后，必须重审子组件里所有「假定自己一直活着」的东西：`useRef` 缓存、一次性加载标记、未保存的草稿。两个选择，任选但要写明：① 接受每次展开重新加载，把注释改成真话；② 真要复用就把缓存提到不会被卸载的层级。
- **15.3 失败路径只 `setState` 不弹 toast 时**，必须确认承载它的元素在**任何折叠状态**下都可见；做不到就改用 toast。静默失败比报错难查一个量级。

## 16. AI 功能必须受 AI 开关控制（红线）
所有调用 AI/云端能力的代码路径都必须受「AI 可用性」门控。判定机制是**单一数据源**：前端 `src/lib/transforms/aiTransforms.ts` 的 `aiAvailable`（= `config.ai_enabled` && 有可用 key，默认 **false**）；后端 `commands/ai/mod.rs` 统一校验 `cfg.enabled`（默认关，测通自动开），`ai/provider.rs` 与 `ai/client.rs` 校验 key（无 key 拒绝，先于网络请求）。

**硬性要求：**
1. **未启用（`ai_enabled=false`）或未配置 key → 零可见、零请求、零费用**：前端 AI 变换/动作/建议不得出现在任何界面；后端命令入口拒绝并返回「AI 功能未启用」。
2. **新增任何 AI 功能**（变换 / 动作 / 主动建议里的 AI 项 / 试跑 / 预览 / 摘要等）必须做到：前端入口走 `aiAvailable` 门控；后端命令校验 `cfg.enabled`；计费路径（真正调用模型）双保险，`enabled` 且 key 都存在才放行。
3. **仅有的例外（用户显式触发的配置流程）**：`ai_test_connection`、`ai_preview_custom`。例外仍要求 key 校验 + 出网闸 + 预算照走，不允许无 key 调用。
4. **本地能力不算 AI 功能**：OCR（本地引擎）、自动打标签（本地正则）不联网不花钱，不受本规则约束。
5. **违规判定**：后端任何命令若调用模型但未先校验 `cfg.enabled`（且不属于第 3 条例外），视为违规。

## 17. 交互通用核心思想（跨功能适用）
→ **完整 7 条见 `docs/交互设计范式.md` §17**。触发条件：设计任何交互（截图 / 弹窗 / 面板 / 快捷键）之前必须先读。要点：鼠标全流程可达、键盘只做加速器；高频路径一步到位；有反馈不靠猜；移动即预览；误触低成本；两级取消；交互一致。

## 18. 轻预览优先交互范式（微信式，跨功能可复用）
→ **完整版见 `docs/交互设计范式.md` §18**。触发条件：做任何「先选范围再产出」的功能（截图 / 选区 / 捕获 / 打码 / 贴图 / 固定区域）前必须先读。四条原则：预览即默认、单击采纳或拖拽自定义、非模态不挡视野、两级取消。落地先例的 HTML 设计稿在 `design/`（选区拖拽即画新框 / 长截图预览即默认 / 固定区域预览即默认 / 自动打码预览式 / 贴图预览即钉），新功能优先复用同一套视觉语言（深色玻璃 + indigo/cyan 渐变、虚线紫框预览、青色终点手柄）。

## 19. UI 视觉与反馈规则（U1–U8 / L1–L6 / V1–V6）
具体条文在 **`docs/PastePanda-UI规则.md`**，流程是三步，不是「读一下」：
1. **改之前**读对应那一组：改视觉读 V1–V6，改交互读 U1–U8，改文案读 L1–L6。
2. **改之后**跑 `npm run lint:ui`（只查本次改动的行，存量不拦）。
3. 机器查不到的（U1 / U3 四状态 / U4 / L1 / L4 / L5 / V4 / V5 + 黑话测试）逐条过该文档 §9；`npm run lint:ui:all` 会把它们打出来提醒。

| 命令 | 用途 |
|---|---|
| `npm run lint:ui` | 查本次改动的行（默认） |
| `npm run lint:ui:all` | 全库基线报告，**不拦**（加 `--strict` 才当门禁） |
| `npm run lint:ui:selftest` | 校验器自身的守卫测试 |
| `node scripts/check-ui-rules.mjs --list-rules` | 打印全部判据 |
| `node scripts/check-ui-rules.mjs <文件>` | 只查给定文件的全部行 |
| `node scripts/check-ui-rules.mjs --staged` | 只查暂存的行（pre-commit 用） |

**豁免**：确是「间距和背景色都不行」这类情况，就在那一行写 `/* ui-rule-ok: <理由> */`——**必须带理由**，只写标记不写理由会被当成违规报出来。

一条都不能忘的底线：U6 只许语义色（色名变量不得进新代码）、U7 WCAG 2.2 AA、U8 新组件不许内联 `style={{}}`、V3 颜色只能来自变量。分工与本文件其他规则不重叠：规则 4/9/12/15/17/18 管「交互该怎么设计」，U1–U8 管「做出来的东西该长什么样、什么时候动、动多久、出了状况怎么告诉人」。

---

## 发版流程

### ⚠️ 硬性前置（违反会导致更新弹框 + 关于页日志空白）
**打 tag 之前必须先完成：**
1. 在 `CHANGELOG.md` 顶部写好新版本段落（只分 `新增`/`改进`/`修复` 三类；**禁止**技术/UI/UX 等开发视角分类）
2. 运行 `npm run prebuild`（内部执行 `sync-version.mjs && gen-changelog.mjs`），确认 `src/lib/changelog.generated.ts` 已包含新版本条目
3. 提交上述两个文件的变更

> 如果 CHANGELOG.md 没有对应版本段落，CI 提取日志会回退到「常规构建发布」，UpdateNotesDialog 和 ChangelogView 都会显示空白。

### 正式步骤
当用户说 **"tag"** 或 **"打tag"** 时，自动执行完整发版流程（无需逐步确认）：
1. 递增版本号（`tauri.conf.json` patch +1，同步 `src-tauri/Cargo.toml`）
2. 确认 CHANGELOG.md 已就绪且 `changelog.generated.ts` 已重新生成
3. `git add`（排除 `src-tauri/config_backups/`）
4. 生成带前缀的 commit message（`feat:`/`chg:`/`fix:`），标题 + 空行 + 详细变更列表
5. `git commit`
6. `git push origin master`
7. `git tag v{version}` → `git push origin v{version}`（触发 GitHub Actions 构建发布）

### 发版后收尾
需要补充更新日志时：`gh release edit v{version} --notes-file notes.md`；替换 updater.json 用 `gh release upload v{version} dist/updater.json --clobber`。Gitee 镜像由 CI 自动同步，若 404 检查 `GITEE_REPOSITORY` secret 是否为 `lzul/pastepanda`。Release 更新日志来源：CI 优先从 `CHANGELOG.md` 提取当前版本段落，找不到才回退 git log。

### Commit 前缀规范（影响 Release 自动分类）
| 前缀 | Release 分类 |
|------|-------------|
| `feat:` | ✨ 新功能 |
| `chg:` / `change:` | 🔄 变更 |
| `fix:` | 🐛 修复 |
| `refactor:` | 🔧 重构 |
| `docs:` | 📖 文档 |

### CHANGELOG 写作规范（硬性规则）
CHANGELOG.md 是**给用户看的**，只说「能做什么」，不说「怎么实现的」。

**允许的分类（仅这 3 个）：** `新增`（用户可用的新功能）/ `改进`（体验提升、性能优化、界面调整）/ `修复`（用户可感知的 bug 修复）。

**禁止出现：** 文件名、函数名、变量名（如 `editorRegistry`、`canvas.toBlob`）；技术实现细节（「模块拆分」「树摇优化」「状态机」「事务原子性」）；代码架构变更（「重构为 XX 模式」「抽离 XX hook」）；测试数量、覆盖率、chunk 大小等开发指标；`技术`/`UI/UX`/`安全`/`性能`/`崩溃与数据完整性` 等分类。

**条目合并原则**：相关小改动合并为一条（如 58 项 UX 修复合并成 5-6 条按主题分组）；每条不超过 2 行；安全/性能/架构改进若无用户可感知变化，可不写或合并到「改进」里一句话带过。

示例——❌ 开发者视角（`### 技术` / 「useImagePreview 新增 exportFormat… canvas.toBlob 转码…」）；✅ 用户视角（`### 新增` /「图片格式转换与压缩：支持 PNG/JPG/WebP 切换，可调质量，实时估算文件大小」）。
