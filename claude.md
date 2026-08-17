# PastePanda 项目开发规则

## 1. 先出方案再动手
修改代码前先出方案让用户确认，至少提供 2-3 个方案对比（含优缺点分析），让用户选择。

## 2. 版本号不自动递增（须经用户明确许可）
默认**不**更新版本号。无论本次做了多少功能、改了多少文件，都**不要**在未经用户明确指令的情况下递增版本号。版本号唯一来源仍是 `src-tauri/tauri.conf.json`，若升级则同步更新 `src-tauri/Cargo.toml` 的 `version` 字段，两处保持一致；`package.json` 的版本号始终是占位 `0.1.0`，不管它。可以主动**建议**"是否升到 X.Y.Z（如本次流程图功能可升到 6.11.0）"，但由用户拍板——用户说"不更新"就保持原版本号不变。

## 3. 构建 exe 前要询问用户
用户确认后才执行 `npx tauri build`。

## 4. 改动 UI 要先出 HTML 设计稿
涉及 UI 变更时先生成 HTML 预览让用户确认效果。

## 5. 显式升级版本号后，等用户验证确认再提交 git
仅当本次**显式**升级了版本号时适用：不要自动提交，等用户说"提交"或"commit"再操作。

## 6. 预览测试用 Tauri dev 启动方式

项目根目录：`D:\AItool\winapp\pastePanda`（旧称 `clipboard-manager-tauri` 已废弃，文档里若见到该名一律按本项目根目录理解）。

### ⚠️ 硬性前置：Rust 编译必须设 `LIBCLANG_PATH`
ocr-rs（vendored PP-OCR 引擎）的 bindgen 阶段需要 `libclang.dll`，项目自带于
`src-tauri/.libclang/`。不设会在 `Compiling ocr-rs` 时崩：
`Unable to find libclang ... set the LIBCLANG_PATH environment variable to a path where one of these files can be found`。
项目约定**不**持久化 `.cargo/config`，所以每个新终端都要先设这个变量（见下）。

### 启动命令（必须先在项目根目录下执行）
- **Git Bash / WSL**：
  ```bash
  export LIBCLANG_PATH="$(pwd)/src-tauri/.libclang" && npm run tauri dev
  ```
- **PowerShell**：
  ```powershell
  $env:LIBCLANG_PATH = "$(Get-Location)/src-tauri/.libclang"; npm run tauri dev
  ```
- **cmd.exe**（注意：`set` 不加引号；跨盘切目录要 `cd /d`）：
  ```cmd
  set LIBCLANG_PATH=D:\AItool\winapp\pastePanda\src-tauri\.libclang
  cd /d "D:\AItool\winapp\pastePanda"
  npm run tauri dev
  ```

### 关键说明（踩坑点）
1. **用 `npm run tauri dev`，不要裸 `npx tauri dev`**：`npm run tauri` 会先跑 `prebuild`（sync-version + gen-changelog）再把本地 `node_modules/.bin/tauri` 加入 PATH；裸 `npx tauri dev` 若不在项目目录内会去 registry 拉到一个同名废弃包 `tauri@0.15.0`（无 bin），报 `could not determine executable to run`。
2. **目录必须正确**：命令失败最常见原因是在 `C:\Users\xxx` 主目录执行，导致本地 `.bin/tauri` 找不到。先 `cd` 进项目根目录。
3. **一劳永逸**：cmd 里 `setx LIBCLANG_PATH "D:\AItool\winapp\pastePanda\src-tauri\.libclang"` 写进用户环境变量（注册表），重开终端后只需 `npm run tauri dev`，无需每次手动设。
4. **首次编译约 1 分钟**（727 个 crate），之后 Vite HMR 热更新，改前端代码无需重启 dev。
5. **无害日志**：启动时 `tauri_plugin_updater ... ERROR update endpoint did not respond` 是 dev 下连不上更新服务器，忽略即可，不影响功能。
6. 后台运行可用 `Start-Process powershell -ArgumentList "-NoExit","-Command","$env:LIBCLANG_PATH='$(Get-Location)/src-tauri/.libclang'; npm run tauri dev" -WindowStyle Minimized`，不阻塞主终端。

## 7. 方案设计需考虑代码架构
模块化、可维护性、扩展性，遵循项目已有的架构模式。

**组件文件大小限制**（硬性规则）：
- 单个 `.tsx` 组件文件 **禁止超过 300 行**（不含样式和类型定义）。
- 如果功能增长导致文件膨胀，**必须先拆分再继续**，不能无限制堆积。
- 拆分策略：自定义 Hook（`hooks/useXxx.ts`）/ 子组件（`components/XxxPanel.tsx`）/ 纯函数（`lib/xxx.ts`）。
- 新增功能时：如果目标文件已接近 300 行，默认创建新文件而非追加代码。

## 8. 做任何功能都要考虑性能
内存占用、加载速度、渲染效率、缓存策略。**不只在"设计方案"阶段，每次动手都要过下面的清单。**

### 8.1 常驻循环与动画
- 新增 `animation: … infinite`、`requestAnimationFrame` 递归、`setInterval` 之前先问：**不可见时会停吗？**
- 元素数量由数组长度决定的（粒子、装饰点），**数量就是常驻合成层数**——写死之前先算最坏情况。

### 8.2 多窗口乘法
- 本项目有 4 个窗口（主窗 / 托盘弹窗 / 快捷面板 / 全屏编辑器），同一组件可能被各挂一份。
- 辅助窗口关闭走的是 `window.hide()` 而非 `close()`，**WebView 与 DOM 仍存活，动画照跑**。
- 所以任何常驻开销默认要乘以窗口数；对策是监听失焦 / 可见性，不可见时暂停。

### 8.3 backdrop-filter（玻璃拟态）
- 只要值不是 `none`，就会创建合成层并采样背后内容——**`blur(0px)` 省不掉这部分**。
- **不要加在会重复出现的元素上**（如每张卡片、每个流程图节点），N 个元素就是 N 个层。
- 它背后的内容一变就得重新采样 + 重新模糊，所以“动画层 + 玻璃层”叠在一起的代价是**乘法而非加法**。

### 8.4 filter: blur()
- 与几何形变（`skewX` / `scale` / `rotate`）一起动画时，模糊无法缓存，**每帧重算**，半径越大越贵。
- 纯 `translate` 动画可缓存纹理，相对便宜。
- **不动的元素上的大半径 blur 是一次性成本，不必优化**（如 `.haze` 的 40px）。优化前先分清“它动不动”。

### 8.5 不要写没测过的性能结论
注释 / 文档里写“开销极小”“已优化”之前必须先实测，否则会让后来人（含未来的自己）跳过检查。

## 9. 方案设计需考虑用户体验
交互流畅度、反馈及时性、边界状态处理（加载中/空状态/错误）。

## 10. 改完代码不需要重启 dev
如果 dev 已在运行，Vite HMR 会自动热更新。直接看效果即可，不要每次改完代码都尝试重新启动 dev。

## 11. 公共工具函数统一放 lib/utils.ts
多个组件共用的纯函数（如 `cn`、`relativeTime`、`truncate`、`stripHtml`、`parseFilePaths`、`getImageOcrFullText`、`resolveImageCardDisplay` 等）**必须**在 `src/lib/utils.ts` 中定义并 `export`，各组件通过 `import { xxx } from "@/lib/utils"` 引用。禁止在组件文件内重复定义相同的工具函数。确保单一数据源，便于统一维护和修改。

### 11.1 新增「某类特殊处理」必须找全同类调用点并收口

本条管的不是纯函数，而是**分支逻辑**——它比重复的工具函数更难发现，失败方式是 401 / 静默错误。

做法：
- 加任何「某类 X 要特殊处理」的分支前，先 `grep` 出**所有做同一件事的取值点**，收口成一个函数，把全部调用点改为调用它，而不是逐处补 `if`。
- 收口后补一条**守卫单测**钉住不变量。需要运行环境的部分（AppHandle / IO）与纯判断分开，纯判断那半单独抽函数以便无环境测试。
- 验收标准：**如果第 7 个调用点被人新写出来时仍会走错，说明还没收口。**

## 12. 改动 UI 前必须读取真实组件源码
生成 HTML 设计稿前，必须先读取相关组件的 `.tsx` 和 `.module.css` 源码，设计稿中的样式、结构、图标、文案必须与真实代码一致，不能凭空自创样式。

## 13. 文件存放目录规范
| 文件类型 | 存放目录 |
|---------|---------|
| `.md` 文档 | `docs/`（项目根目录下） |
| `.html` 设计稿 | `design/`（项目根目录下）

---

## 14. git push 优先使用 SSH
本机 HTTPS 访问 GitHub 经常超时（系统代理 `127.0.0.1:26561` 不稳定，git 无法走通），但 SSH 方式 (`git@github.com`) 始终可用。

- remote URL 应使用 SSH 格式：`git@github.com:lzlkyb/pastepanda.git`
- 如果 `git push` 报 `Failed to connect` 或 `Connection was reset`，先检查 `git remote get-url origin`，若为 HTTPS 则切换为 SSH：
  ```bash
  git remote set-url origin git@github.com:lzlkyb/pastepanda.git
  ```
- pre-push hook 会跑完整测试（vitest + cargo test），耗时约 3 分钟，push 命令 timeout 需设 ≥300s

## 15. 反馈必须和触发在同一「可见性域」

- **15.1 触发常驻可见，结果就必须常驻可见。**
  把操作按钮提到卡头 / 摘要卡 / 工具栏时，**同一次改动**里要把它的成功与失败展示
  提到同一层级。按钮和它的反馈被拆进两个可见性域 = 用户眼里的「点了没反应」。
- **15.2 条件渲染 children 的容器会卸载子组件。**
  `{open && children}` 这种写法在收起时**卸载**子树。把折叠态从子组件上提到父级后，
  必须重审子组件里所有「假定自己一直活着」的东西：`useRef` 缓存、一次性加载标记、
  未保存的草稿。
  两个选择，任选但要写明：① 接受每次展开重新加载，把注释改成真话；
  ② 真要复用就把缓存提到不会被卸载的层级。
- **15.3 失败路径只 `setState` 不弹 toast 时**，必须确认承载它的元素在**任何折叠状态**下
  都可见；做不到就改用 toast。静默失败比报错难查一个量级。

---

## 16. AI 功能必须受 AI 开关控制（红线）

所有调用 AI/云端能力的代码路径都必须受「AI 可用性」门控。判定机制是单一数据源：

- **前端**：`src/lib/transforms/aiTransforms.ts` 的 `aiAvailable`（= `config.ai_enabled` && 有可用 key，默认 **false**），由 `refreshAiAvailability()` 计算；
- **后端**：`commands/ai/mod.rs`（AI 命令模块目录 `commands/ai/`，含 `plan.rs`/`run.rs`/`test_conn.rs`）统一校验 `cfg.enabled`（`config.ai_enabled`，默认关，测通自动开）；`ai/provider.rs` 与 `ai/client.rs` 校验 key（无 key 拒绝，先于网络请求）。

**硬性要求：**

1. **未启用（`ai_enabled=false`）或未配置 key → 零可见、零请求、零费用**：
   - 前端：AI 变换/动作/建议不得出现在任何界面；
   - 后端：命令入口拒绝并返回「AI 功能未启用」；
2. **新增任何 AI 功能**（变换 / 动作 / 主动建议里的 AI 项 / 试跑 / 预览 / 摘要等）必须做到：
   - 前端入口走 `aiAvailable` 门控；
   - 后端命令校验 `cfg.enabled`；
   - 计费路径（真正调用模型）双保险：`enabled` 且 key 都存在才放行；
3. **仅有的例外（用户显式触发的配置流程）**：
   - `ai_test_connection`（测试连接，真实计费但需用户主动点、无 key 先报错）；
   - `ai_preview_custom`（试跑自定义动作）；
   - 例外仍然要求：key 校验 + 出网闸 + 预算照走，不允许无 key 调用；
4. **本地能力不算 AI 功能**：OCR（Windows 本地引擎）、自动打标签（本地正则规则）不联网不花钱，不受本规则约束；
5. **违规判定**：后端任何命令若调用模型但未先校验 `cfg.enabled`（且不属于第 3 条例外），视为违规——新增代码时以此自查。

---

## 17. 交互通用核心思想（2026-08 实测沉淀，跨功能适用）

设计任何交互（截图 / 弹窗 / 面板 / 快捷键）时，先对照这套思想；具体实现细节留在代码注释里，不写进本文件。

1. **鼠标全流程可达，键盘只做加速器**：所有功能都能纯鼠标完成；快捷键（数字键 / Enter / Ctrl+Z 等）只是熟练后的加速，绝不能成为必需路径。
2. **高频路径一步到位**：默认动作 = 用户最常用的动作（如截图"完成"=直接复制，而不是先进中间面板再选出口）；低频出口收进「更多 / ⋯」次级入口，不挡主路。
3. **有反馈、不靠猜**：任何可交互元素 hover 即有即时提示（名称+快捷键），选中/激活状态一眼可见；禁止裸图标、无态无反馈的设计。
4. **移动即预览**：能 hover 实时生效（如选区跟随窗口）就绝不要求额外点击确认；需要区分"预览"与"确认"时，用位移阈值（如 4px）判定意图。
5. **误触低成本**：关键操作可撤销（undo）；破坏性操作有确认；选区/编辑态可随时重来。
6. **两级取消**：编辑态 Esc 先回上一步（回到选区/还原），再 Esc 才退出；不要一步退出把用户赶走。
7. **交互一致**：同类操作（选中、拖拽、缩放、取色）在不同界面用同一套手势与反馈；状态机清晰，每个状态下可做的事语义单一。

---

## 发版流程

### ⚠️ 硬性前置（违反会导致更新弹框 + 关于页日志空白）

**打 tag 之前必须先完成：**
1. 在 `CHANGELOG.md` 顶部写好新版本段落（只分 `新增`/`改进`/`修复` 三类，见下方 CHANGELOG 写作规范；**禁止** 技术/UI/UX 等开发视角分类）
2. 运行 `npm run prebuild`（内部执行 `sync-version.mjs && gen-changelog.mjs`），确认 `src/lib/changelog.generated.ts` 已包含新版本条目
3. 提交上述两个文件的变更

> 如果 CHANGELOG.md 没有对应版本段落，CI 提取日志会回退到 `"常规构建发布"`，UpdateNotesDialog 和 ChangelogView 都会显示空白。

### 正式步骤

当用户说 **"tag"** 或 **"打tag"** 时，自动执行完整发版流程（无需逐步确认）：

1. **递增版本号** — `tauri.conf.json` 中 patch 版本自动 +1（如 5.0.87 → 5.0.88）
2. **确认 CHANGELOG.md 已就绪** — 检查新版本段落存在且 `changelog.generated.ts` 已重新生成
3. **git add** — 暂存所有变更文件（排除 `src-tauri/config_backups/`）
4. **生成 commit message** — 根据代码变更自动生成带前缀的 commit（`feat:`/`chg:`/`fix:`），标题 + 空行 + 详细变更列表
5. **git commit** — 提交
6. **git push origin master** — 推送代码
7. **git tag v{version}** — 打轻量标签
8. **git push origin v{version}** — 推送标签触发 GitHub Actions 构建发布

### 发版后收尾

tag 推送后 CI 会自动构建并发布 Release，但如果需要补充更新日志：
- **编辑 Release notes**：`gh release edit v{version} --notes-file notes.md`
- **替换 updater.json**：手动生成后 `gh release upload v{version} dist/updater.json --clobber`
- **Gitee 镜像**：CI 会自动同步，若 404 检查 `GITEE_REPOSITORY` secret 是否为 `lzul/pastepanda`

> **Release 更新日志来源**：CI release.yml 会优先从 `CHANGELOG.md` 提取当前版本的段落作为 Release body。如果文件不存在或找不到对应版本，则自动回退到 git log 模式。这样即使几个版本才发一次 tag，Release 也能展示完整的累积变更记录。

### Commit 前缀规范（影响 Release 自动分类）
| 前缀 | Release 分类 | 示例 |
|------|-------------|------|
| `feat:` | ✨ 新功能 | `feat: 新增暗色模式` |
| `chg:` / `change:` | 🔄 变更 | `chg: 优化版本徽章配色` |
| `fix:` | 🐛 修复 | `fix: 修复托盘图标不显示` |
| `refactor:` | 🔧 重构 | `refactor: 重构存储模块` |
| `docs:` | 📖 文档 | `docs: 更新 README` |

### CHANGELOG 写作规范（硬性规则）

CHANGELOG.md 是**给用户看的**，不是给开发者看的。所有内容必须以用户视角撰写，只说"能做什么"，不说"怎么实现的"。

**允许的分类（仅这 3 个）：**
| 分类 | 用途 |
|------|------|
| `新增` | 用户可用的新功能 |
| `改进` | 现有功能的体验提升、性能优化、界面调整 |
| `修复` | 用户可感知的 bug 修复 |

**禁止出现的内容：**
- 文件名、函数名、变量名（如 `editorRegistry`、`parseFilePaths`、`canvas.toBlob`）
- 技术实现细节（如"模块拆分"、"树摇优化"、"状态机"、"事务原子性"）
- 代码架构变更（如"重构为 XX 模式"、"抽离 XX hook"）
- 测试数量、覆盖率、chunk 大小等开发指标
- `技术`、`UI/UX`、`安全`、`性能`、`崩溃与数据完整性` 等分类（合并到上述 3 个分类）

**写作示例：**

❌ 错误（开发者视角）：
```
### 技术
- useImagePreview 新增 exportFormat/exportQuality/exportEstimate(220ms 防抖 toBlob)/exporting
- canvas.toBlob 转码（jpeg 先铺白底避免透明黑边）
```

✅ 正确（用户视角）：
```
### 新增
- 图片格式转换与压缩：支持 PNG/JPG/WebP 切换，可调质量，实时估算文件大小
```

**条目合并原则：**
- 相关的小改动合并为一条（如 58 项 UX 修复合并为 5-6 条按主题分组的描述）
- 每条不超过 2 行，超过说明写得太细
- 安全/性能/架构改进如果没有用户可感知的变化，可以不写或合并到"改进"里一句话带过

