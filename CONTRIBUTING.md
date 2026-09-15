# 贡献指南（CONTRIBUTING）

感谢你参与 PastePanda 的开发！这是一份「协作者入职手册」——先读它，再动手。**人工开发与 AI Coding 都按本文件走。**

**最优先的规则源是项目根目录的 [`claude.md`](claude.md)**，本文件是它的「快速上手版」。两者冲突时以 `claude.md` 为准；遇到本文件没覆盖的场景，去 `claude.md` 查。

---

## 1. 项目速览

- **形态**：基于 Tauri 2 的 Windows 桌面剪贴板管理器（剪贴板历史 / 全局热键粘贴 / 截图标注 / OCR / 贴图 / 局域网同步 / 开发者工具箱）。
- **技术栈**：React 19 + TypeScript 5.8（前端，`src/`）· Rust（后端，`src-tauri/src/`）· SQLite。
- **窗口**：主窗 / 托盘弹窗 / 快捷面板 / 全屏编辑器共 4 个窗口，同一组件可能被各挂一份——性能改动要默认乘以窗口数。
- **关键目录**：
  - `src/components/` 前端组件（`.tsx`）
  - `src/lib/` 前端纯函数与类型（`utils.ts`、`screenshot/geometry.ts` 等）
  - `src/styles/` 全局样式
  - `src-tauri/src/` Rust 后端（`commands/`、`screenshot.rs` 等）
  - `design/` **HTML 设计稿**（UI 改动先看这里、先出稿；**先读 [`design/README.md`](design/README.md) 索引**——290+ 份稿子按主题分好组，并说明为什么它不标「已落地/已废弃」）
  - `docs/` 文档（UI 规则、色彩规范、结构设计规范等规范类文档在这里，不在 `design/`）
  - `scripts/` 构建辅助脚本

---

## 2. 从零到能跑 dev（人 / AI 同一套）

> **给协作者和 AI**：按下面顺序做完整条链路，不要跳。  
> 最省事：在仓库根目录跑一次 [`scripts/setup-dev.ps1`](scripts/setup-dev.ps1)，脚本会检查工具链、装依赖、找 libclang、预热 MNN；跑完再执行 §2.4 启动 dev。

### 2.1 宿主机必须先有的（clone 前/后都行，脚本装不了）

| 依赖 | 版本 | 安装 | 检查命令 |
|---|---|---|---|
| Node.js | ≥20 LTS | [nodejs.org](https://nodejs.org) | `node -v` |
| Rust | ≥1.70 **MSVC** | [rustup.rs](https://rustup.rs) 默认就是 MSVC | `rustc -V` / `cargo -V` |
| VS 2022 Build Tools | — | 勾选「使用 C++ 的桌面开发」+ Windows SDK | 能编任意 Rust cdylib |

### 2.2 拉代码 + 装依赖

```powershell
# 协作者必须用 SSH（HTTPS 本机常超时）
git clone git@github.com:lzlkyb/pastepanda.git
cd pastepanda
npm install
```

#### 别从 Gitee clone 源码

`gitee.com/lzul/pastepanda` 是**下载镜像，不含源码**：CI 只把发版产物（安装包 / 签名 / `updater-gitee.json`）推到它的 `releases` 分支和发行版资源（见 `.github/workflows/release.yml:302-422`）。它的用途是给国内用户加速下载安装包，不是给协作者拉代码。

| 仓库 | 地址 | 装的东西 | 用途 |
|---|---|---|---|
| GitHub（唯一源码源） | `github.com/lzlkyb/pastepanda` | 全部源码 + 完整历史 | 开发、提 PR |
| Gitee（下载镜像） | `gitee.com/lzul/pastepanda` | 只有发版产物 | 国内用户下安装包 |

注意两边 **owner 名字不同**（GitHub `lzlkyb` / Gitee `lzul`）是刻意的，不是笔误。

国内网络拉 GitHub 不稳时，先按 §7 的求助顺序走，别去 Gitee 找源码。

### 2.3 两样 **不在 git 里**、clone 后必须自备的构建资产

这两样被 `.gitignore` 忽略（体积超 GitHub 限制）。缺任一样，**前端能跑、Rust 编不过**。

| 资产 | 路径 | 体积 | 缺了会怎样 | 怎么补 |
|---|---|---|---|---|
| **libclang.dll** | `src-tauri/.libclang/libclang.dll` | ~数十 MB | 编到很后面的 `ocr-rs` 才报 `Unable to find libclang` | 装 LLVM，或 `pip install libclang`，或把 dll 拷进该目录；`setup-dev.ps1` 会自动找 |
| **MNN 预编译** | `src-tauri/vendor/ocr-rs/3rd_party/prebuilt/mnn-dev-windows-x86_64/`（含 `lib/MNN.lib` + `include/`） | ~170MB | 无缓存时首次 cargo **会联网自动下**；断网/下载失败则编不过 | 跑 `setup-dev.ps1`；或手动下 [mnn-dev-windows-x86_64.zip](https://github.com/zibo-chen/MNN-Prebuilds/releases/download/dev/mnn-dev-windows-x86_64.zip) 解压到该目录 |

**OCR 模型**（`src-tauri/resources/ocr_models/`，~15MB）**已在 git 里**，clone 即有，不用另下。

#### 一键准备脚本（推荐，AI 直接跑这个）

```powershell
# 在仓库根目录
powershell -ExecutionPolicy Bypass -File scripts\setup-dev.ps1
```

脚本做的事（幂等，可重复跑）：
1. 检查 Node ≥20、Rust/cargo  
2. `npm install`（已有 `node_modules` 则跳过）  
3. 找 `libclang.dll`（LLVM 常见路径 / pip 包）→ 拷到 `src-tauri/.libclang/`  
4. 预下载并解压 MNN 预编译到 `vendor/ocr-rs/3rd_party/prebuilt/`（失败不致命，首次 cargo 会再下）  
5. 校验 OCR 模型三件套  
6. 打印下一步 `LIBCLANG_PATH` 与 `npm run tauri dev`

可选参数：`-LibclangPath "C:\path\to\dir"`、`-SkipNpm`、`-SkipMnn`。

#### 手动补 libclang（脚本找不到时）

```powershell
# 方式 A：装 LLVM 后指向其 bin
# https://github.com/llvm/llvm/releases  （Windows installer，可加 PATH）
$env:LIBCLANG_PATH = "C:\Program Files\LLVM\bin"

# 方式 B：pip 装 libclang，再把 dll 拷进项目约定目录
pip install libclang
# 然后重跑 scripts\setup-dev.ps1，或手动把找到的 libclang.dll 复制到：
#   src-tauri\.libclang\libclang.dll
```

### 2.4 设 `LIBCLANG_PATH` 并启动 dev

项目**不**持久化 `.cargo/config`，所以每个新终端都要设环境变量（或 `setx` 一劳永逸）：

```powershell
# PowerShell（当前会话）
$env:LIBCLANG_PATH = "$(Get-Location)\src-tauri\.libclang"
# 确认变量真的拿到了
Test-Path "$env:LIBCLANG_PATH\libclang.dll"   # 必须 True

# 一劳永逸（新开终端生效）
setx LIBCLANG_PATH "$(Get-Location)\src-tauri\.libclang"
```

```bash
# Git Bash：必须用 pwd -W，不要裸 pwd
export LIBCLANG_PATH="$(pwd -W)/src-tauri/.libclang"
echo "$LIBCLANG_PATH"   # 应是 D:/... 而不是 /d/...
```

```cmd
:: cmd（set 不加引号）；路径换成你自己的 clone 路径
set LIBCLANG_PATH=D:\你的路径\pastepanda\src-tauri\.libclang
```

然后启动：

```powershell
npm run tauri dev
```

**成功标准**：编译通过，PastePanda 主窗口出现。  
**必须 `npm run tauri dev`**，不要裸 `npx tauri dev`（会先跑 `prebuild`，并正确解析本地 tauri CLI）。

- 首次编译约 1 分钟（或更久，视是否首次下 MNN）；之后 Vite HMR，**改前端不用重启 dev**。
- 日志里 `tauri_plugin_updater ... ERROR update endpoint did not respond` 是 dev 连不上更新服务器，**无害**，忽略。
- 重启前释放 1420 端口：`netstat -ano | findstr :1420`，把 LISTENING 的 PID（vite/node）一并 `taskkill /F`，只杀 `PastePanda.exe` 不够。

### 2.5 开工前自检清单（AI 跑完再开始改代码）

```powershell
# 全部应通过
Test-Path "node_modules"                          # True
Test-Path "src-tauri\.libclang\libclang.dll"      # True
Test-Path "src-tauri\resources\ocr_models\PP-OCRv6_small_det.mnn"  # True
$env:LIBCLANG_PATH                                # 非空，且是 Windows 盘符路径
npx tsc --noEmit
npm run lint
npx vitest run
# 有 Rust 改动时再跑：
cargo check --manifest-path src-tauri/Cargo.toml
```

### 2.6 `LIBCLANG_PATH` 踩坑（编到 841/904 才挂时看这里）

> 🔴 **Git Bash 里千万别写 `$(pwd)`**（2026-09-08 实测）。它展开成 `/d/...`，
> bindgen 是原生 Windows 程序不认 MSYS 路径。Git Bash 只转换**命令行参数**、不动环境变量值。
>
> ```
> Unable to find libclang: couldn't find any valid shared libraries matching:
> ['clang.dll', 'libclang.dll'], ... (invalid: [])
> ```
>
> 末尾 `invalid: []` 的意思是「变量拿到了、但当成空目录」，不是「你没设」。
> `ocr-rs` 在依赖图很靠后，可能编到 **841/904** 才崩，值得启动前先 `echo $LIBCLANG_PATH`。

### 2.7 日常验证命令

```bash
npx tsc --noEmit          # TypeScript 类型检查
npm run lint              # eslint（--max-warnings=0，一条警告都不过）
npx vitest run            # 前端单测（本机若遇 thread pool 崩溃，加 --pool=forks）
cargo check --manifest-path src-tauri/Cargo.toml   # 记得先设 LIBCLANG_PATH
cargo test --manifest-path src-tauri/Cargo.toml    # 后端测试（含吸附/几何单测）
```

> pre-push hook 会自动跑完整测试（vitest + cargo test），约 3 分钟；push 时命令 timeout 请设 ≥300s。

---

## 3. 开发工作流

### 3.1 分支命名

从 `master` 拉分支，命名带类型前缀（CI 只对以下前缀跑测试）：

```
feature/xxx   新功能
fix/xxx       bug 修复
refactor/xxx  重构
docs/xxx      文档
```

```bash
git checkout -b feature/my-feature
```

### 3.2 开发顺序（项目硬性流程）

1. **先出方案再动手**：改动前至少给 2-3 个方案（含优缺点）让维护者选，不要直接写代码。
2. **UI 改动先出 HTML 设计稿**：涉及 UI 时，先**读取真实组件源码**（`.tsx` + `.css`），再在 `design/` 下生成 HTML 预览稿，样式/结构/图标/文案与真实代码一致，等确认后再落地。
3. 开发 → 本地验证（见 §2.7）→ 提交 → push → 开 PR。

### 3.3 提交规范

Commit 前缀影响 Release 自动分类，**必须遵守**：

| 前缀 | Release 分类 | 示例 |
|------|-------------|------|
| `feat:` | ✨ 新功能 | `feat: 新增暗色模式` |
| `chg:` / `change:` | 🔄 变更 | `chg: 优化版本徽章配色` |
| `fix:` | 🐛 修复 | `fix: 修复托盘图标不显示` |
| `refactor:` | 🔧 重构 | `refactor: 重构存储模块` |
| `docs:` | 📖 文档 | `docs: 更新 README` |

提交信息：标题 + 空行 + 详细变更列表（中文）。

### 3.4 Pull Request

- PR 标题用中文简述改动；描述里粘贴 **PR 模板的勾选清单**（见 `.github/pull_request_template.md`），逐项自检。
- CI 会跑 Rust 测试（windows-latest）+ 前端测试（ubuntu），**必须全绿**才可合并。
- 合并前由维护者 review；合入 `master` 后 CI 自动出测试，**只有打 tag 才触发发版**（见第 6 节）。

### 3.5 日常同步与冲突处理

**同步他人提交（本地无未提交改动时）：**
```bash
git pull            # fetch + merge，最常用
```

**本地有正在改的代码时**（先暂存，避免 pull 失败）：
```bash
git stash           # 暂存未提交改动
git pull            # 同步
git stash pop       # 恢复改动（若此步报冲突，按下文处理）
```

**冲突只发生在两个人改了同一文件的同一段**——改不同文件或同文件不同区域，git 会自动合并。当 `git pull` 提示 `CONFLICT`：

1. `git status` 查看冲突文件（both modified）；
2. 打开文件，处理 `<<<<<<< HEAD` / `=======` / `>>>>>>>` 之间的内容：按语义取舍（留哪边或合并），**必须删掉这三行标记**；
3. 全部解决后：
```bash
git add <冲突的文件>
git commit          # 完成合并提交
```
4. 想放弃本次合并：`git merge --abort` 回到 pull 前状态。

**本项目注意点：**
- pre-push hook 自动跑完整测试（vitest + cargo test，约 3 分钟）——**冲突合并后先本地 `npm run lint` + `npx vitest run` 再 push**，避免把合并问题留给 CI。
- 高冲突风险文件：`src/components/screenshot/ScreenshotOverlay.tsx`（3000+ 行）、`appStore.ts`、`hotkey_manager.rs`——动这些文件前先 `git pull`，尽量只改自己负责的区段。
- 本地 dev 跑着时 pull 一般无影响（Vite HMR 热更新）；若 pull 改了 Rust 后端需重启 dev。

**防冲突日常姿势：** 开工前先 `git pull`；小步提交、频繁 push；分支做自己的事，合入前再 pull 一次 master。

---

## 4. 用 AI Coding 协作

**先完成 §2「从零到能跑 dev」**（人跑一遍或让 AI 按 §2.2–§2.5 执行），§2.5 自检全绿后再开发。  
欢迎用 Claude Code / Cursor 等 AI 工具干活，但 **`claude.md` 对人和 AI 同样有效**，不能当甩手掌柜。

### 4.1 选什么工具

| 工具 | 推荐度 | 说明 |
|------|--------|------|
| **Claude Code** | ★★★★★ | 项目以 `claude.md` 为规则源，开箱即用 |
| Cursor / Windsurf | ★★★★ | 在项目根放好规则文件（见下）即可 |
| 其他 CLI（Codex、Qwen Code 等） | ★★★ | 规则加载方式各异，需手动贴规则 |

**唯一硬要求**：不管用什么工具，**必须让它读到 `claude.md`**。读不到就会踩版本号、组件行数、AI 红线这些坑。

### 4.2 让 AI 读到规则

**Claude Code**：把仓库根目录当工作区打开即可。启动后第一句先核对：

```
先读 claude.md 和 CONTRIBUTING.md，用 5 条要点复述本项目的硬性规则。
```

复述不对就纠正，再开工。

**Cursor / Windsurf**：任选其一——把 `claude.md` 内容贴进项目 Rules / `.cursorrules`；或在 `.cursor/rules/`、`.windsurfrules` 里写：**「开始任何任务前先完整阅读仓库根目录 `claude.md`，并严格遵守」**。

**任何工具通用的开工提示词：**

```
你在 PastePanda 仓库工作。规则源是根目录 claude.md（已存在，先读）。
硬性约束（违反即失败）：
- 不改任何版本号（tauri.conf.json / Cargo.toml / package.json）
- 不执行 npm run tauri build
- 不主动 commit / push / tag
- UI 改动必须先出 design/*.html 设计稿，等我确认再写组件
- 新功能先给 2-3 个方案对比，不要直接写代码
- 单个 .tsx ≤300 行
- 所有 AI/云端能力必须过 ai_enabled / aiAvailable 门控

今天任务：<一句话说清楚要做什么>
```

### 4.3 和 AI 的标准流程

```
① 出方案（2-3 个，含优缺点） → 你拍板
② UI：先读真实 .tsx + 样式 → design/*.html 设计稿 → 你确认
③ 写代码 + 补单测
④ 本地验证（§2.7 日常验证命令）
⑤ 你人工 diff 审查 → 再 commit → 开 PR
```

**不要跳步。** 尤其不要让 AI「先写完再说」——本项目对 UI、方案、性能都有硬门禁。

推荐把任务拆给 AI 的方式：

| 任务类型 | 怎么下指令 |
|----------|------------|
| 调研/定位 | 「先只读代码，列出改 X 会碰到哪些文件和调用点，先别改」 |
| 方案对比 | 「给 2-3 个实现方案，各自优缺点、影响面、预计改动文件；先不写代码」 |
| UI | 「先读 Xxx.tsx 与对应样式，在 design/ 出 HTML 设计稿，不改组件」 |
| 实现 | 「按方案 B 实现；改完跑 tsc / lint / vitest；不 commit」 |
| 审查 | 「对照本文件 §5 与 PR 模板检查当前 diff，只报问题不改代码」 |

### 4.4 提 PR 前用 AI 自查

让 AI 对着模板跑一遍（**只报告，不自动改**）：

```
读 .github/pull_request_template.md 和当前 git diff。
逐项对照自查清单，输出：
- 通过 / 不通过 / 不适用
- 不通过项：具体文件:行号 + 怎么改
不要修改任何文件。
```

你自己再人工看一遍 diff。**AI 自查不能代替人工审查。**

### 4.5 AI 协作习惯

- **小步、单主题 PR**：一个 PR 只做一件事，方便 AI 聚焦、也方便 review。
- **先开 Issue 再让 AI 实现**：复杂功能先在 Issue 里对齐方案，再丢给 AI 做。
- **AI 改动在 PR 描述里标注**：如「实现由 Claude Code 生成，本人已 review」——方便维护者提高审查颗粒度。
- **不懂就问维护者，不要让 AI 猜业务语义**：剪贴板/同步/AI 开关这些领域逻辑，猜错代价高。

### 4.6 给 AI 的角色卡（可直接粘贴）

```
你是 PastePanda 的结对工程师。项目：Tauri 2 + React 19 + TypeScript + Rust + SQLite，
Windows 桌面剪贴板管理器 + 本地知识库。仓库根目录 claude.md 是规则权威，优先级高于你的默认习惯。

工作方式：
- 若环境未就绪，先按 CONTRIBUTING.md §2 执行 scripts/setup-dev.ps1，自检全绿再改代码
- 改代码前先读相关真实源码，不凭想象写
- 复杂改动先出方案对比，等我选
- UI 先出 design/ 下的 HTML 稿，等我确认
- 每次改完跑 tsc / lint / vitest；涉及 Rust 再跑 cargo check/test
- 默认不 commit、不 push、不改版本号、不 build
- 解释用中文，代码标识符保持英文
- 不确定就问，不要静默选择一种理解然后开干
```

---

## 5. 项目硬性规则（摘要，完整版见 claude.md）

违反任意一条，PR 直接打回：

1. **版本号不自动递增**：版本号唯一来源 `src-tauri/tauri.conf.json`（同步 `Cargo.toml`）。**任何提交都不得改版本号**，由维护者发版时统一递增。`package.json` 的版本号始终是占位 `0.1.0`，不要碰。
2. **不主动构建 exe**：`npm run tauri build` 只在维护者确认后进行。
3. **组件文件 ≤300 行**：单个 `.tsx` 超过 300 行必须先拆分（hook / 子组件 / 纯函数）再继续；目标文件接近 300 行时，默认新建文件。
4. **公共纯函数收口**：多组件共用的函数放 `src/lib/utils.ts`；「某类 X 特殊处理」的分支逻辑必须 grep 全同类调用点收口成函数并补守卫单测——**如果第 7 个调用点新写出来仍会走错，说明没收口**。
5. **性能硬指标**：常驻循环/动画不可见必须停；多窗口（4 个）常驻开销 ×窗口数；`backdrop-filter` 不重复元素；**没实测不许写"开销极小"**。
6. **反馈与触发同可见性域**：按钮和它的成败展示在同一层级；`{open && children}` 会卸载子树，上提折叠态要重审 ref 缓存；失败路径只 setState 不 toast 时必须确认任何折叠态都可见。
7. **AI 产品红线**（产品功能，不是「用 AI 写代码」）：所有 AI/云端能力受 `ai_enabled` 门控（前端 `aiAvailable` + 后端 `cfg.enabled` 双重校验，默认关）；未启用 = 零可见、零请求、零费用。本地 OCR / 自动打标签不算 AI。
8. **交互通用原则**：鼠标全流程可达、键盘只做加速；高频路径一步到位、低频出口收「⋯」；有反馈不靠猜；移动即预览（4px 阈值）；误触低成本（可撤销+确认）；两级取消（Esc 先回上一步）；同类操作同手势同反馈。
9. **直接推 `master` 禁止**：一律 feature/fix 分支 + PR。
10. **git push 用 SSH**：本机 HTTPS 访问 GitHub 常超时，remote 应保持 `git@github.com:lzlkyb/pastepanda.git`。
11. **AI 默认不提交**：未经你人工审查，不让 AI 自动 commit / push / tag。

---

## 6. 发版（仅维护者）

用户说「tag / 打tag」时由维护者执行完整发版流程，协作者**不需要也不应该**打 tag：

1. 递增 `tauri.conf.json` 版本号（patch +1），同步 `Cargo.toml`；
2. `CHANGELOG.md` 顶部写新版本段落（**只分「新增/改进/修复」三类，用户视角**，禁文件名/实现细节/开发指标）；
3. `npm run prebuild` 确认 `src/lib/changelog.generated.ts` 已含新版本；
4. commit → push → `git tag vX.Y.Z` → `git push origin vX.Y.Z` 触发 CI 构建发布。

> CHANGELOG 是给用户看的：只说「能做什么」，不说「怎么实现的」。示例与禁忌见 claude.md「发版流程」一节。

---

## 7. 求助顺序

1. 读 `claude.md`（规则全集，含踩坑记录）；
2. 读 `docs/` 下的专题文档（OCR 替换、AI 架构、功能清单等）；
3. 在 Issue 里提问，或 PR 里 @ 维护者。
