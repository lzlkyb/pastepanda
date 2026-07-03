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
启动命令用 `Start-Process` 后台方式，不阻塞终端。改代码支持热更新无需反复重启。

## 7. 方案设计需考虑代码架构
模块化、可维护性、扩展性，遵循项目已有的架构模式。

## 8. 方案设计需考虑性能
内存占用、加载速度、渲染效率、缓存策略。

## 9. 方案设计需考虑用户体验
交互流畅度、反馈及时性、边界状态处理（加载中/空状态/错误）。

---

## 发版流程
当用户说 **"tag"** 或 **"打tag"** 时，自动执行完整发版流程（无需逐步确认）：

1. **递增版本号** — `tauri.conf.json` 中 patch 版本自动 +1（如 5.0.87 → 5.0.88）
2. **git add** — 暂存所有变更文件
3. **生成 commit message** — 根据代码变更自动生成带前缀的 commit（`feat:`/`chg:`/`fix:`），标题 + 空行 + 详细变更列表
4. **git commit** — 提交
5. **git push origin master** — 推送代码
6. **git tag v{version}** — 打轻量标签
7. **git push origin v{version}** — 推送标签触发 GitHub Actions 构建发布

### Commit 前缀规范（影响 Release 自动分类）
| 前缀 | Release 分类 | 示例 |
|------|-------------|------|
| `feat:` | ✨ 新功能 | `feat: 新增暗色模式` |
| `chg:` / `change:` | 🔄 变更 | `chg: 优化版本徽章配色` |
| `fix:` | 🐛 修复 | `fix: 修复托盘图标不显示` |
| `refactor:` | 🔧 重构 | `refactor: 重构存储模块` |
| `docs:` | 📖 文档 | `docs: 更新 README` |
