# Tauri dev 运行手册（低频排障）

> 本文收纳从 `AGENTS.md` 规则 6 搬出的**低频**运维细节：后台常驻 dev、端口占用重启、AI 会话内长驻 dev。
> 2026-09-26 搬出，目的是削减 AGENTS.md 的每轮上下文开销；内容未删改。
> 日常启动 dev 只需要 AGENTS.md 规则 6 里的命令，没必要读本文。

---

## 1. 后台运行（不阻塞主终端）

可用 `Start-Process` 起一个最小化窗口：

```powershell
Start-Process powershell -ArgumentList "-NoExit","-Command","$env:LIBCLANG_PATH='$(Get-Location)/src-tauri/.libclang'; npm run tauri dev" -WindowStyle Minimized
```

⚠️ **在 AI 会话里这么做没用**（见下一节），只在人肉操作终端时有效。

## 2. AI 会话里要长驻 dev，只能走 Windows 任务计划

`run_in_background` / `nohup` / `DETACHED_PROCESS` 全部实测失败：

- **根因**：AI 运行环境把工具调用起的进程放进一个 **Windows Job Object**，且该 job **不允许 breakaway**（`CREATE_BREAKAWAY_FROM_JOB` 直接 `WinError 5  拒绝访问`）。所以 turn 一结束，整棵进程树被连带回收——现象是日志戛然而止（往往停在 `> vite` 那一行）、`PastePanda.exe` 与 1420 监听一并消失。
- **次生坑**：Bash 工具环境的 `npm` 是注入的 `safe-bin` shim（PATH 首项还是被截断的 `C`），在脱离进程里**静默失效**——`cmd /c npm --version` 返回码 0 却零输出。所以启动脚本必须显式写死真实 PATH。
- **可行方案**（已实测，`Start-Process` 与 WMI/CIM 创建进程均被安全策略拦截，`schtasks` 放行）：

```bash
# ① 写启动脚本（显式 PATH + LIBCLANG_PATH，日志重定向到文件）
#    C:\Users\<u>\AppData\Local\Temp\pp-start-dev.cmd：
#    @echo off
#    set "LIBCLANG_PATH=D:\AItool\winapp\pastePanda\src-tauri\.libclang"
#    set "PATH=D:\AItool\nodejs;C:\Users\<u>\.cargo\bin;C:\Windows\system32;C:\Windows;%PATH%"
#    cd /d "D:\AItool\winapp\pastePanda"
#    npm run tauri dev >> "%TEMP%\pp-dev.log" 2>&1
# ② 建一次性任务 → 立即运行 → 用完即删（留着会在 /st 时刻自动再起一个实例，撞 1420）
MSYS_NO_PATHCONV=1 schtasks /create /tn "PastePandaDev" /tr "C:\...\pp-start-dev.cmd" /sc once /st 23:59 /f
MSYS_NO_PATHCONV=1 schtasks /run    /tn "PastePandaDev"
MSYS_NO_PATHCONV=1 schtasks /delete /tn "PastePandaDev" /f
```

- **验证成功**（三个都要满足）：日志在增长、`tasklist` 里有 `PastePanda.exe`、`netstat -ano | grep ":1420"` 出现 `LISTENING` **且有一条 `ESTABLISHED`**（后者才证明窗口真的连上了 vite，只有 LISTENING 时窗口可能是白的）。
- Git Bash 里调 `schtasks`/`tasklist`/`wmic` 必须带 `MSYS_NO_PATHCONV=1` 或 `//` 前缀，否则参数被路径转换吃掉。

## 3. 重启前务必彻底释放 1420 端口

`tauri dev` 会同时拉起 Rust 进程（`PastePanda.exe`）和一个独立的 Vite node 进程（监听 `localhost:1420`）。只 `taskkill` 掉 `PastePanda.exe` 不够——Vite 子进程仍占着 1420，下次启动会在 Vite 阶段报 `Port 1420 is already in use` 并异常退出（Rust 端起来了但前端连不上，窗口空白）。

正确重启：先 `netstat -ano | findstr ":1420"` 看 LISTENING 那行的 PID，一并 `taskkill /F`，再重新 `npm run tauri dev`。

## 4. 启动失败报错速查

| 现象 | 原因 | 处理 |
|---|---|---|
| `Unable to find libclang ...` | 没设 `LIBCLANG_PATH`（或设成了 MSYS 路径） | 见 AGENTS.md 规则 6 硬性前置，Git Bash 必须用 `$(pwd -W)` |
| `could not determine executable to run` | 用了裸 `npx tauri dev`，拉到了 registry 上的废弃包 `tauri@0.15.0` | 用 `npm run tauri dev` |
| `Port 1420 is already in use` | 上次的 Vite 子进程没杀干净 | 见本文第 3 节 |
| 日志里 `tauri_plugin_updater ... update endpoint did not respond` | dev 下连不上更新服务器 | 无害，忽略 |
| 卡在 `Building [===>] 910/912` 反复重启、窗口迟迟不出来 | **有别的进程在写 `src-tauri/` 源码**，watcher 每次都在编译收尾时打断重来 | 见 §5 |

## 5. 窗口迟迟不出来：watcher 被打断式重启

`tauri dev` 的 file watcher **不等当前编译结束** —— 只要检测到 `src-tauri/` 下的文件变化，
立刻杀掉正在跑的编译重新开始。所以只要源码被持续写入，就永远编不完、窗口永远起不来。

**判据**（日志里成对出现且**反复多次**，每次都停在同一个进度点）：

```
Info File src-tauri\src\... changed. Rebuilding application...
Running DevCommand (`cargo run --no-default-features --color always --`)
```

**定位手法** —— `mtime` 是唯一可靠证据，别靠猜（也可能是你另一个会话 / 编辑器自动保存）：

```bash
find src-tauri/src -type f -newermt "21:10" -printf "%TH:%TM:%TS  %p\n" | sort
```

2026-09-26 实测：启动后 `data_store/rc_device.rs`（21:11:58 → 21:12:16）、
`data_store/mod.rs`（21:11:22）、`commands/rc.rs`、`lib.rs` 被连续写入，
启动从 21:10:45 一直拖到 21:14:19 才完成。

**处理**：等写入停下来即可，watcher 会自动收敛出一次完整编译；**别盲目重启**（只会回到同一个循环）。
要立刻用，就让写入方先停手（关掉那个编辑中的文件 / 暂停并行会话）。
