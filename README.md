# PastePanda — 智能剪贴板管理器

> 🚀 一款基于 Tauri 2 的 Windows 桌面剪贴板管理工具，支持文本/图片/文件历史记录、全局热键粘贴、工作区管理、局域网同步，内置编解码/SQL/日志/配置转换等开发者工具箱。

<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" alt="PastePanda Logo" width="128" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=white" alt="Tauri 2" />
  <img src="https://img.shields.io/badge/Rust-1.70+-DEA584?logo=rust&logoColor=white" alt="Rust" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white" alt="React 19" />
  <img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Windows-10%2F11-0078D6?logo=windows&logoColor=white" alt="Windows" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License" />
  <img src="https://img.shields.io/badge/version-5.3.2-green" alt="Version" />
</p>

---

## 📖 目录

- [核心功能](#-核心功能)
- [快捷键速查](#️-快捷键速查)
- [界面预览](#️-界面预览)
- [安装](#-安装)
- [技术栈](#️-技术栈)
- [项目结构](#️-项目结构)
- [开发指南](#-开发指南)
- [贡献](#-贡献)
- [许可证](#-许可证)

---

## ✨ 核心功能

### 剪贴板管理

| 功能 | 说明 |
|------|------|
| 📋 **剪贴板历史** | 自动记录文本、图片、文件，400ms 轮询 + MD5 去重 |
| 📌 **粘贴到前台** | 文本/图片通过 WM_PASTE 消息注入到目标窗口 |
| 🏷️ **工作区管理** | 多工作区隔离历史记录，按场景切换 |
| 🔍 **搜索与筛选** | 拼音首字母搜索、类型筛选、标签分类、时间过滤 |
| 📝 **片段库** | 常用文本模板管理，使用次数统计，支持动态变量插入 |
| 🔗 **信息提取** | 自动识别电话号码、邮箱、URL |
| 🔒 **敏感内容防护** | 密钥/凭证模式自动识别，不记录敏感剪贴板 |

### 高效粘贴

| 功能 | 说明 |
|------|------|
| ⌨️ **全局热键** | 呼出窗口、依次粘贴、索引粘贴，均可自定义 |
| 📚 **粘贴栈模式** | 连续收集多条剪贴板内容，再逐条或全部粘贴 |
| 🔤 **正则替换** | 粘贴时应用正则变换（去空行/URL 解码/手机号脱敏等），自定义规则 SQLite 持久化 |
| 🧹 **HTML 剥离** | 一键将富文本转为纯文本粘贴 |

### 开发者工具箱

| 功能 | 说明 |
|------|------|
| 🔀 **变换枢纽** | 右键/全屏一键触发，按内容类型智能推荐可用变换 |
| 🔐 **编解码工具组** | Base64 / URL / Unicode / HTML 实体编解码，JWT 解析，时间戳互转 |
| 🗄️ **SQL 工具族** | JSON→IN 子句、列→IN、JSON→INSERT、SQL 格式化/压缩/关键字大写 |
| 📊 **日志统计** | 级别分布柱状图、时间范围、高频错误 Top5、一键提取错误行 |
| 🔄 **配置互转** | Properties ↔ YAML ↔ JSON 格式转换，跨格式语义对比（Diff） |
| ✏️ **批量替换** | 多规则并行应用，正则/字面量，实时预览 |
| 📤 **导出** | 历史记录导出为 Excel (.xlsx) / CSV / JSON |
| 🧩 **片段变量** | 片段模板支持 `{{date}}` `{{clipboard}}` `{{uuid}}` 等动态变量 |

### 内容编辑与预览

| 功能 | 说明 |
|------|------|
| 📝 **Markdown 预览** | 实时渲染 GFM 全语法，代码高亮，可复制为 HTML/纯文本 |
| 🎨 **颜色值预览** | 自动识别颜色值，显示色块，支持 HEX/RGB/HSL 互转 |
| 📊 **CSV 表格** | 表格/编辑双视图，导出 Markdown/JSON |
| 🔑 **密钥编辑器** | 自动脱敏显示，类型识别，15 秒限时查看 |
| 🖼️ **图片编辑** | 格式转换（PNG/JPG/WebP）、质量压缩、自由裁剪 |
| 📁 **文件预览** | 图片缩略图、文本前 20 行带行号，多文件批量管理 |
| 🔀 **文本对比** | 多选两条记录进行 Diff 对比，按行/按词，同步滚动 |
| 📱 **二维码生成** | 右键生成 QR 码，支持复制图片或保存 PNG |
| 🖥️ **全屏编辑器** | CodeMirror 6 多语法高亮，Markdown 实时预览，行号显示 |
| 🔡 **编码转换** | 自动检测 GBK/Big5/Shift_JIS 等编码，一键转 UTF-8 |

### 系统与同步

| 功能 | 说明 |
|------|------|
| 🌐 **局域网同步** | 多设备间同步文本/图片/文件，AES-256-GCM 加密 + 重放防护 |
| 🎨 **4 套主题** | 浅色/深色/蔚蓝/蔚蓝深色 |
| ⚙️ **系统集成** | 系统托盘、开机自启、数据导入/导出（JSON） |
| 🔄 **自动更新** | 多源加速（GitHub + Gitee 镜像），版本更新弹框 + 分类日志 |

---

## ⌨️ 快捷键速查

### 全局热键（可在设置中自定义）

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+Alt+V` | 显示/隐藏窗口 |
| `Ctrl+Alt+Q` | 依次粘贴 |
| `Ctrl+Alt+1~9` | 索引粘贴前 9 条 |
| `Ctrl+Alt+K` | 开启/关闭粘贴栈模式 |
| `Ctrl+Alt+P` | 从栈顶粘贴 |

### 窗口内快捷键

| 快捷键 | 功能 |
|--------|------|
| `Enter` | 粘贴选中项 |
| `Ctrl+C` | 仅复制不粘贴 |
| `Ctrl+F` | 聚焦搜索框 |
| `Ctrl+A` | 全选 |
| `Ctrl+D` | 置顶/取消置顶 |
| `Ctrl+Z` | 撤销删除 |
| `Ctrl+S` | 打开设置 |
| `Space` | 快速预览 |
| `Delete` | 删除选中项 |
| `↑` / `↓` | 上下导航 |
| `Home` / `End` | 跳转首/末条 |
| `Escape` | 关闭弹窗 / 取消选择 / 隐藏窗口 |
| `?` | 显示快捷键帮助 |

---

## 🖥️ 界面预览

| 主界面 | 设置 |
|--------|------|
| ![主界面](docs/screenshots/main.png) | ![设置](docs/screenshots/settings.png) |

| 右键菜单 | 帮助 |
|----------|------|
| ![右键菜单](docs/screenshots/context-menu.png) | ![帮助](docs/screenshots/help.png) |

---

## 📦 安装

### 下载预编译版本

前往 [Releases](https://github.com/lzlkyb/pastepanda/releases) 页面下载最新 `.exe` 安装包。

### 系统要求

- **操作系统**: Windows 10/11 (64位)
- **运行时**: 无需额外安装，自带 WebView2

---

## 🛠️ 技术栈

### 前端

| 技术 | 用途 |
|------|------|
| React 19 | UI 框架 |
| TypeScript | 类型安全 |
| Vite 7 | 构建工具 |
| Zustand | 状态管理 |
| Radix UI | 无障碍 UI 组件 |
| Framer Motion | 动画 |
| Lucide React | 图标库 |
| Tailwind CSS 4 | 样式系统 |

### 后端 (Rust)

| 依赖 | 用途 |
|------|------|
| Tauri 2 | 桌面框架 |
| rusqlite (bundled) | SQLite 数据库 |
| arboard | 剪贴板读写 |
| tokio | 异步运行时 |
| image | 图片处理/缩放/格式转换 |
| windows | Win32 API 调用 |
| pinyin | 中文拼音搜索 |
| encoding_rs + chardetng | 编码检测与转换（GBK/Big5 等） |
| rust_xlsxwriter | Excel (.xlsx) 导出 |
| csv | CSV 解析/导出 |
| serde_yaml | YAML 配置解析（配置互转/对比） |

---

## 🏗️ 项目结构

```
├── src/                        # React 前端
│   ├── components/             # UI 组件
│   │   ├── editors/            # 专用编辑器（14 个）
│   │   │   ├── MarkdownEditor  # Markdown 实时预览
│   │   │   ├── ImageEditor     # 图片裁剪/格式转换/压缩
│   │   │   ├── CsvEditor       # CSV 表格编辑
│   │   │   ├── ColorEditor     # 颜色值预览与互转
│   │   │   ├── SecretEditor    # 密钥脱敏查看
│   │   │   ├── JsonEditor      # JSON 格式化
│   │   │   └── ...             # Text/Html/Fullscreen 等
│   │   ├── CardList.tsx        # 卡片列表（核心组件）
│   │   ├── SettingsDialog.tsx  # 设置对话框
│   │   ├── FileDetailDialog.tsx # 文件/多文件详情
│   │   └── ...
│   ├── stores/                 # Zustand 状态管理
│   │   ├── appStore.ts         # 全局配置与数据
│   │   └── dialogStore.ts      # 弹窗/编辑器状态
│   ├── lib/                    # 工具模块
│   │   ├── api/                # Tauri invoke 封装
│   │   ├── transforms/         # 变换注册表（编解码/SQL/日志/文本/配置）
│   │   ├── color.ts            # 颜色解析与转换
│   │   ├── csv.ts              # CSV 解析/导出
│   │   ├── imageFormat.ts      # 图片格式/质量/体积
│   │   ├── keyboardActions.ts  # 键盘事件处理
│   │   ├── regexRules.ts       # 正则替换规则（SQLite 持久化）
│   │   ├── secret.ts           # 密钥识别与脱敏
│   │   └── ...
│   └── styles/                 # CSS 样式 + 主题变量
├── src-tauri/                  # Rust 后端
│   └── src/
│       ├── lib.rs              # 启动逻辑 + 命令注册
│       ├── clipboard_monitor.rs # 剪贴板轮询监听
│       ├── paste_engine.rs     # 粘贴引擎（WM_PASTE）
│       ├── hotkey_manager.rs   # 全局热键管理
│       ├── content_classifier.rs # 内容类型识别（日志/JSON/SQL 等）
│       ├── data_store/         # SQLite 数据层（7 模块）
│       ├── commands/           # Tauri Commands（14 模块）
│       ├── tray_manager.rs     # 系统托盘
│       └── lan_sync.rs         # 局域网同步（AES-256-GCM）
├── docs/                       # 文档与截图
└── scripts/                    # 构建脚本
```

---

## 🔧 开发指南

### 环境要求

- **Rust** ≥1.70 ([rustup.rs](https://rustup.rs))
- **Node.js** ≥20 ([nodejs.org](https://nodejs.org))
- **Visual Studio 2022 Build Tools** — "使用 C++ 的桌面开发" + Windows SDK

### 快速开始

```bash
# 克隆仓库
git clone https://github.com/lzlkyb/pastepanda.git
cd pastepanda

# 安装依赖
npm install

# 开发模式
npm run tauri dev

# 生产构建
npm run tauri build

# 运行前端测试
npx vitest run

# Rust 类型检查
cargo check --manifest-path src-tauri/Cargo.toml
```

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

---

## 📄 许可证

MIT © 2025 PastePanda

---

<p align="center">
  <sub>Made with ❤️ using Tauri + React + Rust</sub>
</p>
