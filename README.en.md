# PastePanda — Smart Clipboard Manager

> 🚀 A Windows desktop clipboard manager built with Tauri 2. Supports text/image/file history, global hotkey paste, workspace management, LAN sync, and a built-in developer toolbox (codecs, SQL, log analysis, config conversion & more).

**[简体中文](README.md)**

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
  <img src="https://img.shields.io/badge/version-5.4.0-green" alt="Version" />
</p>

---

## 📖 Table of Contents

- [Core Features](#-core-features)
- [Keyboard Shortcuts](#️-keyboard-shortcuts)
- [Screenshots](#️-screenshots)
- [Installation](#-installation)
- [Tech Stack](#️-tech-stack)
- [Project Structure](#️-project-structure)
- [Development](#-development)
- [Contributing](#-contributing)
- [License](#-license)

---

## ✨ Core Features

### Clipboard Management

| Feature | Description |
|---------|-------------|
| 📋 **Clipboard History** | Auto-captures text, images & files — 400ms polling + MD5 dedup |
| 📌 **Paste to Foreground** | Injects text/images into target window via WM_PASTE |
| 🏷️ **Workspaces** | Isolate history per workspace, switch by context |
| 🔍 **Search & Filter** | Pinyin-initial search, type filter, tags, time range |
| 📝 **Snippet Library** | Reusable text templates with usage stats & dynamic variables |
| 🔗 **Info Extraction** | Auto-detects phone numbers, emails, URLs |
| 🔒 **Sensitive Content Guard** | Recognizes keys/credentials patterns, skips recording |

### Efficient Pasting

| Feature | Description |
|---------|-------------|
| ⌨️ **Global Hotkeys** | Show window, sequential paste, index paste — all customizable |
| 📚 **Paste Stack Mode** | Collect multiple clipboard items, then paste one-by-one or all at once |
| 🔤 **Regex Replace** | Apply regex transforms on paste (strip blank lines / URL-decode / mask phone numbers), custom rules persisted in SQLite |
| 🧹 **HTML Strip** | One-click rich-text → plain-text paste |

### Developer Toolbox

| Feature | Description |
|---------|-------------|
| 🔀 **Transform Hub** | Right-click / fullscreen one-click trigger, smart recommendations by content type |
| 🔐 **Codec Suite** | Base64 / URL / Unicode / HTML entity encode & decode, JWT parser, timestamp converter |
| 🗄️ **SQL Tools** | JSON→IN clause, Column→IN, JSON→INSERT, SQL format/minify/uppercase keywords |
| 📊 **Log Statistics** | Level distribution chart, time range, top-5 frequent errors, one-click error extraction |
| 🔄 **Config Convert** | Properties ↔ YAML ↔ JSON conversion, cross-format semantic diff |
| ✏️ **Batch Replace** | Multi-rule parallel apply, regex/literal, live preview |
| 📤 **Export** | Export history to Excel (.xlsx) / CSV / JSON |
| 🧩 **Snippet Variables** | Templates support `{{date}}` `{{clipboard}}` `{{uuid}}` dynamic variables |

### Content Editing & Preview

| Feature | Description |
|---------|-------------|
| 📝 **Markdown Preview** | Real-time GFM rendering, code highlighting, copy as HTML/plain text |
| 🎨 **Color Preview** | Auto-detects color values, swatch display, HEX/RGB/HSL conversion |
| 📊 **CSV Table** | Table/edit dual view, export Markdown/JSON |
| 🔑 **Secret Editor** | Auto-masked display, type detection, 15s timed reveal |
| 🖼️ **Image Editor** | Format conversion (PNG/JPG/WebP), quality compression, free crop |
| 📁 **File Preview** | Image thumbnails, first 20 lines with line numbers, multi-file batch |
| 🔀 **Text Diff** | Select two records for side-by-side diff, line/word mode, synced scroll |
| 📱 **QR Code** | Right-click to generate QR, copy as image or save PNG |
| 🖥️ **Fullscreen Editor** | CodeMirror 6 multi-syntax highlighting, Markdown live preview, line numbers |
| 🔡 **Encoding Convert** | Auto-detect GBK/Big5/Shift_JIS, one-click convert to UTF-8 |

### System & Sync

| Feature | Description |
|---------|-------------|
| 🌐 **LAN Sync** | Sync text/images/files across devices, AES-256-GCM encryption + replay protection |
| 🎨 **4 Themes** | Light / Dark / Azure / Azure Dark |
| ⚙️ **System Integration** | System tray, auto-start on boot, data import/export (JSON) |
| 🔄 **Auto Update** | Multi-source acceleration (GitHub + Gitee mirror), update dialog + categorized changelog |

---

## ⌨️ Keyboard Shortcuts

### Global Hotkeys (customizable in Settings)

| Shortcut | Action |
|----------|--------|
| `Ctrl+Alt+V` | Show/hide window |
| `Ctrl+Alt+Q` | Sequential paste |
| `Ctrl+Alt+1~9` | Index paste (first 9 items) |
| `Ctrl+Alt+K` | Toggle paste stack mode |
| `Ctrl+Alt+P` | Paste from stack top |

### In-Window Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Paste selected item |
| `Ctrl+C` | Copy only (no paste) |
| `Ctrl+F` | Focus search box |
| `Ctrl+A` | Select all |
| `Ctrl+D` | Toggle pin |
| `Ctrl+Z` | Undo delete |
| `Ctrl+S` | Open settings |
| `Space` | Quick preview |
| `Delete` | Delete selected |
| `↑` / `↓` | Navigate up/down |
| `Home` / `End` | Jump to first/last |
| `Escape` | Close dialog / deselect / hide window |
| `?` | Show shortcut help |

---

## 🖥️ Screenshots

| Main Window | Settings |
|-------------|----------|
| ![Main](docs/screenshots/main.png) | ![Settings](docs/screenshots/settings.png) |

| Context Menu | Help |
|--------------|------|
| ![Context Menu](docs/screenshots/context-menu.png) | ![Help](docs/screenshots/help.png) |

---

## 📦 Installation

### Pre-built Binaries

Download the latest `.exe` installer from the [Releases](https://github.com/lzlkyb/pastepanda/releases) page.

### System Requirements

- **OS**: Windows 10/11 (64-bit)
- **Runtime**: No extra dependencies — ships with WebView2

---

## 🛠️ Tech Stack

### Frontend

| Technology | Purpose |
|------------|---------|
| React 19 | UI framework |
| TypeScript | Type safety |
| Vite 7 | Build tool |
| Zustand | State management |
| Radix UI | Accessible UI primitives |
| Framer Motion | Animations |
| Lucide React | Icon library |
| Tailwind CSS 4 | Styling system |

### Backend (Rust)

| Crate | Purpose |
|-------|---------|
| Tauri 2 | Desktop framework |
| rusqlite (bundled) | SQLite database |
| arboard | Clipboard read/write |
| tokio | Async runtime |
| image | Image processing/resize/format conversion |
| windows | Win32 API calls |
| pinyin | Chinese pinyin search |
| encoding_rs + chardetng | Encoding detection & conversion (GBK/Big5 etc.) |
| rust_xlsxwriter | Excel (.xlsx) export |
| csv | CSV parse/export |
| serde_yaml | YAML config parsing (config convert/diff) |

---

## 🏗️ Project Structure

```
├── src/                        # React frontend
│   ├── components/             # UI components
│   │   ├── editors/            # Specialized editors (14)
│   │   │   ├── MarkdownEditor  # Markdown live preview
│   │   │   ├── ImageEditor     # Image crop/format/compress
│   │   │   ├── CsvEditor       # CSV table editor
│   │   │   ├── ColorEditor     # Color preview & conversion
│   │   │   ├── SecretEditor    # Secret masked viewer
│   │   │   ├── JsonEditor      # JSON formatter
│   │   │   └── ...             # Text/Html/Fullscreen etc.
│   │   ├── CardList.tsx        # Card list (core component)
│   │   ├── SettingsDialog.tsx  # Settings dialog
│   │   ├── FileDetailDialog.tsx # File/multi-file detail
│   │   └── ...
│   ├── stores/                 # Zustand state management
│   │   ├── appStore.ts         # Global config & data
│   │   └── dialogStore.ts      # Dialog/editor state
│   ├── lib/                    # Utility modules
│   │   ├── api/                # Tauri invoke wrappers
│   │   ├── transforms/         # Transform registry (codec/SQL/log/text/config)
│   │   ├── color.ts            # Color parsing & conversion
│   │   ├── csv.ts              # CSV parse/export
│   │   ├── imageFormat.ts      # Image format/quality/size
│   │   ├── keyboardActions.ts  # Keyboard event handling
│   │   ├── regexRules.ts       # Regex replace rules (SQLite persisted)
│   │   ├── secret.ts           # Secret detection & masking
│   │   └── ...
│   └── styles/                 # CSS styles + theme variables
├── src-tauri/                  # Rust backend
│   └── src/
│       ├── lib.rs              # Startup logic + command registration
│       ├── clipboard_monitor.rs # Clipboard polling listener
│       ├── paste_engine.rs     # Paste engine (WM_PASTE)
│       ├── hotkey_manager.rs   # Global hotkey management
│       ├── content_classifier.rs # Content type detection (log/JSON/SQL etc.)
│       ├── data_store/         # SQLite data layer (7 modules)
│       ├── commands/           # Tauri Commands (14 modules)
│       ├── tray_manager.rs     # System tray
│       └── lan_sync.rs         # LAN sync (AES-256-GCM)
├── docs/                       # Documentation & screenshots
└── scripts/                    # Build scripts
```

---

## 🔧 Development

### Prerequisites

- **Rust** ≥1.70 ([rustup.rs](https://rustup.rs))
- **Node.js** ≥20 ([nodejs.org](https://nodejs.org))
- **Visual Studio 2022 Build Tools** — "Desktop development with C++" + Windows SDK

### Quick Start

```bash
# Clone the repo
git clone https://github.com/lzlkyb/pastepanda.git
cd pastepanda

# Install dependencies
npm install

# Development mode
npm run tauri dev

# Production build
npm run tauri build

# Run frontend tests
npx vitest run

# Rust type check
cargo check --manifest-path src-tauri/Cargo.toml
```

---

## 🤝 Contributing

Issues and Pull Requests are welcome!

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📄 License

MIT © 2025 PastePanda

---

<p align="center">
  <sub>Made with ❤️ using Tauri + React + Rust</sub>
</p>
