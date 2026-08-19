# 贡献指南（CONTRIBUTING）

感谢你参与 PastePanda 的开发！这是一份「协作者入职手册」——先读它，再动手。

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
  - `design/` **HTML 设计稿**（UI 改动先看这里、先出稿）
  - `docs/` 文档
  - `scripts/` 构建辅助脚本

---

## 2. 环境准备（Windows）

| 依赖 | 版本 | 说明 |
|---|---|---|
| Rust | ≥1.70 | rustup.msi 安装，含 MSVC toolchain |
| Node.js | ≥20 | 建议 LTS |
| Visual Studio 2022 Build Tools | — | 勾选「使用 C++ 的桌面开发」+ Windows SDK |

### ⚠️ 最关键的坑：`LIBCLANG_PATH`

OCR 引擎 `ocr-rs` 的 bindgen 阶段需要 `libclang.dll`，**项目自带**于 `src-tauri/.libclang/`。不设必挂：

```
Unable to find libclang ... set the LIBCLANG_PATH environment variable
```

项目约定**不**持久化 `.cargo/config`，所以每个新终端都要设一次（或 `setx` 写进用户环境变量，一劳永逸）：

```bash
# Git Bash / WSL
export LIBCLANG_PATH="$(pwd)/src-tauri/.libclang"

# PowerShell
$env:LIBCLANG_PATH = "$(Get-Location)/src-tauri/.libclang"

# cmd（set 不加引号）
set LIBCLANG_PATH=D:\AItool\winapp\pastePanda\src-tauri\.libclang
```

> 注意：OCR 依赖已 **vendoring 进仓库**（`src-tauri/vendor/ocr-rs`），构建离线；但 `src-tauri/vendor/ocr-rs/3rd_party/prebuilt/`（约 170MB MNN 预编译）被 `.gitignore` 忽略，clone 后首次构建需自行准备或走 CI 缓存。

---

## 3. 快速开始

```bash
git clone git@github.com:lzlkyb/pastepanda.git
cd pastepanda
npm install
export LIBCLANG_PATH="$(pwd)/src-tauri/.libclang"   # 每次新终端都要
npm run tauri dev                                   # 用 npm run，不要裸 npx tauri dev
```

- **必须 `npm run tauri dev`**：`npm run tauri` 会先跑 `prebuild`（sync-version + gen-changelog）并把本地 `node_modules/.bin/tauri` 加入 PATH；裸 `npx tauri dev` 可能拉到废弃同名包报错。
- 首次编译约 1 分钟，之后 Vite HMR 热更新，**改前端代码无需重启 dev**（见 claude.md 第 10 条）。
- 重启 dev 前彻底释放 1420 端口：Vite 子进程仍占着端口会导致下次启动报 `Port 1420 is already in use`、窗口空白。用 `netstat -ano | grep ":1420"` 找到 PID 一并 `taskkill /F`。
- 启动日志里 `tauri_plugin_updater ... ERROR update endpoint did not respond` 是无害日志，忽略。

### 日常验证命令

```bash
npx tsc --noEmit          # TypeScript 类型检查
npm run lint              # eslint（--max-warnings=0，一条警告都不过）
npx vitest run            # 前端单测（本机若遇 thread pool 崩溃，加 --pool=forks）
cargo check --manifest-path src-tauri/Cargo.toml   # 记得先设 LIBCLANG_PATH
cargo test --manifest-path src-tauri/Cargo.toml    # 后端测试（含吸附/几何单测）
```

> pre-push hook 会自动跑完整测试（vitest + cargo test），约 3 分钟；push 时命令 timeout 请设 ≥300s。

---

## 4. 开发工作流

### 4.1 分支命名

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

### 4.2 开发顺序（项目硬性流程）

1. **先出方案再动手**：改动前至少给 2-3 个方案（含优缺点）让维护者选，不要直接写代码。
2. **UI 改动先出 HTML 设计稿**：涉及 UI 时，先**读取真实组件源码**（`.tsx` + `.css`），再在 `design/` 下生成 HTML 预览稿，样式/结构/图标/文案与真实代码一致，等确认后再落地。
3. 开发 → 本地验证（见上节命令）→ 提交 → push → 开 PR。

### 4.3 提交规范

Commit 前缀影响 Release 自动分类，**必须遵守**：

| 前缀 | Release 分类 | 示例 |
|------|-------------|------|
| `feat:` | ✨ 新功能 | `feat: 新增暗色模式` |
| `chg:` / `change:` | 🔄 变更 | `chg: 优化版本徽章配色` |
| `fix:` | 🐛 修复 | `fix: 修复托盘图标不显示` |
| `refactor:` | 🔧 重构 | `refactor: 重构存储模块` |
| `docs:` | 📖 文档 | `docs: 更新 README` |

提交信息：标题 + 空行 + 详细变更列表（中文）。

### 4.4 Pull Request

- PR 标题用中文简述改动；描述里粘贴 **PR 模板的勾选清单**（见 `.github/pull_request_template.md`），逐项自检。
- CI 会跑 Rust 测试（windows-latest）+ 前端测试（ubuntu），**必须全绿**才可合并。
- 合并前由维护者 review；合入 `master` 后 CI 自动出测试，**只有打 tag 才触发发版**（见第 6 节）。

### 4.5 日常同步与冲突处理

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

## 5. 项目硬性规则（摘要，完整版见 claude.md）

1. **版本号不自动递增**：版本号唯一来源 `src-tauri/tauri.conf.json`（同步 `Cargo.toml`）。**任何提交都不得改版本号**，由维护者发版时统一递增。`package.json` 的版本号始终是占位 `0.1.0`，不要碰。
2. **不主动构建 exe**：`npm run tauri build` 只在维护者确认后进行。
3. **组件文件 ≤300 行**：单个 `.tsx` 超过 300 行必须先拆分（hook / 子组件 / 纯函数）再继续；目标文件接近 300 行时，默认新建文件。
4. **公共纯函数收口**：多组件共用的函数放 `src/lib/utils.ts`；「某类 X 特殊处理」的分支逻辑必须 grep 全同类调用点收口成函数并补守卫单测——**如果第 7 个调用点新写出来仍会走错，说明没收口**。
5. **性能硬指标**：常驻循环/动画不可见必须停；多窗口（4 个）常驻开销 ×窗口数；`backdrop-filter` 不重复元素；**没实测不许写"开销极小"**。
6. **反馈与触发同可见性域**：按钮和它的成败展示在同一层级；`{open && children}` 会卸载子树，上提折叠态要重审 ref 缓存；失败路径只 setState 不 toast 时必须确认任何折叠态都可见。
7. **AI 红线**：所有 AI/云端能力受 `ai_enabled` 门控（前端 `aiAvailable` + 后端 `cfg.enabled` 双重校验，默认关）；未启用 = 零可见、零请求、零费用。本地 OCR / 自动打标签不算 AI。
8. **交互通用原则**：鼠标全流程可达、键盘只做加速；高频路径一步到位、低频出口收「⋯」；有反馈不靠猜；移动即预览（4px 阈值）；误触低成本（可撤销+确认）；两级取消（Esc 先回上一步）；同类操作同手势同反馈。
9. **反馈与触发同可见性域**（见上）。
10. **git push 用 SSH**：本机 HTTPS 访问 GitHub 常超时，remote 应保持 `git@github.com:lzlkyb/pastepanda.git`。

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
