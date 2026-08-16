# PastePanda OCR 引擎替换说明

> 本文记录将剪贴板管理器的图片 OCR 从「Windows 系统自带 OCR」替换为「PP-OCRv6 纯 Rust 引擎」的全过程、集成方式、构建与打包注意点、以及识别率评估结论。

## 1. 背景与动机

原实现使用 **Windows 系统自带 OCR**（`Windows.Media.OCR`，见旧版 `src-tauri/src/commands/images.rs` 的 `ocr_winrt_from_file`）。该引擎本是 Windows 通用组件，对中文、复杂排版、截图噪点、手写体的识别偏弱，且存在 `\\?\` 设备路径前缀导致的识别失败 bug。

核心约束（产品要求）：**引擎与模型必须打进安装包，不依赖任何外部进程 / Python / 服务**——排除 Umi-OCR、PaddleOCR 本地服务等方案。

## 2. 选型结论

最终选用 **PP-OCRv6（small 档）+ `ocr_rs` crate（zibo-chen 版，v2.4.1，Apache-2.0）**：

- **纯 Rust + MNN 推理后端**：MNN 运行时随二进制编译，**不需要任何外部进程 / Python / 系统库**；
- 模型既可放 `resources/` 读文件路径，也能 `include_bytes!` 编进 exe，实现真正单文件发布；
- 返回每个文本框的 **bbox + 置信度**，正好对应既有 `OcrResult` 结构；
- 最新活跃（2026-08）、已修 Windows GNU/MSVC 静态链接，对 Tauri/Windows 项目友好；
- 商用友好（Apache-2.0）。

`ocr_rs` 默认从其维护者的 `MNN-Prebuilds` 仓库下载**预编译 MNN**（构建期自动完成，不需要本地从源码编译 MNN）。

## 3. 集成改动

| 文件 | 改动 |
|---|---|
| `src-tauri/Cargo.toml` | 新增 `ocr-rs = "2.4.1"`；移除 6 个仅 OCR 用的 Windows feature：`Media_Ocr` / `Graphics_Imaging` / `Storage` / `Storage_Streams` / `Foundation_Collections` / `Globalization`。OCR 不再是 Windows 专属，变为**跨平台** |
| `src-tauri/src/commands/images.rs` | 删除 `ocr_winrt_from_file` / `preprocess_ocr_image` / `strip_verbatim_prefix` 及 WinRT `#[cfg]` 桩，替换为 `ocr_recognize`（PP-OCRv6 引擎，全局 `OnceLock<Mutex<>>` 缓存模型）；两个入口 `ocr_image`（坐标）、`ocr_image_cached`（全文）原样保留 |
| `src-tauri/tauri.conf.json` | `bundle.resources` 加入 `resources/ocr_models/*`，安装包自动随附模型 |
| `src-tauri/resources/ocr_models/` | 放置模型三件套（见下） |

**框选行为变化（重要取舍）**：Windows OCR 输出**词级**坐标（一行多词框）；PP-OCRv6 检测输出为**行级**（一个结果 = 一行整框）。映射后，每个结果 = 一行、内含一个整行级 `OcrWordInfo`，框选高亮变为「整行高亮」，截图复制文字完全可用。若需「单词级」框选，需额外分词，属后续增强。

## 4. 模型随包发布与档位

模型三件套：`PP-OCRv6_{size}_det.mnn` + `PP-OCRv6_{size}_rec.mnn` + `ppocr_keys_v6_{size}.txt`。

| 档位 | 模型体积（MNN FP32） | 识别精度 | 说明 |
|---|---|---|---|
| **tiny** | ≈ 3 MB（det ~0.9 + rec ~2.1 + keys） | 73.5% | 最轻，日常截图够用 |
| **small（当前采用）** | ≈ 15 MB（det 4.97 + rec 10.65 + keys 0.07 MB） | 81.3% | 精度/体积平衡，中文最稳 |
| medium | ≈ 66 MB | 83.2% | 复杂版面/生僻字，性价比低 |

下载源：`https://github.com/zibo-chen/rust-paddle-ocr` 仓库 `next` 分支的 `models/` 目录（raw 直连不稳定时，keys 字典改走 GitHub API base64 下载）。

## 5. 构建说明（关键！）

### 5.1 离线构建（vendoring，推荐）

`ocr_rs` 默认 feature 的 build 脚本每次都会联网从 `zibo-chen/MNN-Prebuilds` 下载预编译 MNN；cargo 给 build 脚本换 `OUT_DIR` 哈希后本地缓存会失效，导致重装/换机/断网时构建失败。

本项目已把 `ocr-rs` **vendoring 进仓库**（`src-tauri/vendor/ocr-rs`），使构建完全离线、可复现：

- `src-tauri/Cargo.toml` 加了 `[patch.crates-io]`，把 `ocr-rs` 指向本地路径，依赖行仍写 `ocr-rs = "2.4.1"`；
- 预编译 MNN（静态 `MNN.lib` + 头文件）放在 `vendor/ocr-rs/3rd_party/prebuilt/mnn-dev-windows-x86_64/`；
- build.rs 会优先读取 `CARGO_MANIFEST_DIR/3rd_party/prebuilt/`，命中即离线走 `Prebuilt` 模式（C++ 封装层强制 `/MT`，与 MNN `/MT` 一致，全链路无 CRT 冲突、零 DLL、自包含）；
- 预编译在 `vendor/` 内（不在 `target/`），**连 `cargo clean` 后构建依然离线**。

> 踩过的坑（供排错）：`mnn-static` feature + 强制 `MNN_LIB_DIR` 会因 `/MT` vs Rust 默认 `/MD` 报 `LNK2038` CRT 冲突；`mnn-dynamic` 缺匹配的 `MNN.dll`（上游只发 lib+头）。vendoring 是唯一稳路。
> 预编译（约 170MB）已写进 `.gitignore`（`vendor/ocr-rs/3rd_party/`），crate 源码入库。

### 5.2 构建期依赖：libclang

`ocr_rs` build 脚本调用 `bindgen` 生成 FFI，因此**开发机编译期需要 `libclang`（LLVM）**：

- 安装：`pip install libclang`（拿到 `libclang.dll`），或系统装 LLVM；
- 编译前设置 `LIBCLANG_PATH` 指向含 `libclang.dll` 的目录，并把它加入 `PATH`；
- **这只是构建期依赖**——最终发布的 `.exe` 仍完全自包含，用户运行无需任何外部库。

### 5.3 Release 体积优化

`src-tauri/Cargo.toml` 的 `[profile.release]` 已开：

```toml
[profile.release]
codegen-units = 1
lto = "fat"
opt-level = "z"
strip = "symbols"
panic = "abort"
```

相比最初 `lto="thin" / opt-level="s"`，exe 进一步缩小（实测 38MB → 26MB）。`panic="abort"` 去掉栈展开逻辑，零精度风险。

## 6. 打包结果（实测）

| 产物 | 大小 |
|---|---|
| nsis 安装包 `PastePanda_6.17.1_x64-setup.exe` | **20 MB** |
| 安装后主程序 `PastePanda.exe`（release） | **26 MB** |
| 随附 OCR 模型（small 三件套） | ≈ 15 MB |
| 安装后总占用 | **≈ 41 MB** |

体积对比（相对最初 38MB exe 版）：安装包 21.8 MB → **20 MB**；安装后总占用 ~53 MB → **~41 MB**，省约 **12 MB**。

> 打包命令：`npm run tauri build`（先前端 vite build，再 Rust 离线编译，最后 `makensis` 出 nsis）。打包末尾若出现 `TAURI_SIGNING_PRIVATE_KEY` 未设置警告，仅影响自动更新（updater）签名产物，**不影响安装包本身**。

## 7. 识别率评估

### 7.1 small vs 旧 Windows OCR（45 张数据库真实截图）

从 `clipboard.db` 提取 45 张真实剪贴板历史截图（`history` 表 `type='image'`），其中 28 张有旧 OCR 缓存可对比：

- **新引擎（small）**：成功识别 **45/45（100%）**，0 张空识别；文本流畅、无字间空格，能准确识别版本号/按钮文字/中文句子；
- **旧引擎（Windows OCR）**：27/28 文本含「汉字间空格」错乱，2/28 因 `\\?\` 路径 bug 直接 OCR 失败；大量错字（如「粘贴」→「粘 貼」、「连续」→「连 续 隼 多 条 内 谷」）。

### 7.2 体积-准确率权衡（tiny / small / 旧 三方）

对同一批 45 张数据库真实截图，在 small（已采用）之外补跑了 **tiny 档**（PP-OCRv6 tiny 三件套，未随包发布），并与旧 Windows OCR 缓存对比。tiny 仅适合「安装包体积极度敏感 + 截图以简单 UI 为主」的场景，密集文本会明显退化；本项目最终采用 small。

**模型体积（实测文件大小）**

| 档位 | det | rec | keys | 合计 |
|---|---|---|---|---|
| tiny | 0.86 MB | 2.15 MB | 0.026 MB | **≈ 3.04 MB** |
| small（当前采用） | 4.74 MB | 10.16 MB | 0.071 MB | **≈ 15.16 MB** |

tiny 模型约为 small 的 **1/5**。

**三方识别结果（同 45 张图）**

| 引擎 | 成功识别 | 文本连贯性 | 典型毛病 |
|---|---|---|---|
| 旧 Windows OCR | 26/28（2 张路径 bug 失败） | 27/28 含「汉字间空格」错乱 | 「粘贴」→「粘 貼」、整句碎片化 |
| small（PP-OCRv6 small） | **45/45（100%）** | 流畅、无字间空格 | 偶把 UI 图标误识别成字符 |
| tiny（PP-OCRv6 tiny） | **45/45（100%，0 崩溃）** | 简单 UI 够用；**密集文本明显退化** | 部分图丢字/多插乱码 |

**tiny vs small 量化对比**（45 张逐图 difflib 相似度）

- 平均相似度 **0.77**，最低 **0.05**；仅 **2/45** 完全一致，相似度 < 0.85 的有 **22/45**；
- 「内容保留率」= tiny 字数 / small 字数，均值 1.01，但**极差极大**：最低 **0.04**（几乎整段丢失）；
- **1/45 出现灾难性漏识**：`b00fcc…png`（一张密集财务表格）small 完整识别出约 140 字的中文段落，tiny 只吐出「月型 中位R」6 个字符；
- 另有 `adfee0…png` 等数张在开头插入无意义乱码（如「+A生院 口」），整体信噪比低于 small。

**结论与建议**

- **默认仍用 small**：体积增加约 12 MB（安装包 + 解压后），换来密集文本/中文长句的稳定可识别，对本软件（剪贴板里大量文档/表格/聊天截图）收益明确。
- **tiny 仅适合「安装包体积极度敏感 + 截图以简单 UI 为主」的场景**：日常按钮/标题截图基本可用，但遇到密集文字会丢字，不适合作为默认。
- **旧 Windows OCR 不推荐使用**：在中文/复杂排版下基本不可用。
- 若需进一步压体积，tiny 安装包估算约 **12–14 MB**（未重新打包实测，按模型差 ~12 MB 减去 LZMA 压缩后估算）；small 实测 nsis ≈ 21.8 MB（见 §6）。

## 8. 已知限制

- **图标/装饰误识别**：通用 OCR 通病，会把 UI 图标/装饰元素误识别成字符（如 `V D 队列`、`⑦节点`）。非本项目独有；文本主体（中文句子、版号、按钮）准确率明显更高。
- **行级框选**：如上所述，框选为整行高亮，非单词级。

## 9. 后续可优化

- OCR 前加 UI 截图区域分割（只识别文本区），降低图标误识别；
- 若追求更高精度且接受体积，可切换 medium 档（改 `resources/ocr_models/` 文件名即可）；
- **模型 int8 量化**（进一步压模型体积，当前 ~15MB → ~7–8MB）：本机 Windows 工具链暂不支持——`MNNQuant` PTQ 在 Windows 调外部 `MNNQuant.exe`（官方 Windows 包未发布该二进制），且 small 模型本身已是 FP16。如需推进，要么下载 PP-OCRv6 的 ONNX 源 + `MNNConvert --weightQuantBits 8` 转，要么装 WSL/Linux 编译 MNN 工具；量化后须用真实截图复测识别率。
