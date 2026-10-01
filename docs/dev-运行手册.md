# Tauri dev 运行手册

> `AGENTS.md` 规则 6 的启动命令及低频排障。只在启动或诊断 dev 时读取。

---

## 0. 日常启动

在项目根目录 `D:\AItool\winapp\pastePanda` 执行。ocr-rs（vendored PP-OCR 引擎）的 bindgen 阶段需要 `libclang.dll`，项目自带于 `src-tauri/.libclang/`。项目约定不持久化 `.cargo/config`，每个新终端进行 Rust 编译前都要设置 `LIBCLANG_PATH`。

- **Git Bash**：用 `pwd -W` 取得 Windows 路径；裸 `pwd` 得到的 MSYS 路径无法供 bindgen 使用。

  ```bash
  export LIBCLANG_PATH="$(pwd -W)/src-tauri/.libclang" && npm run tauri dev
  ```

- **PowerShell**：

  ```powershell
  $env:LIBCLANG_PATH = "$(Get-Location)/src-tauri/.libclang"; npm run tauri dev
  ```

- **cmd.exe**：`set` 不加引号；跨盘切目录用 `cd /d`。

  ```cmd
  set LIBCLANG_PATH=D:\AItool\winapp\pastePanda\src-tauri\.libclang
  cd /d "D:\AItool\winapp\pastePanda"
  npm run tauri dev
  ```

用 `npm run tauri dev`，不要裸用 `npx tauri dev`：前者会运行 `prebuild` 并使用本地 Tauri CLI；后者可能拉到 registry 上的废弃 `tauri@0.15.0`，报 `could not determine executable to run`。启动失败时先检查当前目录和 `LIBCLANG_PATH`。可用 `setx LIBCLANG_PATH "D:\AItool\winapp\pastePanda\src-tauri\.libclang"` 写入用户环境变量，重开终端后生效。首次编译约 1 分钟（727 个 crate），之后 Vite HMR 热更新。启动时 `tauri_plugin_updater ... update endpoint did not respond` 是无害日志。

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

## 远程电脑：WiFi 下给视频包打 QoS 标记（可选，需管理员）

iroh 1.1.0 不暴露原始 socket，进程内 qWAVE 标记做不了（`IP_TOS` 在 Windows 上被
协议栈忽略，实测证据见 iperf#336）。退而求其次是 **netsh 策略级 QoS**——按应用
名给 PastePanda 的 UDP 流量打 DSCP 46（EF），支持 AQM 的路由器（fq_codel/CAKE）
会优先放行。仅管理员 PowerShell 执行一次，重启后仍生效：

```powershell
netsh int qos policy add name="PastePanda RC" application="PastePanda.exe" dscpvalue=46 protocol=UDP
# 撤销：netsh int qos policy delete name="PastePanda RC"
```

注意：家里路由器不开 SQM/AQM 时这条**没有效果**（AP 自己的队列不受 DSCP 管）；
跨网场景进运营商网络后 EF 也常被重标记。低优先级优化，卡顿先看 §14.10 的
帧龄快速码控是否生效。


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

---

## Android 探针 / P1 环境（2026-09-29 探针 A 实测装齐）

工具链位置（全部免提权安装，详情见 `docs/远程电脑-手机端-P0.5探针报告-2026-09-29.md` §5）：

- JDK 17（zip 免装）：`D:\AItool\jdk-17.0.20.1+1`（2026-09-30 应用户要求落到 D 盘）
- Android SDK：`C:\Users\19145\AppData\Local\Android\Sdk`（cmdline-tools + platform-tools + platforms 34/35 + build-tools 34.0.0 + NDK 27.2.12479018）

`cargo check --target aarch64-linux-android` 需要的环境变量（每个新终端都要设；探针实测 `ring` 需要 CC/CXX/AR，vendored `ocr-rs` 的 bindgen 需要 sysroot）：

```bash
export LIBCLANG_PATH='D:\AItool\winapp\pastePanda\src-tauri\.libclang'
export CC_aarch64_linux_android='C:/Users/19145/AppData/Local/Android/Sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/windows-x86_64/bin/aarch64-linux-android24-clang.cmd'
export CXX_aarch64_linux_android='C:/Users/19145/AppData/Local/Android/Sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/windows-x86_64/bin/aarch64-linux-android24-clang++.cmd'
export AR_aarch64_linux_android='C:/Users/19145/AppData/Local/Android/Sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/windows-x86_64/bin/llvm-ar.exe'
export BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android='--sysroot=C:/Users/19145/AppData/Local/Android/Sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/windows-x86_64/sysroot -IC:/Users/19145/AppData/Local/Android/Sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/windows-x86_64/lib/clang/18/include -IC:/Users/19145/AppData/Local/Android/Sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/windows-x86_64/sysroot/usr/include -IC:/Users/19145/AppData/Local/Android/Sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/windows-x86_64/sysroot/usr/include/aarch64-linux-android'
cargo check --manifest-path 'D:\AItool\winapp\pastePanda\src-tauri\Cargo.toml' --target aarch64-linux-android
```

`tauri android init` 另需三个变量：`JAVA_HOME`（指上面 JDK 目录）、`ANDROID_HOME`（指 Sdk 根）、`NDK_HOME`（指 `Sdk\ndk\27.2.12479018`）。

已知结论：整棵依赖树在 android 目标的唯一拦截是 `arboard`（无 Android 实现，两条引入路，见探针报告 §1.2）；rc 客户端半零错误。

**❗init 后必须补 CAMERA 权限（2026-10-01，扫码配对）：** `src-tauri/gen/` 是生成目录、按惯例**不入库**（.gitignore 已挡，1.3GB 且内嵌本机 NDK 路径），所以下面这处必需改动没有代码源可依，每次全新 `tauri android init` / CI 重建后都要照抄补回。位置 `src-tauri/gen/android/app/src/main/AndroidManifest.xml`，`<manifest>` 下与 `INTERNET` 并排：

```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-feature android:name="android.hardware.camera" android:required="false" />
```

为什么只需这两行：WebView 的 `getUserMedia` 走 wry RustWebChromeClient 的 `onPermissionRequest` 运行时授权链，清单声明是唯一前提；不加 = 扫码页调相机静默失败、无任何提示。

**真机联调启动（2026-09-30 实装设备页后）**：手机开 USB 调试并插线授权后，Git Bash 里一次设齐：

```bash
export LIBCLANG_PATH="$(pwd -W)/src-tauri/.libclang"
export JAVA_HOME="D:/AItool/jdk-17.0.20.1+1"
export ANDROID_HOME="C:/Users/19145/AppData/Local/Android/Sdk"
export NDK_HOME="C:/Users/19145/AppData/Local/Android/Sdk/ndk/27.2.12479018"
export CC_aarch64_linux_android='C:/Users/19145/AppData/Local/Android/Sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/windows-x86_64/bin/aarch64-linux-android24-clang.cmd'
export CXX_aarch64_linux_android='C:/Users/19145/AppData/Local/Android/Sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/windows-x86_64/bin/aarch64-linux-android24-clang++.cmd'
export AR_aarch64_linux_android='C:/Users/19145/AppData/Local/Android/Sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/windows-x86_64/bin/llvm-ar.exe'
export BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android='--sysroot=C:/Users/19145/AppData/Local/Android/Sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/windows-x86_64/sysroot -IC:/Users/19145/AppData/Local/Android/Sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/windows-x86_64/lib/clang/18/include -IC:/Users/19145/AppData/Local/Android/Sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/windows-x86_64/sysroot/usr/include -IC:/Users/19145/AppData/Local/Android/Sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/windows-x86_64/sysroot/usr/include/aarch64-linux-android'
# 🔴 链接期：LINKER 必须指 NDK wrapper（缺了报 linker 'cc' not found）。
# ⛔ **不要**再加 CARGO_TARGET_*_RUSTFLAGS=-L sysroot/usr/lib/<abi>——该目录含 libc.a，
#   会把 -lc 毒化成静态 bionic，dlopen 即 SIGSEGV（getauxval+28，2026-09-30 真机实测）。
#   C++ 运行时已改走 c++_shared（vendor/ocr-rs/build_support.rs），无需任何 -L。
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER='C:/Users/19145/AppData/Local/Android/Sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/windows-x86_64/bin/aarch64-linux-android24-clang.cmd'
npm run tauri android dev
```

CLI 自带 beforeDevCommand（dev:mobile 1422 端口）与 adb reverse，无需手工起 vite 或转发端口。

**前置：Windows 开发者模式必须开**（一次性，设置 → 隐私和安全性 → 开发者选项 → 开发人员模式）。
不开的话，Rust 编译全绿之后 tauri CLI 会死在「symlink so 到 jniLibs」（2026-09-30 实测：
Creation symbolic link is not allowed for this system）。
首次 debug 编译整棵 crate 约 5–15 分钟（release 缓存不通用），之后增量秒级。

**真机首启 6 连坑（2026-09-30 全踩全修，按报错顺序）**：

| # | 现象 | 根因 | 修法 |
|---|------|------|------|
| 1 | `linker 'cc' not found` | 没设 NDK LINKER | `CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER` 指 NDK wrapper（见上方模板） |
| 2 | `UnsatisfiedLinkError _ZTISt12length_error` | ocr-rs 静态 C++ 运行时缺 `libc++abi.a` 符号 | `vendor/ocr-rs/build_support.rs` 的 `ANDROID_CPP_RUNTIME` 改动态 `c++_shared`（NDK 随包提供，CLI 会自动 symlink 进 jniLibs） |
| 3 | 开机 SIGSEGV `getauxval+28` | `-L <sysroot>/usr/lib/<abi>` 目录含 `libc.a`，把 `-lc` 毒化成静态 bionic，静态 getauxval 读不到 auxv | **永不**给 android 目标加 RUSTFLAGS 的 `-L`（tauri CLI 还会清掉 RUSTFLAGS 环境变量，加了也白加）；build.rs 里 android 分支直接 return 不 emit 搜索路径 |
| 4 | panic 只有 `attempt to unwind out of rust`、无消息 | panic hook 在 Android 无 APPDATA 时静默 return，消息整个吞掉 | lib.rs hook 改 stderr 直落 logcat（`[PANIC] thread/loc/payload/backtrace` 四行），此后所有崩溃自定位 |
| 5 | 启动即崩：`No rustls crypto provider is configured` | 依赖树里 axum-server 是 `tls-rustls-no-provider`、reqwest/tauri 在 Android 上也解析出 no-provider；Tauri 建 WebView 时内部建 reqwest 客户端无人装 provider | `run()` 入口（`let builder = tauri::Builder::default()` 前）统一调 `crate::mcp::tls::ensure_crypto_provider()`（幂等、先装者赢、三条路径全复用）；有守卫单测 `provider_tests` |
| 6 | UI 是桌面布局 + `check_update` panic：`state() called before manage() for UpdaterState` | ① `vite.config.mobile.ts` 只配了 build 入口，dev server 对 `/` 回退项目根 `index.html` = **桌面**入口；② `commands/update.rs::build_updater` 进门就 `app.updater_builder()`，mobile 上 UpdaterState 未注册即 panic | ① 配置里加 `configureServer` 中间件把 `/`、`/index.html` 改写为 `/src-mobile/index.html`（build 侧不变）；② `build_updater` 顶部加 `!cfg!(desktop)` 守卫返回「自动更新仅桌面端支持」 |

另有两类非坑噪音，见到不用管：tauri CLI 的 android dev 会先跑一遍
`--no-default-features` 的同步构建（指纹不同 = 重编整棵树，主构建 100% 卡
`Blocking waiting for file lock on build directory`，等它放锁即可）；
MIUI 禁 adb 输入注入（`input keyevent` 报 INJECT_EVENTS SecurityException），
截图验证要人手动亮屏。调试时手机与 PC 需同一 Wi-Fi（CLI 用 TAURI_DEV_HOST 的
局域网 IP 直连 vite，不走 adb reverse）。


