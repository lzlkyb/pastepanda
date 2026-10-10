# 贡献指南（CONTRIBUTING）

感谢你参与 PastePanda 的开发！这是一份「协作者入职手册」——先读它，再动手。**人工开发与 AI Coding 都按本文件走。**

**最优先的规则源是项目根目录的 [`AGENTS.md`](AGENTS.md)**，本文件是它的「快速上手版」。两者冲突时以 `AGENTS.md` 为准；遇到本文件没覆盖的场景，去 `AGENTS.md` 查。

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

> pre-push hook 会跑守卫，**是否跑全量测试取决于被推的目标**（分档见下表）。**整轮耗时自 2026-10-09 起由钩子自己打印**（每段一行 `耗时 X：N s（累计 M s）`），
> 文档不再抄常数——过去两次抄成假数：写「约 3 分钟」时实测 25 分钟，写「22.2 分钟」时第一段已经被删掉了。
>
> **2026-10-09 起钩子按「这次 push 改不改别人拉到的东西」分两档**。判据收口在 `scripts/prePushTier.mjs`（纯函数，用例 `src/__tests__/prePushTier.test.ts`），
> 钩子里的顺序由 `src/__tests__/prePushHookParity.test.ts` 钉住：
>
> | 档 | 触发条件 | 跑什么 | 钩子自报耗时（本机实测） |
> |---|---|---|---|
> | `light` | 被推的**远端** ref 只是特性分支（`fix/** feature/** chore/** agent/** docs/**`） | 覆盖守卫 + 密钥守卫 + `npx tsc --noEmit` | **48s**（判档 1s / 守卫 12s / tsc 35s；tsc 冷启动另一次量到 **73s**） |
> | `full` | 远端 ref 是 `refs/heads/master`，或掺了任何 `refs/tags/*`；以及**读不到 stdin / node 不可用 / ref 行读不懂** | 上面三项 + 全量 Vitest + `cargo test` | **566s**（分档之前每一笔 push 都是这个档） |
>
> 分档的理由不是「本地慢所以省掉」，而是**裁判换了地方**：master 现在有 `enforce_admins=true` + required status checks
> （`Rust Tests` / `Frontend Tests`，§3.8），PR 合入前 GitHub 已经跑过同一套全量；特性分支再本地跑第二遍是同一套测试付两遍，
> 而钩子判的是**整棵工作树**——别人的在途文件在给本次 push 判分（§3.7）。兜底方向一律是 `full`：判档器看不懂就得多跑。
>
> 判档器同时是**覆盖守卫**（`decideOwnership`，同一支脚本、同一次 stdin）：这次 push 若会把「不是本机身份写的提交」从远端某个分支上抹掉，
> 脚本退出码 **9**、钩子在跑任何测试之前就拒绝（明细走 stderr，stdout 只留档位给 `$(...)` 收）。
> 为什么装在钩子而不是 GitHub：**分支保护只装在 master 上，而 ruleset 的 bypass 名单只认角色/团队/GitHub App，做不到「拦管理员但放行写权限的协作者」**
> （2026-10-09 逐条查证过，因此没有给 `feature/kynnzhou-dev` 加保护——加了会连协助者自己要求的 `strict=true` rebase 都推不动）。
> 判据只用本地对象库、不联网：新分支和 fast-forward 不拦；旧 tip 本地没有 → **不拦**（不把「没 fetch 过」当罪证，git 的 `--force-with-lease` 是第二道闸）；
> 删分支只看 **tip 作者**（分支历史必然从 master 继承别人的提交，按全集判等于永远删不掉自己的分支）。
> 「本机身份」是一个**集合**：`git config user.email` + `dev@clipboard-manager.local`（AGENTS 21，改地址前的 616 笔），
> 少列后者会让「rebase 自己 10-09 以前的分支」全部误判，而误判的出路是 `--no-verify`——那等于把守卫整个废掉。
> 判红的用例在 `src/__tests__/prePushOwnership.test.ts`（注入假 repo，11 条）+ `prePushHookParity.test.ts` 钉接线顺序。
>
> 🔴 `tsc` 故意留在轻档里，别顺手归进 full：`npx vitest` 只**剥**类型不校验类型，而 CI 的 frontend-test 只有 `npx vitest run` 一步，
> 全仓唯一会跑 `tsc` 的地方就是这个钩子（`npm run build` 只在发版构建里跑）。归进 full 等于「特性分支的类型错误没人查，直到发版才第一次爆」。
> 这条断言两个方向都喂过反例（2026-10-09，都是我在当次改动的工作树上临时造的，仓里没有任何一笔提交处于过那个状态）：
> ① 删掉 `npx tsc --noEmit` 这一行 → `at()` 报「缺这句」（这条调用本身是 `5d2b891` 随分档一起引入的，一直在闸外）。
> ② 把它从恒跑区搬进 full 闸内部 → 判红 `expected 2972 to be less than 2940`。
> 覆盖守卫同理：删掉拒绝块里的 `exit 9` → 只有新用例红，其余 5 条绿。

>
> 三段的可复现口径（2026-10-09 三次 push 的钩子自报数；**这台机器上 Vitest 那一段能差 5 倍**，所以只能按档读，不能当一个数）：
> 密钥守卫 **7–9s**；前端 Vitest **100.68s / 269.43s / 517.46s**（同一套 392 文件 / 4186 用例，三档都全绿——差别全在机器上有没有别的会话在跑）；
> Rust cargo test 主套 `2240 passed`，用例 70.18s、含增量编译的整段 112–154s。
> ⇒ 钩子自报的整轮累计：**443s（`30eac55b`，那轮是我自己并行跑了另一个 vitest）→ 643s ≈ 10.7 分钟（`c0dc5fc6`，机器上另有会话在跑）**，
> 两档之间没有任何一次是配置变了——所以「这一轮比上一轮慢」通常不是回归的证据。
> **一次 push 请留 ≥1800s 的 timeout**：太短会在钩子跑完前被掐死、看起来像「测试挂了」；冷机器上第一段本来就是 cargo 全量编译。
> 更早的 `b8a6a2e7` 那轮还没有计时，只能按三段相加**推算**约 3 分钟，别读成实测。
>
> 🔴 历史：旧的第一段（密钥守卫）4 趟全树 `grep -rn` ≈ 499s，占过整轮的四分之三。2026-10-09 合并成 2 趟（`LC_ALL=C`）后本机 263s，
> 再剔掉 `target-android`(7.6G/16314 文件)、`gen`(2.8G)、`.cache` 三个**零个被追踪文件**的构建缓存目录后
> **8–11s**（同一台机器、同一份判据连测两次 7.8s / 10.7s）。🔴 这个数字只随负载变：同一份脚本在有并发会话的机器上量到 **41s**，所以它是一段**区间**而不是一个常数——要复现请用「同一次条件下两档对照」，别拿单点外推。
> 排除名单不是口头承诺：脚本开头会用 `git ls-files` 断言「每个排除目录下 0 个被追踪文件」，违反就判红；
> `src/__tests__/secretGuardCanary.test.ts` 里备了 force-add 与「不在 git 仓库里跑」两个反例把它验过。
> 同一次改动顺手补回一个真窟窿：旧名单里的 `design/` 下面有 312 个被追踪稿子，等于对整仓那两趟失明，已移出排除名单。
>
> 省一轮钩子的办法 historically 是：**分支和 tag 一次推**（`git push origin master v7.2.11`）——一次 push 只跑一遍 pre-push，
> 而 `git push origin v7.2.11` 单独推标签**同样会跑完整钩子**，白等一整轮。
> 🔴 2026-10-09 起这条**对发版不再适用**：master 开了 `enforce_admins`（见 §3.8），版本号提交必须走
> `chore/release-v{version}` → PR → 合并，而 `release.yml` 是**由 tag 触发**的——提前把 tag 随分支推上去，
> 会出现「Release 已在构建、PR 还没合并」的错位。宁可多付一整轮钩子：先合 PR，再从 master 切 tag 单独推。

---

## 3. 开发工作流

### 3.1 分支命名

从 `master` 拉分支，命名带类型前缀。**哪些前缀有 CI 由 `.github/workflows/test.yml` 的 `push.branches` 单独决定**——不在名单里的分支推上去一次都不跑，所以改这里必须同步改那边：

```
feature/xxx          新功能            ✅ 在 CI 名单
fix/xxx              bug 修复          ✅ 在 CI 名单
refactor/xxx         重构              ✅ 在 CI 名单
chore/xxx            构建/依赖/脚本     ✅ 在 CI 名单
agent/<会话标识>/xxx  AI 会话开的分支    ✅ 在 CI 名单
docs/xxx             纯文档            ❌ 不跑 CI（本地 lint 即可，故意不加）
```

```bash
git checkout -b feature/my-feature
```

**`agent/` 前缀是干什么的**：同一台机器上常并行多个开发会话（见 §3.7），过去只能靠 `git status` 猜归属。把会话标识写进分支名，归属就进了 git 本身，而且每条分支都自动享受一次 CI 验证——这比给每个会话开一棵 `git worktree` 便宜得多（不多花磁盘、不重编 cargo target）。参照做法：cc-switch 的 100+ 分支里就有 `agent/*`、`claude/*`、`codex/*` 三套 AI 命名空间。

**外部贡献的规矩**（本仓第一笔外部贡献 `feature/kynnzhou-dev` 之后定）：

- 用 `fix/issue-<编号>` 或 `feature/<功能>`，**先开 Issue 讨论**再写代码；一个 Issue 对应一个 PR。
- 保持追平：每天 `git merge origin/master` 一次，别把冲突攒到合并前一次性解（`strict=true` 只保证「合并前必须追平」，不保证「攒着的 34 笔能干净合」）。
- 要改**共享函数的签名或语义**，先在主干单独提一小笔，再让功能分支 merge 主干——冲突就从「整段实现」缩成「一行签名」（教训见 §3.5 的 `local_refs` add/add）。
- 合入后分支会被自动删掉（见 §3.11），不用自己 `git push --delete`。反面例子：cc-switch 攒着 100+ 条未清理分支。

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
- pre-push hook 跑密钥守卫 + `tsc`（恒跑），**全量 vitest / cargo 只在推 master 或 tag 时跑**；推特性分支时全量由 PR 的 CI 判（分档与耗时见 §2.7）——**冲突合并后先本地 `npm run lint` + `npx vitest run` 再 push**，避免把合并问题留给 CI。
- 高冲突风险文件：`src/components/screenshot/ScreenshotOverlay.tsx`（3000+ 行）、`appStore.ts`、`hotkey_manager.rs`，外加两个**只追加型汇聚点**——`src/lib/utils.ts`（900+ 行；工作树里是 941 行 CRLF + 33 行裸 LF 的混合行尾，仓库没有 `.gitattributes`，谁编辑都可能翻出整片伪冲突）和 `.gitignore`。动这些文件前先 `git pull`，尽量只改自己负责的区段。
- 🔴 最坏的一类冲突不是「两人改了同一段」，而是 **add/add：两人各自发明了一个同名 helper**。2026-10-09 的 `feature/kynnzhou-dev`（macOS 原生支持）上，基点只有 `scan_local_refs()`，master 侧和 macOS 侧分别写出私有 `fn local_refs()`，返回类型却是 `(usize, usize, AssetRef)` 与 `(Range<usize>, AssetRef)` 两套——git 只能报 content conflict，语义上等于两个人不知道对方存在。防法两条：① 动手前先 `git grep` 同名函数与同职责实现（AGENTS 规则 11.1）；② **要改共享函数的签名/语义，先在主干单独提一小笔**，再让功能分支 merge 主干，冲突就从「整段实现」缩成「一行签名」。
- 本地 dev 跑着时 pull 一般无影响（Vite HMR 热更新）；若 pull 改了 Rust 后端需重启 dev。

**防冲突日常姿势：** 开工前先 `git pull`；小步提交、频繁 push；分支做自己的事，合入前再 pull 一次 master。

### 3.6 提交身份：先让 GitHub 认得出你

提交必须用**与 GitHub 账号绑定（已验证）的邮箱**，否则这个提交在 GitHub 上只显示成一个孤立名字——不进 Contributors、不进 contribution graph、review 时也 @ 不到人。

本项目已有前车之鉴：`git log` 里 616 个提交的作者是 `dev@clipboard-manager.local`，这个地址不是可收信域名、GitHub 无法验证，于是这些提交在贡献者图上**归属为零**——外人第一眼看到的「这个项目只有 1 个提交」。

```bash
git config user.email      # 先查：应是你账号里已验证的邮箱
# 只改本仓库，不动全局配置：
git config user.email "<你的ID>+<用户名>@users.noreply.github.com"
```

### 3.7 一个工作树只服务一个会话

本项目经常在**同一个工作树**里并行多个开发会话（人或 AI）。规矩：

- 提交前先 `git status` 看清归属，**只 `git add` 自己改的文件**；禁止 `git add -A` / `git commit -a`。
- `pre-commit` 里的 `lint-staged` 会 stash 整个工作树：别人正在写时提交，可能把他们的在途改动卷进你的提交、或从他们手底下抽走。
- `pre-push` 的两段恒跑检查都看**整棵树**：`tsc --noEmit` 编全部 `src/`，密钥守卫扫全部被追踪文件。所以他人未完成的改动照样能让轻档 push 变红，只是不再需要他们的测试全绿（2026-10-09 分档前还要连 `vitest` + `cargo test` 一起判）。推 master / tag 那档不变，仍然判整棵树的测试——树不干净就别发版。

### 3.8 master 保护规则（2026-10-09 起真生效）

实测配置（`gh api repos/lzlkyb/pastepanda/branches/master/protection` 回读）：`enforce_admins=true` + required status checks（`Rust Tests` / `Frontend Tests`，`strict=true`）+ **`required_approving_review_count=0`** + `dismiss_stale_reviews=true` + 禁 force push / 禁删分支。

三条真话：

1. **管理员也被约束**。此前 `enforce_admins` 是关的，所以历史 654 笔全部直推 master、不留分支与 PR 记录；2026-10-09 起直推 master 会被 GitHub 拒，改动一律走 PR。
2. **审批数故意是 0**。GitHub 不允许作者批准自己的 PR，而当前只有 1 位维护者 + 1 位外部贡献者——保留「需 1 个 approval」等于把维护者锁在自己的规则门外。等来了第二个人，再把这条调回 1（`gh api -X PATCH .../protection/required_pull_request_reviews -F required_approving_review_count=1`）。
3. **本仓不做 code owner 强制**。`require_code_owner_reviews` 保持 `false`，所以 `.github/CODEOWNERS` 不产生任何阻塞，已随这次改动删除——留着一个不生效的文件，比没有更容易让人误以为有人把关。同理「Require review from Code Owners」这一勾不要顺手打开：它要求「代码所有者批准」，而代码所有者就是提交者本人，又是一个自批死结。


### 3.9 日常开发节拍（同时有新功能在途 + bug 要修时）

1. **先 bug，后新功能。** bug 修常常落在汇聚点文件上（`utils.ts` / `sync/attach.rs` / `lib.rs`），新功能也常碰同一批。先把 bug 落定并推出去，新功能的改动面就变成"单侧新增"，不会再叠出 §3.5 那种 add/add。
2. **bug 必须先变红**（AGENTS 规则 23）：改前红、改后绿，两份输出留在手上。做不到稳定红的时序类，用「把延时注入制造该状态的那一层」或静态守卫取证，**不许用重跑/加压当验收**。
3. **新功能先出方案/设计稿**（AGENTS 规则 1、4），目标文件接近 300 行就新建文件而不是追加（规则 7）。
4. 验证分档，别每步全量：
   - 改完就跑：`npx tsc --noEmit`、`npx vitest run <相关测试文件>`；Rust 侧 `cargo test <module>::`；UI 改动加 `npm run lint:ui`（diff 作用域 ~0.7s）+ `npm run lint:css`。
   - 全量三段（守卫 + vitest + cargo）**不再在特性分支 push 前付**：轻档只跑守卫 + `tsc`（实测 48s），全量由 PR 的 CI 判——它已经是合入 master 的硬门槛（§3.8）。只有推 master / tag 那一档还在本地跑全量（566s），口径见 §2.7。
   - 不在开发中跑裸 `npm run lint`（全量 eslint 本机 60–90s，挂进钩子必然被 `--no-verify` 绕过；pre-commit 已用 lint-staged 只跑改动文件）。
5. 归属隔离（§3.7）：每次提交前 `git status` 判归属，只 `git add` 自己改的路径；别人的未跟踪文档一律不碰、不 `git stash`、不 `git add -A`。树上别人只剩未跟踪文件时再提交，避开 lint-staged 的整树 stash。
6. 提交粒度：一个 bug 一笔、一个功能语义单元一笔、纯文档单独一笔。攒到一个完整可交付状态再 push。
7. 三件不自动做的事：版本号（规则 2）、`npx tauri build`（规则 3）、把「欠真机点验」当已完成——点验项一律写进 commit/PR 描述或 Issue。

---

### 3.10 覆盖守卫：管理员推别人的分支会被本机拦下

§3.8 的保护只覆盖 master。协助者自己那条 `feature/kynnzhou-dev` 上，管理员 force push 覆盖掉他的提交，
GitHub 既不拦也不提示——ruleset 的 bypass 名单只认角色/团队/GitHub App，做不到「拦管理员、放行写权限的协作者」，
所以给那条分支加保护会连**他本人**要求的 `strict=true` rebase 都推不动（2026-10-09 查证后放弃这条路）。
唯一还能拦的地方是 pre-push：`scripts/prePushTier.mjs` 的 `decideOwnership`，判据和退出码见 §2.7。

- 它只读**本地对象库**：不 fetch、不联网，`git cat-file` / `merge-base --is-ancestor` / `log --format=%ae` 三种问句。
- 拒绝时机在跑任何测试**之前**——先付 48s 再告「这次本来不该推」是错的顺序（`prePushHookParity` 钉着）。
- 认作「我的」的地址是一个集合：`git config user.email` + `dev@clipboard-manager.local`（§3.6 / AGENTS 21 改地址前的 616 笔）。
- 逃生口：确认要覆盖就 `git push --no-verify`（同时跳过测试，所以只在核对过 `git log old..new` 之后用）。
- 端到端取证配方（`decideOwnership` 的单测注入假 repo，CLI 那半边用真 git 对象）：
  `git init` 一个临时仓（放 `.cache/` 下，别污染树上别人的路径），`git -c user.email=<对方的> commit` 造一条他的提交当旧 tip，
  再 `--orphan` 造一条无关历史当新 tip，喂 `printf '<local-ref> <新sha> <remote-ref> <旧sha>\n' | node scripts/prePushTier.mjs`，
  期望 `light` + `exit=9`；同一目标改成 fast-forward 期望 `exit=0`。2026-10-09 六条场景（覆盖/ff/删他分支/删我分支/新分支/旧 tip 本地没有）全按预期。

---

### 3.11 合并即自动删除头分支（2026-10-10 起）

仓库开关 `delete_branch_on_merge` 已开（回读：`gh api repos/lzlkyb/pastepanda --jq .delete_branch_on_merge` → `true`）。此后 PR **合入**的那一刻 GitHub 删掉头分支，谁都不必再手动 `git push --delete`——分支数量从此不随 PR 累积。

三条边界，全是「以为它会、其实不会」：

- **只在合并时触发**：关掉但不合并的 PR 不删；把开关打开**之前**就已合入的那些分支也不会被追溯删除，得自己 `git push --delete`（2026-10-10 已经这样清过一轮）。还没合并的分支本来就不在自动删除范围内，比如 `chore/macos-ci-check`——它会一直躺到被合并或被手删。
- **只管本仓的分支**：贡献者从自己 fork 开 PR 时，头分支存在他的 fork 里，本仓这个开关删不到，由他自己清。目前唯一的外部协助者用的是同仓分支（`feature/kynnzhou-dev`），所以他的分支会在合入时被删。
- **保护规则能豁免**：官方文档写明分支保护规则会阻止自动删除。想长期留着一条分支（比如还要复用的验证分支），给它加保护规则，而不是去找设置里的「保留名单」——没有这个东西。

配套两条本地姿势（分支在远端消失后，本地那条同名分支照样躺着，`git push --force-with-lease` 会因为 lease 比对的远端 ref 已不存在而被拒）：

```bash
git config --global fetch.prune true   # 常驻：每次 fetch 顺手抹掉远端已不存在的分支
git fetch origin --prune               # 一次性：被拒之后先跑这个再推
```

真删错了想找回：合并后的 PR 页面上有 **Restore branch**，本地那条分支还在的话直接 `git push -u origin <branch>` 重推也等价。

---

## 4. 用 AI Coding 协作

**先完成 §2「从零到能跑 dev」**（人跑一遍或让 AI 按 §2.2–§2.5 执行），§2.5 自检全绿后再开发。  
欢迎用 Claude Code / Cursor 等 AI 工具干活，但 **`AGENTS.md` 对人和 AI 同样有效**，不能当甩手掌柜。

### 4.1 选什么工具

| 工具 | 推荐度 | 说明 |
|------|--------|------|
| **Claude Code** | ★★★★★ | 它读 `CLAUDE.md`，而该文件现在只是一句指针（`@AGENTS.md`），规则正文永远只有 `AGENTS.md` 一份 |
| Cursor / Windsurf | ★★★★ | 在项目根放好规则文件（见下）即可 |
| 其他 CLI（Codex、Qwen Code 等） | ★★★ | 规则加载方式各异，需手动贴规则 |

**唯一硬要求**：不管用什么工具，**必须让它读到 `AGENTS.md`**。读不到就会踩版本号、组件行数、AI 红线这些坑。

### 4.2 让 AI 读到规则

**Claude Code**：把仓库根目录当工作区打开即可。启动后第一句先核对：

```
先读 AGENTS.md 和 CONTRIBUTING.md，用 5 条要点复述本项目的硬性规则。
```

复述不对就纠正，再开工。

**Cursor / Windsurf**：任选其一——把 `AGENTS.md` 内容贴进项目 Rules / `.cursorrules`；或在 `.cursor/rules/`、`.windsurfrules` 里写：**「开始任何任务前先完整阅读仓库根目录 `AGENTS.md`，并严格遵守」**。

**任何工具通用的开工提示词：**

```
你在 PastePanda 仓库工作。规则源是根目录 AGENTS.md（已存在，先读）。
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
Windows 桌面剪贴板管理器 + 本地知识库。仓库根目录 AGENTS.md 是规则权威，优先级高于你的默认习惯。

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

## 5. 项目硬性规则（摘要，完整版见 AGENTS.md）

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
12. **修 bug 先让它变红**：每条修复都要有「改前红、改后绿」的用例，两份输出写进 commit/PR；**重跑至绿不算修复**。时序类不稳定就用延时注入制造该状态的那一层，或加静态守卫钉住机制（完整条文见 `AGENTS.md` 规则 23）。

---

## 6. 发版（仅维护者）

用户说「tag / 打tag」时由维护者执行完整发版流程，协作者**不需要也不应该**打 tag：

1. 递增 `tauri.conf.json` 版本号（patch +1），同步 `Cargo.toml`；
2. `CHANGELOG.md` 顶部写新版本段落（**只分「新增/改进/修复」三类，用户视角**，禁文件名/实现细节/开发指标）；
3. `npm run prebuild` 确认 `src/lib/changelog.generated.ts` 已含新版本；
4. commit → push → `git tag vX.Y.Z` → `git push origin vX.Y.Z` 触发 CI 构建发布。

> CHANGELOG 是给用户看的：只说「能做什么」，不说「怎么实现的」。示例与禁忌见 AGENTS.md「发版流程」一节。

---

## 7. 求助顺序

1. 读 `AGENTS.md`（规则全集，含踩坑记录）；
2. 读 `docs/` 下的专题文档（OCR 替换、AI 架构、功能清单等）；
3. 在 Issue 里提问，或 PR 里 @ 维护者。
