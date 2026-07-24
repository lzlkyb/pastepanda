# PastePanda 项目开发规则

## 1. 先出方案再动手
修改代码前先出方案让用户确认，至少提供 2-3 个方案对比（含优缺点分析），让用户选择。

## 2. 每次修改更新版本号
在 `src-tauri/tauri.conf.json` 中递增版本号（版本号唯一来源）。同时同步更新 `src-tauri/Cargo.toml` 中的 `version` 字段，保持两处版本号一致。

## 3. 构建 exe 前要询问用户
用户确认后才执行 `npx tauri build`。

## 4. 改动 UI 要先出 HTML 设计稿
涉及 UI 变更时先生成 HTML 预览让用户确认效果。

## 5. 更新版本号后等用户验证确认再提交 git
不要自动提交，等用户说"提交"或"commit"再操作。

## 6. 预览测试用 Tauri dev 后台运行
启动命令（在 clipboard-manager-tauri 目录下执行）：
```powershell
Start-Process powershell -ArgumentList "-NoExit", "-Command", "npx tauri dev" -WindowStyle Minimized
```
通过独立 PowerShell 窗口后台启动，支持 Vite HMR 热更新，不阻塞主终端。改代码支持热更新无需反复重启。

## 7. 方案设计需考虑代码架构
模块化、可维护性、扩展性，遵循项目已有的架构模式。

**组件文件大小限制**（硬性规则）：
- 单个 `.tsx` 组件文件 **禁止超过 300 行**（不含样式和类型定义）。
- 如果功能增长导致文件膨胀，**必须先拆分再继续**，不能无限制堆积。
- 拆分策略：
  - **自定义 Hook**：将复杂状态逻辑、事件处理提取到 `hooks/useXxx.ts`
  - **子组件**：将独立 UI 区块提取到 `components/XxxPanel.tsx` 或 `components/XxxItem.tsx`
  - **工具函数**：将纯计算逻辑提取到 `lib/xxx.ts`
- 当前超标文件（后续逐步重构）：
  - `CardList.tsx`（53KB / ~1300 行）
  - `SettingsDialog.tsx`（57KB / ~1400 行）
  - `Card.tsx`（27KB / ~650 行）
  - `TrayPopup.tsx`（20KB / ~480 行）
- 新增功能时：如果目标文件已接近 300 行，默认创建新文件而非追加代码。

## 8. 方案设计需考虑性能
内存占用、加载速度、渲染效率、缓存策略。

## 9. 方案设计需考虑用户体验
交互流畅度、反馈及时性、边界状态处理（加载中/空状态/错误）。

## 10. 改完代码不需要重启 dev
如果 dev 已在运行，Vite HMR 会自动热更新。直接看效果即可，不要每次改完代码都尝试重新启动 dev。

## 11. 公共工具函数统一放 lib/utils.ts
多个组件共用的纯函数（如 `cleanSourceName`、`getSourceIcon`、`relativeTime`、`truncate`、`detectTextType` 等）**必须**在 `src/lib/utils.ts` 中定义并 `export`，各组件通过 `import { xxx } from "@/lib/utils"` 引用。禁止在组件文件内重复定义相同的工具函数。确保单一数据源，便于统一维护和修改。

## 12. 改动 UI 前必须读取真实组件源码
生成 HTML 设计稿前，必须先读取相关组件的 `.tsx` 和 `.module.css` 源码，设计稿中的样式、结构、图标、文案必须与真实代码一致，不能凭空自创样式。

## 13. 文件存放目录规范
| 文件类型 | 存放目录 |
|---------|---------|
| `.md` 文档 | `clipboard-manager-tauri/docs/` |
| `.html` 设计稿 | `clipboard-manager-tauri/design/`

---

## 14. git push 优先使用 SSH
本机 HTTPS 访问 GitHub 经常超时（系统代理 `127.0.0.1:26561` 不稳定，git 无法走通），但 SSH 方式 (`git@github.com`) 始终可用。

- remote URL 应使用 SSH 格式：`git@github.com:lzlkyb/pastepanda.git`
- 如果 `git push` 报 `Failed to connect` 或 `Connection was reset`，先检查 `git remote get-url origin`，若为 HTTPS 则切换为 SSH：
  ```bash
  git remote set-url origin git@github.com:lzlkyb/pastepanda.git
  ```
- pre-push hook 会跑完整测试（vitest + cargo test），耗时约 3 分钟，push 命令 timeout 需设 ≥300s

---

## 发版流程
当用户说 **"tag"** 或 **"打tag"** 时，自动执行完整发版流程（无需逐步确认）：

1. **递增版本号** — `tauri.conf.json` 中 patch 版本自动 +1（如 5.0.87 → 5.0.88）
2. **更新 CHANGELOG.md** — 扫描上一次 tag 到当前的所有 commit，按前缀分类（feat:/fix:/chg:/refactor:/docs:），在文件顶部插入新版本段落，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)
3. **git add** — 暂存所有变更文件（含 CHANGELOG.md）
4. **生成 commit message** — 根据代码变更自动生成带前缀的 commit（`feat:`/`chg:`/`fix:`），标题 + 空行 + 详细变更列表
5. **git commit** — 提交
6. **git push origin master** — 推送代码
7. **git tag v{version}** — 打轻量标签
8. **git push origin v{version}** — 推送标签触发 GitHub Actions 构建发布

> **Release 更新日志来源**：CI release.yml 会优先从 `CHANGELOG.md` 提取当前版本的段落作为 Release body。如果文件不存在或找不到对应版本，则自动回退到 git log 模式。这样即使几个版本才发一次 tag，Release 也能展示完整的累积变更记录。

### Commit 前缀规范（影响 Release 自动分类）
| 前缀 | Release 分类 | 示例 |
|------|-------------|------|
| `feat:` | ✨ 新功能 | `feat: 新增暗色模式` |
| `chg:` / `change:` | 🔄 变更 | `chg: 优化版本徽章配色` |
| `fix:` | 🐛 修复 | `fix: 修复托盘图标不显示` |
| `refactor:` | 🔧 重构 | `refactor: 重构存储模块` |
| `docs:` | 📖 文档 | `docs: 更新 README` |
