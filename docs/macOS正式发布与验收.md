# macOS 正式发布与验收

更新：2026-10-09。版本仍为 7.2.10。正式发布工具已实现并通过本地脚本回归；尚未生成 Developer ID 签名或公证产物，也未公开发布。

## 真实验收证据

用户重新添加 Universal 调试应用的录屏授权后，完全退出并重开同一个应用，本轮没有重新构建或签名。

- 本机 Apple M4，macOS 27.0.1，单显示器 P275MV PLUS，3840×2160（逻辑 1920×1080）。
- 整屏高清录像开启系统声音、关闭麦克风，控制条实际开始、暂停、继续和停止。暂停在 01:06 时计时保持不变。
- 新文件 `/Users/zhouke/Movies/PastePanda/屏幕录制_2026-10-09_202120.mp4`，58.7 MB，96.688 秒。原有录像保留。
- 压缩数据读取：2708 个视频样本缓冲，194 个音频样本缓冲，全部完成。视频 3840×2160，最后画面时间 96.655 秒、结束 96.688 秒；音轨结束 96.619 秒。读取中的零样本缓冲单独计数，不作为画面或音频样本。
- 生产软件解码路径取得片头、中段 48.344 秒、片尾 96.538 秒三张不同画面。应用内预览显示实际画面和 01:37，无视频轨过短警告。
- 随后完成同一文件的 20.593 秒裁剪（579 个视频缓冲，片头/中/尾画面不同）及 GIF 导出：480×270、248 帧，247 次相邻帧变化、20.66 秒、无限循环。原始录像未修改。
- 麦克风已由用户授权。此前窗口连接问题来自仍运行的旧 ARM 实例；通过应用菜单退出旧实例，并打开精确 Universal 路径后连接恢复。
- 最新真实麦克风录像 `屏幕录制_2026-10-09_233142.mp4`：系统声音关闭、麦克风开启，1920×1080、61.885 秒、27.8 MB。视频尾帧 61.8517 秒、音轨结束 61.9093 秒，全部数据读完，应用预览播放至尾。
- AAC 48 kHz 双声道音频独立解码得到 2,969,536 个样本，峰值 -24.72 dB、RMS -38.69 dB，确认有非静音信号，无 NaN/Inf。用户选择“暂未听音”，因此人声清晰度、实际听感同步及双路混音听感仍未验收。

只读文件诊断：

```sh
xcrun clang -fobjc-arc -Wno-deprecated-declarations -mmacosx-version-min=12.0 \
  src-tauri/src/macos/tests/media_file_probe.m \
  -framework Foundation -framework AVFoundation -framework CoreMedia \
  -o .cache/macos-media-file-probe
.cache/macos-media-file-probe '/absolute/path/to/recording.mp4'
```

该工具仅读取已有文件；没有捕获桌面、播放声音、访问麦克风或修改原录像。

## 发布凭据

本机 `security find-identity -v -p codesigning` 没有有效身份。GitHub Secrets 名称检查发现已有 `TAURI_SIGNING_PRIVATE_KEY`，未发现 Apple 发布凭据；未读取秘密值。

本地构建需要：

| 配置 | 来源 |
|---|---|
| `APPLE_SIGNING_IDENTITY` | Developer ID Application 身份名称或证书 SHA-1 |
| 证书和私钥 | 本机钥匙串，或 `APPLE_CERTIFICATE`（p12 的 Base64）与 `APPLE_CERTIFICATE_PASSWORD` |
| 公证 | `APPLE_API_KEY`、`APPLE_API_ISSUER`、`APPLE_API_KEY_PATH`，或 `APPLE_ID`、`APPLE_PASSWORD`（应用专用密码）、`APPLE_TEAM_ID` |
| 更新签名 | 原有 `TAURI_SIGNING_PRIVATE_KEY`；如加密则提供 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，必须匹配现有配置公钥 |

通过钥匙串、环境变量或 GitHub Secrets 配置。不要将密码、私钥写入源码或聊天，不要换更新公钥来绕过私钥缺失。Apple Developer 账户的协议及系统隐私权限由本人处理。

## 本机正式构建

```sh
npm run macos:release:check
npm run macos:release
npm run macos:release:verify
```

`check` 在缺少凭据时提前失败。`release` 使用 Universal Release 构建与 `tauri.macos.release.conf.json` 覆盖配置，保留原调试包；启用 hardened runtime、麦克风 entitlement 和 Tauri 更新归档，完成应用公证，并单独签名、公证和装订 DMG。版本不自动递增。

产物必须通过：应用深度严格签名校验、Developer ID / TeamIdentifier / hardened runtime、两种架构、版本一致、Gatekeeper、应用与 DMG 的公证票据、DMG 完整性；只读挂载 DMG、解开更新归档，校验内部应用与源应用的可执行文件及 Info.plist 相同。更新归档还须通过现有公钥的 Minisign 验证，包括归档和可信注释；不能用 DMG 代替更新包。

验证通过后才将以下文件写入 `dist/macos-release/`：DMG、`.app.tar.gz`、`.app.tar.gz.sig`、`updater-macos.json`、`SHA256SUMS` 和 `release-evidence.json`。证据包含 Git 提交及工作区状态，不能将存在本地变更的构建描述为精确的提交产物。

脚本结构/配置和签名算法已测试；实际 Developer ID、Apple 服务公证、Gatekeeper、DMG 公证与正式归档完整链仍因凭据缺失未执行。

## GitHub 构建与更新

`.github/workflows/macos-release.yml` 是手动构建流程，只产出 Actions 附件，权限为 `contents: read`。除上述证书和更新签名 Secrets，配置 `APPLE_API_PRIVATE_KEY`（p8 内容）；流程仅在临时目录写入，结束清理。不要把 Apple 私钥放入仓库。

新手动 workflow 通常需先进入默认分支才能在 Actions 中选择执行。本轮不自动合并 master，不打 tag，不改变既有 Windows/Android 发布流程。

正式 Mac 应用检查：`https://github.com/lzlkyb/pastepanda/releases/latest/download/updater-macos.json`。清单同时包含 `darwin-aarch64` 与 `darwin-x86_64`，指向同一个签名 Universal `.app.tar.gz`。维护者确认发布版本后，将审核通过的 Mac 产物与清单上传对应版本 Release；不得覆盖 Windows 的 `updater.json`。缺失清单或未公开发布时不能声称自动更新可用。

本地 12 项回归已覆盖双架构清单、DMG 拒绝、内容篡改、错误密钥、可信注释篡改、版本与架构声明、Windows/HTTPS 镜像兼容、发布凭据条件。另使用真实 Tauri CLI 生成临时测试密钥和签名，验证器接受原件、拒绝篡改；临时密钥已清理，现有应用公钥未更换。没有进行旧版本应用到新版本的真实更新安装；版本仍为 7.2.10。

## 硬件与功能剩余项

`.github/workflows/macos-acceptance.yml` 为 macOS 14 ARM 与 macOS 15 Intel 原生探针及 Rust 回归，开发分支相关变更推送/PR 可触发。首次推送 f44e2a2 的 macOS 14.8.9 ARM 与 macOS 15.7.9 Intel 均完成：各 14 项原生探针、2124 项 Rust 单元及全部集成测试通过。CI 无屏幕/麦克风隐私授权，不能代替 GUI、混合 DPI、多屏或双设备远控验收，也不证明最低支持系统 12/13 已验收。

用户已说明没有第二台电脑、第二块屏幕或 Apple Developer 账号，因此真实多屏、双设备远控、Developer ID / 公证及真实正式更新安装保留未完成；Intel GUI 与 macOS 12/13 也未验收。麦克风采集、保存与非静音音轨已验证，听感确认仍待用户。

用户已选择 AV1 方案 B（FFmpeg + SVT-AV1）。发送链路、双架构依赖打包、独立解码与关键帧恢复、失败回退 H.264 和本地全量回归已实现并验证，见 [Mac AV1 实现与验证](macOS-AV1实现与验证.md)。新的 ARM / Intel AV1 CI 将以当前提交结果为准；既有 CI 的成功不能代替本轮。

## 更新签名私钥兼容检查

`npm run updater:check-key` 仅对固定的临时测试文本使用真实 Tauri CLI 签名，然后用当前应用公钥验证，结束清理；缺少或不匹配的私钥将失败。输出不会包含私钥、密码、签名器错误原文或参数。实际 CLI 临时密钥的正例/错配拒绝已本地验证；提交 0c1124c 的真实 CI 已确认仓库现有私钥匹配当前应用公钥，无需更换更新密钥。

架构回归 workflow 新增独立 `updater-key` 任务，只在本仓库的 push 或手动执行时运行，PR 不读取秘密；Secrets 仅提供给签名检查一步，不提供给原生编译/后端测试。该检查不依赖 Apple 凭据、不输出密钥，也不发布任何文件。

Windows CI 首轮通过编译但有一项既有知识库年龄排序测试失败：同一时钟粒度内创建笔记会出现相同时间戳，从而走标题的次序。测试夹具改为明确且不按插入顺序的日期，产品排序逻辑未改。0c1124c 的 Windows CI 已完成：2200 项单元及全部集成测试通过。

## 第二轮 ARM 与 AV1 配置检查

0c1124c 的 ARM 第二轮有一项既有同步用例失败：报告冲突，但接收库没有副本。源码的严格赢家分支只报告冲突，输家才保存副本；该单向 A→B 用例把调用顺序误当成独立 HLC 版本顺序。测试现已明确设置 A / B 的版本，分别验证严格输、赢，保留副本内容及最终正文；产品同步逻辑未修改。本地 140 项同步测试通过，24b31a1 的后续 ARM、Intel、Windows、前端与更新私钥检查全部通过。此失败记录保留，不用首轮成功覆盖。

独立于编码器选择，已修复共享 AV1 解码配置串对较高 level 错误拼成三位数字的问题，例如 `014M` 改为 `14M`，符合 [AOM 编码参数规范](https://aomediacodec.github.io/av1-isobmff/#codecs-parameter-string)。10 项配置/解码恢复相关测试通过。

本机独立 WKWebView 对有效与旧错误 AV1 配置串的 `VideoDecoder.isConfigSupported` 均返回 false，未成功验收 AV1 播放；这不是 AV1 帧解码测试，也不能代替实际应用或另一台设备的解码验证。方案 B 的发送能力现已在单独的 `PastePanda AV1 Preview.app` 中实现。已授权的原 Universal 应用保持冻结，录屏验收属于该原应用；新包主界面启动已验证，但隐私授权后的录屏及跨设备远控不据此算作通过。
