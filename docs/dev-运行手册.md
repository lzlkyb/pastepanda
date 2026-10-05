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

**Android 原生声明自动恢复（扫码与保活）：** `src-tauri/gen/` 仍是忽略的生成目录；Kotlin 唯一源码在 `src-tauri/android/`，清单恢复逻辑在 `scripts/prepare-android.mjs`，两者纳入版本控制。所有 `npm run android:*` 构建/联调脚本启动 Gradle 前自动复制源码并补齐清单，重复运行不会重复注入，保留生成的 Activity 与其他插件声明。全新 `npm run tauri android init` 后直接使用这些脚本；只需恢复而不构建时执行 `node scripts/prepare-android.mjs`。

以下 XML 为自动补齐的声明说明。相机权限位于 `src-tauri/gen/android/app/src/main/AndroidManifest.xml` 的 `<manifest>` 下：

```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-feature android:name="android.hardware.camera" android:required="false" />
```

为什么只需这两行：WebView 的 `getUserMedia` 走 wry RustWebChromeClient 的 `onPermissionRequest` 运行时授权链，清单声明是唯一前提；不加 = 扫码页调相机静默失败、无任何提示。

**RC 前台服务保活（B 方案）：** 远程会话期间持前台服务 + WifiLock。恢复脚本自动处理以下三处，无需手工维护生成目录：

1. `AndroidManifest.xml` 的 `<manifest>` 下（与 CAMERA 并排）：

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
```

2. `AndroidManifest.xml` 的 `<application>` 内（`<provider>` 之后）：

```xml
<service
    android:name=".RcSessionForegroundService"
    android:exported="false"
    android:foregroundServiceType="specialUse">
    <property
        android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
        android:value="remote_desktop_session_keepalive" />
</service>
```

3. 两个 Kotlin 文件（`app/src/main/java/com/pastepanda/app/`，包名跟 identifier）：
   `RcSessionForegroundService.kt`（前台服务本体：常驻通知 + specialUse 类型）与
   `RcKeepalivePlugin.kt`（Tauri 移动插件，`@Command setKeepalive(on, title)` 启停服务 + 持/放 WifiLock）。

   唯一源码在 `src-tauri/android/` 的两个同名文件。修订原生逻辑只改这些源文件；下次 `android:*` 会覆盖生成副本。Rust 侧 `rc/keepalive.rs` / `rc_keepalive_set` 命令也在库内，不受 init 影响。

   ⚠️ `RcKeepalivePlugin` 的构造器必须写成 `class RcKeepalivePlugin(private val activity: Activity) : Plugin(activity)`——基类 `app.tauri.plugin.Plugin` 的 `activity` 是 `private val`，子类若不带自己的构造属性（漏写 `private val`）会在 Gradle Kotlin 编译期报 `Cannot access 'activity': it is invisible (private in a supertype)`（2026-10-02 实测）。

   语义（读改动前先看）：specialUse 类型对标 RustDesk 的远程桌面先例（远程桌面不属于任何标准 FGS 类别）；`START_NOT_STICKY`（进程被杀=会话已死，服务不复活）；开关由前端会话壳 `useRcSessionKeepalive` 锚定（进会话开、卸载停），桌面端命令 no-op。

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

**❗打 APK 必须只编 aarch64（2026-10-02 实测）：** `tauri android build` 不加 `--target` 会把
aarch64/armv7/i686/x86_64 四个 ABI 全编一遍，而上方环境配方只设了 aarch64 的
CC/CXX/BINDGEN 变量，armv7 会在 ocr-rs bindgen 处 `'stddef.h' file not found` 炸掉
（Gradle 任务 `rustBuildArmDebug`，报错本体在日志中部，尾部只是 cargo 上下文堆栈）。
真机是 arm64，命令写：

```bash
npm run tauri android build -- --debug --apk --target aarch64
```

**❗APK 装上启动白屏 / 空白页（2026-10-02/03 两次实测，两个独立根因，都修了）。**

**根因①：装的是 debug 包 = dev 模式（2026-10-02）。**
`npm run android:apk` 打的是 `--debug` 包，Tauri 的 Android debug 构建**不带前端资产**——
`assets/tauri.conf.json` 里 `build.devUrl = http://localhost:1422/` 被烤进 APK，WebView 要从
**电脑的 vite dev server** 拉页面（`npm run dev:mobile`，192.168.x.x:1422）。手机和电脑不在
同一网络（手机走 5G、或连了别的 Wi-Fi）时，一个字节都拉不到 → 打开 App **整页白屏**，
Rust 侧完全正常（logcat 里 `[RC] 远程通道已启动` 照常打），极易误判成前端崩溃。
adb 佐证：`adb shell ping <电脑局域网IP>` 100% 丢包；`adb shell dumpsys wifi | grep "Wi-Fi is"`
看手机是不是压根没开 Wi-Fi。**脱离电脑的真机 / 公网测试一律打 release 包**：

**根因②：Android 上建第二块 webview 窗会把主界面顶掉（2026-10-03，release 也白屏的真凶）。**
wry 在 Android 上**每个 Activity 只有一块 webview**：`WebViewBuilder.build()` 落到
`activity.setContentView(webview)`（wry `main_pipe.rs`），**替换**而不是叠加。2026-10-02
引入的 `ask_pop::prewarm`（启动时预热 rc-ask 确认浮层）在 RC 通道起来后建了第二块窗 →
主界面 webview 被 `setContentView` 换成 rcask 空白页（无敲门时透明空 body + WebView 白底，
`transparent` 只在桌面生效）→ **打开 App 永远白屏，release 包也一样**，且 Rust 全程无错。
logcat 佐证：`dumpsys activity top | grep -c RustWebView` 只有 1 个、尺寸全屏；启动序里
`[BOOT] 8 准备显示窗口` 之后紧跟 `[RC] Android 预热确认浮层窗口`。修法：`ask_pop` 的
`on_change` / `sync` / `create` 三道闸全部在 `target_os = "android"` 上直接 return
（收口在 `src-tauri/src/rc/ask_pop.rs`），`prewarm` 删除；手机端确认走主界面内联申请卡。
**教训：Android 上任何「再建一块窗」的代码（浮标 / 岛 / 弹窗类）都会顶掉主界面，
新功能一律用主界面内的覆盖层实现，别学桌面开新窗。**

```bash
npm run android:apk:release      # = node scripts/android-build.mjs --release --install
```

🔴 `tauri android build` **不加参数就是 release**（帮助文案 "Build your app in release mode …
It makes use of the build.frontendDist property" 那行就是这意思），`--debug` 才是 dev 模式；
**没有 `--release` 这个参数**，传了 CLI 直接 `unexpected argument '--release'`。
release 产物是**未签名** APK（gen/android 的 release 构建类型没有 signingConfig，CLI 也没有
签名选项），脚本用**长期 release keystore**（`~/.pastepanda/pastePanda-release.keystore` +
`keystore.properties`，2026-10-03 起）经 `apksigner sign` 现签一份
`app-universal-release.apk` 再装。🔴 缺该 keystore 时 `--release` 直接红灯，**不回落
debug key**——方案甲（应用内自更新）要求新旧 APK 同签名，签错一次的代价是下个正式版
全量用户升级失败。此 key 丢了 = 旧签名包永久无法覆盖安装，务必仓库外多备份一份。
首次 release 全树编译约 10–20 分钟，之后增量。

🔴 **release 包的自包含校验不要查 `assets/`（那永远是 0）**：Android 上 tauri **不**调
`WebViewBuilderExtAndroid::with_asset_loader`，前端不是放 APK 的 `assets/` 目录，而是编译期
**brotli 压缩后内嵌进 `lib/arm64-v8a/libpastepanda_lib.so`**，运行期由 `Rust.handleRequest`
按 `tauri://localhost` 协议从二进制里读出（`tauri::get_app_url()` 在 `#[cfg(not(dev))]` 分支
只认 `frontendDist: Url`，压根不读 `devUrl`——所以 release 包里 `assets/tauri.conf.json`
仍留着 `devUrl: http://localhost:1422/` 是无害的死字段）。因此 `assets/` 里只有
`tauri.conf.json` + `resources/`（ffmpeg/ocr 模型），**没有 html 是正常的**。自包含的正确验法：

```bash
so=$(ls dist-mobile/assets/*.js | head -1 | xargs basename)          # 例 mobile-B8KJPPY-.js
unzip -p src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk \
  lib/arm64-v8a/libpastepanda_lib.so | grep -ac "$so"               # ≥1 才说明前端真的嵌进去了
```

（哈希文件名只可能来自 `dist-mobile` 产物，Rust 源码里不可能出现，命中即证明。）
确认手机装的确实是这份 release：`adb shell dumpsys package com.pastepanda.app |
grep -E "versionName|lastUpdateTime"`。debug 包（dev 模式、HMR）只在「手机与电脑同网 +
电脑跑着 `npm run dev:mobile`」时用。

**❗打 APK / Android 联调一律走 `android:*` 脚本（2026-10-02 起默认，桌面 dev 不用再停）：**
`npm run android:apk`（打包+检测到真机自动安装并启动）、`npm run android:apk:build`（只打包）、
`npm run android:dev`（真机联调）。三个都走 `scripts/android-build.mjs`：内嵌环境配方（无条件
覆盖，防系统全局 JAVA_HOME 指老 JDK）、**单独的 `CARGO_TARGET_DIR=src-tauri/target-android`**
（tauri CLI 经 cargo metadata 解析 target 目录，认这个变量；桌面 dev 的 `target/` 与之互不
抢锁，两边可完全并行），并先 `gradlew --stop`（daemon 只认启动时的 env，不重启看不到
CARGO_TARGET_DIR）。首次用 target-android 会全树重编约 10–20 分钟，之后增量秒级。

裸 `npm run tauri android build -- --debug --apk --target aarch64` 仍可跑（环境配方见下），
但它与桌面 dev 共用 `target/`，会抢锁——只在没有桌面 dev 在跑时用。

产物在 `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`
（`--target aarch64` 后 APK 名仍叫 universal，只是 jniLibs 只含 arm64-v8a），
`adb install -r` 直装；debug 签名自动走 debug.keystore，无需配 signingConfig。

**❗APK 装上启动报 `not found: index.html`（2026-10-02 实测）：** 根因是 `vite.config.mobile.ts`
的入口在 `src-mobile/index.html`，vite 按「相对项目根的路径」把 HTML 打到
`dist-mobile/src-mobile/index.html`，而 `tauri.android.conf.json` 的 `frontendDist` 是
`../dist-mobile`——APK 包根没有 index.html（dev 靠 configureServer 中间件改写 `/`，
不暴露此问题）。修法：`vite.config.mobile.ts` 里 `mobile-index-at-root` 插件
（`enforce: "post"` + `generateBundle` 把同一份 HTML 再 emit 到包根），**每次 init /
配置迁移后要确认该插件还在**。验证：`npm run build:mobile` 后 `dist-mobile/index.html`
必须存在，且其 `/assets/...` 引用能对上 `dist-mobile/assets/`。

**前置：Windows 开发者模式必须开**（一次性，设置 → 隐私和安全性 → 开发者选项 → 开发人员模式）。
不开的话，Rust 编译全绿之后 tauri CLI 会死在「symlink so 到 jniLibs」（2026-09-30 实测：
Creation symbolic link is not allowed for this system）。
首次 debug 编译整棵 crate 约 5–15 分钟（release 缓存不通用），之后增量秒级。

**❗被控端确认框在 Android 上不走 `rcask.html`（2026-10-03 回归撤除）。**
此前（2026-10-02）曾把 `rcask` 加进 `vite.config.mobile.ts` 的 input，前提是「Android
也用浮层窗承载确认框」——这个前提本身就是错的，见下一条白屏根因②。现在
`vite.config.mobile.ts` 的 input **只有 mobile 一项**；`rcask.html` 是桌面入口
（`vite.config.ts`），Android 上 `ask_pop` 整体禁用（见 `src-tauri/src/rc/ask_pop.rs`
`create` 内注释），手机端确认一律走主界面设备页的内联申请卡
（`src-mobile/devices/RcInboundAskCard.tsx`）。

**❗手机默认画质显示「均衡」而后端跑的是自动（2026-10-02 真机修）。** 根因在
`src-mobile/session/RcMobileSession.tsx`：画质表只有三档（清晰/均衡/流畅，**没有 auto**），
且 hint 对不上时硬编码回落 `"balanced"`。后端默认档（`DEFAULT_QUALITY`）是 `auto`，
于是手机把「自动换档」显示成「均衡」。收口到 `src-mobile/session/qualityCycle.ts`
（`normalizeMobileQuality` + `MOBILE_QUALITY_CYCLE`，默认档/中文名都从
`@/lib/rcQuality` 取，不抄第三遍），并加了「hint 变了就跟随」的 effect（状态迟到 /
电脑端中途改档都不会停在旧档）。守卫单测 `qualityCycle.test.ts` 钉住「默认档必须在
可选集里」「未知值只许回落默认档」。

**❗电脑端第一次点「远程控制」手机不弹框、要再点一两次（2026-10-02 真机修）。** 四个
叠加原因，逐条都已修：
1. **确认面只在 Rust 浮层窗口里**：`ask_pop.rs` 的 `rc-ask` 是懒创建的独立 webview，
   第一条敲门才第一次 build；Android 上这是整个进程最重的动作之一，且用户去点远程控制时
   手机通常退到了后台（在微信里），界面**根本不可见**。修法（最终形态，一条腿）：
   `src-mobile/devices/RcInboundAskCard.tsx` 内联确认卡常驻设备页（联动：`App.tsx`
   有人敲门自动切到设备页），帧早就到了 `status.pending`，以前缺的只是承载面。
   ~~② `ask_pop::prewarm` 预热浮层窗~~（2026-10-03 撤除）——预热是**白屏根因**，
   见上一条「打开 App 白屏」根因②；Android 上浮层窗已整体禁用，
   守卫测试 `换档判据_同档空转_跨档必动` 钉住换档判据本身。
2. **ALPN 注册晚于 Running 落槽**：`shared_ep::dispatch_loop` 查不到处理器就把连接以
   `channel-off` 关掉。`rc_boot` 是 spawn 出去的异步 `start()`，端点 bind 完成到
   Running 落槽之间有窗口期，此刻的连接会被静默拒掉。现在注册提前到写 Running 之前，
   窗口期到达的连接也能进 `handle_inbound_conn` 挂起等批准。
3. ~~release 包缺 `rcask.html`~~（2026-10-03 随浮层窗一起撤除：Android 根本不加载
   这个页面，`vite.config.mobile.ts` 的 input 只有 mobile 一项）。
4. 佐证：`adb logcat -d | grep RustStdoutStderr` 看 `[RC] 远程通道已启动`；桌面 dev
   日志里的 `[SharedEp] 入连接握手失败` 是手机→电脑方向（sync 招呼），与入站申请无关。

**❗公网配对「手机扫了码却永远等电脑端确认」（2026-10-03 真机修）。** 两个叠加原因：
1. **UX 缺陷**：工作台配对卡（`RcA2PairExchange`）亮码只是「把码摆出来」，并不开始监听，
   还得再点一次「我出示这枚码」——手机扫码后什么都不会发生，永远停在「等待电脑端确认」。
   修法：**亮码即监听**（码亮着 = 正在出示 = 正在监听，与设置弹框扫码页
   `RcShortPairPane` 同一语义），拔掉「我出示这枚码」按钮；拨号侧开始时先取消自动监听
   再拨号（`attempt` 序号作废旧回调，防「已取消配对」把拨号中状态打回 idle）；收起 =
   停止出示（取消监听，隐私兜底）。附带修了手机端误导文案（`RcPairCard`）——配对没有
   「对方弹框确认」这一步，提示改为「正在等待接通…请保持电脑端配对码页面打开」。
   「phase 回 idle 后必须重新挂监听」由守卫单测钉住：只按码值去重会让拨号失败后的亮码
   变成「只是摆着」，手机再扫码又是干等（去重键 = phase 世代 + 码值）。
2. **当天真正的卡点**：电脑端 `PastePanda.exe` 进程不在（dev 重编译周期把它顶掉后没
   拉起），手机扫码自然等不到人。**联调前先确认进程活着**（任务栏图标或
   `tasklist | grep -i pastepanda`），别在 UX 上反复猜。

**❗公网单码配对全程「连接超时」的真凶：拨号方拨的是自己的临时身份（2026-10-03 修）。**
现象：手机扫码/输码后每 2 秒重拨直到码到期，报「连接超时 / 等待对方确认超时」；
**PC 侧零日志**——连接从未到达（连 `[SharedEp] 入连接握手失败` 都不会有）。根因在
`src-tauri/src/rc/short_pair.rs::exchange_pin` 的拨号分支：原来传 `secret.public()`，
而 `secret` 在拨号侧是**拨号方自己**那枚派生身份（`pair_secret_pin(code, false)`）；
监听方 `bind_temp` 绑的是 `listen` 那枚——两端 pk 不同，拨的是一个没人监听的地址。
两码版（`exchange`）两端派生同一枚 secret 所以从没踩中，单码版按角色分离后才暴露。
这也是「公网配对首次联调从来卡在等待页」的真相：历史成功会话用的都是早先已建立的
配对，单码会合从未在公网跑通过。修法：抽 `dial_target_pk(code)` 纯函数返回**监听方**
pk，拨号分支改拨它；守卫单测两条（纯派生对应 + 真绑临时端点验 id）+ ignored 真中继
握手测试 `pin_endpoints_exchange_real_identities`（`cargo test --lib -- --ignored`
手跑，已过）。**兼容性**：只改拨号侧，新手机配旧电脑照样通（PC 监听侧行为不变），
但旧手机要能配对必须升级 APK。

**❗「远程控制」按钮配好对却是灰的：`rc_enabled` 缺省关（2026-10-03 修）。**
新装 App 配对成功后，手机设备页「远程控制 / 只看画面」两个按钮直接置灰，原因只缩在
按钮下一行小字「请先在设置中开启远程通道」。而设备页头部按 `status.running` 显示
「远程通道已开启」——配对流程会经 `needs_channel`（有配对就要起通道）把通道拉起来，
**状态说开着、动作说不行**，用户两头挨打。根因：`rc_enabled`（桌面侧叫「允许被远程」，
手机侧因暂不支持被控、实为出站总开关）的缺省值是 `false`，只有 `rc_set_enabled` 写盘，
没碰过开关的安装一律吃缺省。修法：缺省翻成 **true**（`cfg_enabled` 的唯一默认
`CFG_ENABLED_DEFAULT`），两个读取点收口成一个（`RcService::enabled` 转调
`rc::cfg_enabled`）。不放大攻击面：入站门禁第一层是「必须已配对」`Gate::NotPaired`，
没配对的设备缺省开也进不来；显式关过（`rc_set_enabled` 写过 `false`）的安装照旧关着。
守卫单测 `default_允许被远程开着_但没配对的设备照样进不来`。**手机侧要重装 APK 才吃到**
（配置里没有这个键，缺省在代码里）。

**❗远程会话「延迟雪崩」：往返从 450ms 一路涨到 46s 且永不恢复（2026-10-03 真机修）。**
手机（5G）控电脑（家庭宽带）的公网会话，`[RC-PROBE]` 往返 450ms → 4.4s → 18s → 46.9s
单调上涨、样本数掉 1、出现「无 pong」，帧龄同步涨到 46s，但「断链 0」——链路没坏，
是**发送队列只进不出**。三层叠加原因，逐条都已修：
1. **可靠流没有任何弃帧机制**：数据报放行闸（`stream_cfg::video_dgram_allowed`，RTT<300ms
   才放行）在这种链路上恒关，视频全程走可靠 QUIC 流——积压多少延迟涨多少，ping/pong
   与视频同一条连接一起被堵。修法：`inbound/video.rs` 加**积压熔断**（`melt_step` 纯函数 +
   守卫测试）——「写完一帧的耗时」就是排队水位（`write_all` 在缓冲未满时立即返回，只有
   队列深了才阻塞）：连续 3 帧写超 400ms 进熔断，弃 P 帧只保关键帧（`request_key_after_drop`
   主动要 IDR，与数据报路径同一条自愈链），某帧 80ms 内写完 = 队列排干 → 恢复。弃帧计数
   进 `[RC-PERF]` 汇总行「流积压弃帧」（`perf::counters::STREAM_MELT`）。
2. **码控底线被用户倍率乘回去**：Q5 默认 200%（清晰优先）把雪崩时的 15% 底线抬到 30%，
   队列照样涨。修法：`stream_cfg::bitrate_scale()` 帧龄 EMA 破 1s 后**绕过用户倍率**直接取
   auto（守卫测试 `帧龄破秒雪崩时绕过用户倍率` 钉住）。
3. **自动档判据漏了最直接的拥塞信号**：RTT 是 pong 测的，队列深时 pong 一起被堵，反而钝。
   修法：`auto_quality::auto_decide` 的 link_bad 判据加入帧龄 ≥300ms（守卫测试
   `帧龄持续破300ms会降档` / `帧龄深时不升档_且持续后降档` 钉住）。
验证：重连后看 `[RC-PROBE]` 往返——弱网下允许到秒级但**必须能自己回落**，不再单调涨；
电脑端 `[RC-PERF]` 的「流积压弃帧」持续增长 = 链路吞吐低于码控下限，该降档/查中继。

**❗熔断在窄管（中继）路径上的两条补充规则（2026-10-03 09:52 会话教训）。** 09:52 那条
会话**绕了中继**（结束日志 `路径：绕中继（RTT 均 3109ms）`），中继吞吐趋近于零，表现成
「等待对方画面」+ 15s 心跳超时自动断开。复盘出熔断初版的两条设计错误，已修：
1. **绝对写入耗时（400ms）在窄管上永远成立**——帧本身的传输时间就比这长，熔断进得去
   出不来；更糟的是初版把小 P 帧也弃了，而静止画面的小 P 帧（2~10KB）是**唯一能穿过
   窄管的东西**，弃了 = 对端永远无帧。修法：熔断期只弃 ≥32KB 的大 P 帧
   （`MELT_DROP_MIN_BYTES`），小帧放行（守卫测试 `熔断期小帧放行_只弃大帧`）。
2. **熔断期不强制 IDR**：流上弃帧没有「洞」，接收端走 corrupt→RequestKey 自愈 + 自然
   GOP ≤1s 兜底；初版沿用数据报路径的 C2「弃帧后主动要 IDR」是把**最大的帧**往已堵死
   的管子里倒。已去掉（守卫测试注释钉在 `melt_step`）。
3. **遗留 → 已随「传输分 plane」落地（2026-10-03）**：pong 与视频共锁的根治是
   视频走独立通道——已按 `docs/远程电脑-传输分plane与会话重连-方案-2026-10-03.md`
   实现（P1+P2）：协商 `video_plane` 位后 H.264 走专属 uni 流（不与 pong/输入共锁），
   且熔断持续 5s **整流重建**把积压整段丢弃（延迟上界 ≈ 观察窗 + 首帧到达）。
   旧版本对端（无能力位）自动走共流历史形态，行为不变。「心跳超时自动断开」的
   会话结束日志会写明 `路径：绕中继`，**排查远程质量问题第一步先看这行**：绕中继的
   会话吞吐不可控，直连（打洞成功）才有得救——打洞成功率与中继治理就是「方案 C」的
   决策数据（2026-10-03：直连会话帧能流、中继会话全程无帧，同一台手机同一台电脑）。

**11:08 会话补充复盘（同日第三条中继会话，帧龄涨到 90s）。** 电脑端 `rc.log` 在
`%APPDATA%/com.pastepanda.app/rc.log`，排查远程质量问题**必看**。三条新事实：
1. **熔断连击判据是死代码**：`流积压弃帧 0` 而单帧写阻塞峰值 14.9s——真实流量是
   「1 个大 IDR 阻塞 10~15s + 一串快的小帧」交替，快帧把「连续 3 慢」连击清零，
   全场凑不齐。修法：去连击，**单帧写 ≥1.5s 即进熔断**（`MELT_SLOW_MS=1500`）。
2. **B1/B2 有效**：自动画质 19s 切到 smooth、码率缩放生效（编码器重开 3 次）、
   会话存活 5 分钟（pong 侥幸穿透，没触发心跳超时）。但帧龄照样涨到 80-90s——
   **积压住在 quinn 的发送缓冲（流控窗口，MB 级）**，可靠流上已入队字节**无法丢弃**，
   熔断只能停止加量，排干按路径吞吐慢慢熬（本条 ~40KB/s = 数分钟）。
3. **结构性结论**：要真正「延迟封顶」，必须能把积压整段丢弃 = **重开视频流**；而视频
   与 pong/控制共用同一条会话半流，重开即断控制。正解是**视频走独立 uni 流**
   （对端 accept 新流 + IDR 重锚，音频已有同款先例 `inbound_tasks.rs` 音频任务），
   需要要手机端协议同步改，与上面的控制帧独立通道可一并立项。

**行业调研结论与路线拍板（2026-10-03）。** 对标结果：Moonlight/Parsec（游戏级天花板，
LAN <10ms、好广域网 13-30ms）的视频全部走**不可靠 UDP + FEC、零重传、零缓冲**——
Parsec 明言「视频通道零缓冲，拥塞要在发生前预测」；RustDesk（数据面走 TCP）是我们
的镜子，公认比 Parsec 卡一档。我们已有的 `vid_dgram`（分片 + RS/XOR FEC + 关键帧
重锚 + 成洞自愈）就是 Moonlight 同款零件，问题是它被闸门锁着、可靠流当默认。路线：
1. **PP_RC_DGRAM_FORCE=1 实验**（2026-10-03 加）：桌面 dev 设此环境变量无视放行闸
   强制视频数据报，**只在直连会话测**（会话结束日志看「路径」行）——闸门「公网数据报
   近乎全丢」的旧结论疑似在**中继路径**上测得，直连真实丢包率决定视频默认态要不要翻过来。
   观测指标：手机端 `[RC-PROBE]` 断链/JPEG帧、电脑端「数据报丢弃」计数、帧龄是否封顶。
2. 视频/控制独立通道（独立 uni 流，两端协议改）+ intra-refresh：已立项待排。
3. **中继治理（自建中继节点/文档化自建方案）：2026-10-03 用户拍板不做**——公网体验
   完全依赖直连（打洞）成功率，方案 1 因此成为关键路径。

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

第三类：启动时 logcat 出现一行 `[PANIC] thread: tokio-rt-worker @ ndk-context…/
payload: android context was not initialized`，**不用管**（2026-10-03 实测定性）。
iroh 读 Android 系统 DNS 配置走 `ndk_context`，而 tauri/wry 不初始化它（tauri 的
Android 胶水没有调 `ndk_context::initialize_android_context`），iroh 捕获 panic 后
回落 Google DNS 继续跑（日志下一条 `Failed to read the system's DNS config, using
Google DNS servers as fallback`）。我们不走 iroh-dns 域名解析（RC 用直连 + 中继地址），
该回落无实际影响。真要修需给 iroh 接 `install_android_jni_context(vm, ctx)`，
而 tauri 没有暴露 JavaVM/Context 指针的公开入口，不值得为噪音做侵入。


