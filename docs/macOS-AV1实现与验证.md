# Mac AV1 软件发送（方案 B）

用户于 2026-10-09 确认使用 FFmpeg + SVT-AV1。版本保持 7.2.10。

## 实现边界

AV1 仅在会话显式选择时启用，档位的既有 HEVC 偏好保持优先。发送端使用会话独占的 FFmpeg/SVT-AV1 编码器，将 RGBA 转为 BT.709 / 8-bit / 4:2:0 的 low-overhead OBU 包，复用媒体通道、关键帧请求及解码失败降级。没有启动外部 FFmpeg 进程，也没有 shell 或设备访问。

软件模式限制为最大 1920×1080、30fps，采集和输入提帧也遵守该帧率上限，避免用 60/165fps 的原生档位持续灌入软件编码队列。多屏仍遵循统一主屏像素密度。每包最大 8 MiB，未完成编码的输入最多八帧；超过上限即失败并回落 H.264，而非继续积累。参数变化重建会话；暂停/隐藏/退出释放编码器和采集。第一次失败后，本次 AV1 会话使用 H.264，不每帧反复初始化失败的编码器。

库缺失、ABI 不兼容或初始化失败时不声明 AV1 发送能力。此处的能力是可用编码器，而不是 AV1 硬件编码器；Windows 既有硬编路径保持不变。接收端仍需要自己的 AV1 解码能力，本机独立 WKWebView 配置查询不支持，不能将发送实现等同于 Mac AV1 接收已验收。

编码类型通过 `video_params::wire_codec_label` 收口，流头与逐帧元数据都使用 h264/hevc/av1/jpeg 家族标记。Mac `avc1…` / `hev1…` 参数串不能直接用作线协议编码家族；原有 HEVC 被接收端误判 H.264 的问题在此一起修复。

## 构建与打包

```sh
npm ci
# 构建工具需要 CMake、NASM（Intel 或 Universal），以及 Xcode 命令行工具。
npm run macos:av1:build
npm run macos:av1:test
```

`scripts/macos-av1-sources.json` 固定上游源码版本、URL 与 SHA-256。FFmpeg 还使用固定公钥指纹与随仓库保存的分离签名验证；源码篡改或非固定公钥将被拒绝。下载、SVT/FFmpeg 构建与最终 Universal dylib 均位于 `.cache`，不提交二进制。两种架构的 SVT 输出和 FFmpeg 构建目录独立，每个静态库与最终 dylib 都检查架构，禁止从另一架构输出目录误复制。

`macos:dev` / `macos:build` 在 Tauri 编译前准备匹配目标架构的库。Universal 包包含同一个双架构 `Contents/Frameworks/libpastepanda_av1.dylib`；Tauri 将它作为嵌套代码签名。Release 不使用开发机路径或系统 PATH 寻找替代库。调试版仅在直接 cargo/dev 执行且没有应用包时允许项目缓存路径。

FFmpeg/SVT 静态库组合到独立、可替换的 dylib，应用自身不静态链接这些库。构建禁用 GPL、网络、外部程序及无关编解码器。许可证、SVT 专利说明、准确版本源码归档和桥接源码随包保留在 `Contents/Resources/licenses/av1`。构建后的来源 SHA 是签名前缓存库的 SHA；正式签名会改变最终文件，正式产物另以整体签名和最终校验和核验。

依据：[FFmpeg SVT 包装器文档](https://ffmpeg.org/ffmpeg-codecs.html#libsvtav1)、[FFmpeg 发布与签名](https://ffmpeg.org/download.html)、[FFmpeg 许可说明](https://ffmpeg.org/legal.html)、[SVT 参数](https://gitlab.com/AOMediaCodec/SVT-AV1/-/blob/v4.2.0/Docs/Parameters.md)。

## 验证范围

`macos:av1:test` 使用自有合成像素检查实际编码、首包关键帧、强制关键帧、时间戳次序及尺寸边界，分别覆盖 64×64、1280×720、1920×1080。输出的调用耗时包含转换与提交/取包，不等于真实抓屏 FPS。

提供 `PASTEPANDA_AV1_DECODER=/absolute/path/to/ffmpeg` 时，还用独立的 libaom 软件解码器读取所有输出帧并检查画面变化。诊断解码工具不随应用打包。`PASTEPANDA_TEST_AV1=1 cargo test … macos::av1::tests` 显式启用生产 Rust 包装器测试；未设置时不将缺库机器上的普通测试算作实际 AV1 验收。

GitHub 架构 CI 为 ARM / Intel 分别构建与解码合成数据。它不能代替两台电脑的实际连接、输入、网络丢包恢复与端到端延迟。本轮用户没有第二台电脑或第二块屏幕，这两项保留为未验收；用户也没有 Apple Developer 账号，因此不生成或声称 Developer ID / 公证发行包。

## 2026-10-09 实际验证结果

- Universal dylib 与应用均含 arm64/x86_64；库仅依赖系统 libSystem，签名严格校验通过。准确源码、许可、公钥/分离签名和重建说明随包携带。
- 三种尺寸各编码 30 包、两个关键帧；独立 libaom 解码全部 30 张变化画面，并从 510 ms 强制关键帧用全新解码器恢复 15 帧。
- 本机 M4 合成输入：720p 平均调用 7.16 ms、最大 16.09 ms、峰值 RSS 46.9 MiB；1080p 平均 11.83 ms、最大 27.07 ms、86.1 MiB。包含转换/提交/取包，不能用于宣称真实抓屏或端到端 30fps。
- Intel 库通过 Rosetta 实际编码 720p，独立解码通过；这不代替真实 Intel 硬件或 GUI 验收。
- 生产 Rust 包装器以及 AV1 初始化失败后使用真实 VideoToolbox H.264 的回退测试通过。完整本地 Rust 2129 项通过、13 项忽略，活动集成测试 13/26/8/1 项通过；14 组原生探针通过。前端本轮初次全量 4085 项通过，另新增构建产物路径的 4 项测试通过，推送前检查会重新跑完整集合。
- AV1 Preview 双架构应用主界面已实际加载。它是 ad hoc 调试包，未公证，也未据此声称新包已获得系统录屏权限。旧授权 Universal 包保持原签名。
- 本轮新的 GitHub ARM / Intel / Windows / 前端回归结果以推送后对应提交为准，历史成功不替代本轮。
