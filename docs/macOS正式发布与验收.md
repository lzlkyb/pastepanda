# macOS 正式发布与验收

更新：2026-10-09。版本仍为 7.2.10。正式发布工具已实现并通过本地脚本回归；尚未生成 Developer ID 签名或公证产物，也未公开发布。

## 真实验收证据

用户重新添加 Universal 调试应用的录屏授权后，完全退出并重开同一个应用，本轮没有重新构建或签名。

- 本机 Apple M4，macOS 27.0.1，单显示器 P275MV PLUS，3840×2160（逻辑 1920×1080）。
- 整屏高清录像开启系统声音、关闭麦克风，控制条实际开始、暂停、继续和停止。暂停在 01:06 时计时保持不变。
- 新文件 `/Users/zhouke/Movies/PastePanda/屏幕录制_2026-10-09_202120.mp4`，58.7 MB，96.688 秒。原有录像保留。
- 压缩数据读取：2708 个视频样本缓冲，194 个音频样本缓冲，全部完成。视频 3840×2160，最后画面时间 96.655 秒、结束 96.688 秒；音轨结束 96.619 秒。读取中的零样本缓冲单独计数，不作为画面或音频样本。
- 生产软件解码路径取得片头、中段 48.344 秒、片尾 96.538 秒三张不同画面。应用内预览显示实际画面和 01:37，无视频轨过短警告。
- 本轮没有完成新录像裁剪、GIF 导出、播放至尾的桌面回归。快速拖动后选区仍为整段；关闭预览后工具反复返回窗口连接超时。不能据此断定应用崩溃，也不能把历史裁剪/GIF 成功记录算成本轮成功。
- 音轨可读不代表声音质量或音画同步通过；没有录取真实麦克风，也没有听音验收。

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

`.github/workflows/macos-acceptance.yml` 为 macOS 14 ARM 与 macOS 15 Intel 原生探针及 Rust 回归，开发分支相关变更推送/PR 可触发。首次推送 f44e2a2 的 macOS 14.8.9 ARM 已完成：14 项原生探针、2124 项 Rust 单元及全部集成测试通过；Intel 任务仍在运行。CI 无屏幕/麦克风隐私授权，不能代替 GUI、混合 DPI、多屏或双设备远控验收，也不证明最低支持系统 12/13 已验收。

真实多屏、第二设备远控、麦克风音质/同步、Intel GUI 与 macOS 12/13 仍待对应硬件与授权。AV1 原生发送仍未实现；已向用户提出 Rust rav1e 与 FFmpeg + SVT-AV1 两种实现方案，按 AGENTS.md 规则 1 等待架构选择，不能未经选择添加这类依赖。

## 更新签名私钥兼容检查

`npm run updater:check-key` 仅对固定的临时测试文本使用真实 Tauri CLI 签名，然后用当前应用公钥验证，结束清理；缺少或不匹配的私钥将失败。输出不会包含私钥、密码、签名器错误原文或参数。实际 CLI 临时密钥的正例/错配拒绝已本地验证，仓库现有 Secrets 的真实匹配结果仍待 CI。

架构回归 workflow 新增独立 `updater-key` 任务，只在本仓库的 push 或手动执行时运行，PR 不读取秘密；Secrets 仅提供给签名检查一步，不提供给原生编译/后端测试。该检查不依赖 Apple 凭据、不输出密钥，也不发布任何文件。

Windows CI 首轮通过编译但有一项既有知识库年龄排序测试失败：同一时钟粒度内创建笔记会出现相同时间戳，从而走标题的次序。测试夹具已改为明确且不按插入顺序的日期，产品排序逻辑未改。新夹具的本地定向回归通过，Windows 结果待后续 CI。
