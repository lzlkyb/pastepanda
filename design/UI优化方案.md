# CSS Module 迁移后 UI 优化方案

> 全面审查日期：2026-07-03 | 版本：v5.0.99

---

## 一、高优先级（影响用户体验/性能明显）

### 1.1 图片详情弹窗：缺少 Esc 键关闭支持

**位置**：`CardList.tsx` 图片详情弹窗

**问题**：所有其他弹窗（QuickPreview、Settings、EditDialog 等）都支持 `Esc` 关闭，但图片详情弹窗只能通过点击关闭按钮或遮罩层关闭。

**方案**：
- 方案 A（推荐）：添加全局 `keydown` 监听，Esc 时调用 `closePreview()`
- 方案 B：将图片预览提取为独立组件，统一弹窗行为

**改动量**：方案 A 约 5 行代码

---

### 1.2 QuickPreview 弹窗：`dialog-footer` 内容与 `code-actions-bar` 重复

**位置**：`QuickPreview.tsx` 第 139-156 行

**问题**：`code-actions-bar` 和 `dialog-footer` 中都显示了 "Space / Esc 关闭 · 可选中文本" 提示，完全重复。

**当前代码**：
```tsx
{/* 操作栏 */}
<div className="code-actions-bar">
  <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Space / Esc 关闭 · 可选中文本</span>
  <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
    <button onClick={handleCopy} className="btn-ghost">复制</button>
    <button onClick={handlePaste} className="btn-ghost">粘贴</button>
  </div>
</div>

{/* Footer */}
<div className="dialog-footer">
  <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Space / Esc 关闭 · 可选中文本</span>
  <span></span>
</div>
```

**方案**：
- 方案 A（推荐）：删除 `dialog-footer`，只保留 `code-actions-bar`
- 方案 B：将提示文字移到 footer，操作按钮移到 header

---

### 1.3 图片详情弹窗：拖拽平移时的体验问题

**位置**：`CardList.tsx` 图片详情 `handlePanStart/Move/End`

**问题**：拖拽时使用了 `transition: "transform 0.2s ease"` 和 `transition: "none"` 切换，但存在以下问题：
1. 拖拽开始时有短暂延迟（transition 未立刻取消）
2. 松开后回弹效果生硬（0.2s ease 不够自然）

**方案**：
- 方案 A（推荐）：拖拽期间全程 `transition: none`，释放后用 `transition: "transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)"`（easeOutQuad）回弹
- 方案 B：引入 framer-motion 的 `drag` 手势替代原生拖拽，获得更流畅的惯性效果

**改动量**：方案 A 约 3 行修改

---

### 1.4 卡片列表：`styles.dialogBox` 不存在问题已修复，但还有类似隐患

**位置**：多个组件

**问题**：CSS Module 迁移后，全局类名和 Module 类名混用，容易出现类似 `styles.dialogBox` 的引用错误。

**方案**：
- 方案 A（推荐）：建立命名规范：弹窗容器统一用全局类 `dialog-box`，内部样式用 CSS Module
- 方案 B：完全 CSS Module 化，在 `app.css` 中标记所有遗留全局类为 deprecated

**改动量**：方案 A 主要是规范约定，无需代码改动

---

## 二、中优先级（体验提升/代码质量）

### 2.1 图片详情弹窗缺少键盘快捷键提示

**位置**：`CardList.tsx` 第 760-787 行（工具栏）

**问题**：图片预览支持滚轮缩放、拖拽平移，但没有任何 UI 提示。用户不知道可以：
- 滚轮缩放
- 拖拽平移
- 双击重置

**方案**：
- 方案 A（推荐）：在工具栏右侧添加淡色提示文字 "🖱 滚轮缩放 · 拖拽平移 · 双击重置"
- 方案 B：首次进入时弹出小 toast 提示（1 次即可，localStorage 记录）

**改动量**：方案 A 约 2 行代码

---

### 2.2 图片缩略图加载失败缺少全局降级处理

**位置**：`CardList.tsx` `imgCache` 逻辑

**问题**：图片缩略图加载失败时，`Card.tsx` 的 `ImgState.error` 状态只显示重试按钮，但没有展示错误原因。大量图片同时加载失败时，界面充斥红色重试图标。

**方案**：
- 方案 A（推荐）：添加错误重试上限（如 2 次），超过后静默显示灰色占位图标
- 方案 B：批量加载失败时显示统一提示 "部分图片加载失败"

---

### 2.3 `app.css` 文件过于臃肿（1115 行），需进一步拆分

**位置**：`src/styles/app.css`

**问题**：当前 `app.css` 仍然包含大量组件样式（dialog、code-viewer、Shiki 高亮、快捷键浮层等），这些应该拆分到各自组件的 Module CSS 中或独立文件中。

**当前结构**：
| 内容 | 行数 | 建议去向 |
|------|------|----------|
| 布局（app-shell, scroll-area） | 9-50 | 保留或迁移到 App.module.css |
| 版本徽章 | 52-126 | 迁移到 VersionBadge.module.css |
| 按钮基础样式 | 173-258 | 迁移到 buttons.css |
| Dialog 通用 | 259-970 | 迁移到 dialog.css 或各组件 Module |
| Shiki 高亮 | 972-1044 | 迁移到 code-theme.css |
| 快捷键浮层 | 1071-1115 | 迁移到 App.module.css |

**方案**：
- 方案 A（推荐）：按功能拆分为 `buttons.css`、`dialog.css`、`code-theme.css`，在 `main.tsx` 中按序导入
- 方案 B：逐步将全局样式迁移到各组件 CSS Module 中（工作量大）

**改动量**：方案 A 约拆分 4 个文件，改动 `main.tsx` 导入顺序

---

### 2.4 设置页主题预览缺少交互反馈

**位置**：`SettingsDialog.tsx` 第 255-288 行

**问题**：主题色块点击后只切换主题，没有动画过渡。主题切换是瞬时的，体验较生硬。

**方案**：
- 方案 A（推荐）：给 `app-shell` 添加 `transition: background-color 0.3s, color 0.3s` 让主题切换有过渡动画
- 方案 B：主题色块选中态添加 scale 动画

**改动量**：方案 A 约 3 行 CSS

---

### 2.5 搜索框空状态缺少提示

**位置**：`TopBar.tsx` 搜索框

**问题**：搜索无结果时，列表区域为空但没有 "未找到相关结果" 提示。

**方案**：
- 方案 A（推荐）：在 CardList 中检测 `searchKeyword && filteredItems.length === 0` 时显示空结果提示
- 方案 B：在搜索框右侧显示匹配数量

---

### 2.6 图片详情弹窗 `dialog-body` 的 `gap: 12` 是 inline style

**位置**：`CardList.tsx` 第 749 行

**问题**：`<div className="dialog-body" style={{ gap: 12 }}>` 使用了 inline style，应该用 CSS Module 类覆盖。

**方案**：在 `CardList.module.css` 中添加 `.imageDetailBody { gap: 12px; }`，然后用 `${styles.imageDetailBody}` 替代 inline style。

**改动量**：2 行 CSS + 1 行 JSX

---

## 三、低优先级（锦上添花）

### 3.1 图片 OCR 选中框动画

**位置**：`CardList.module.css` `.ocrWordBox`

**问题**：OCR 词框 hover 时有 `transition`，但选中态切换时没有过渡动画。

**方案**：给 `.ocrWordBox` 添加 `transition: background 0.15s, border-color 0.15s, transform 0.15s`

---

### 3.2 TopBar 图标按钮统一为 SVG 图标

**位置**：`TopBar.tsx`

**问题**：部分按钮用 emoji（📝、🧲、❓），部分用 SVG。风格不统一。

**方案**：全部改用 `lucide-react` 图标，统一风格

---

### 3.3 卡片 Popover 缺少图片加载状态

**位置**：`CardList.module.css` `.cardPopoverImage`

**问题**：图片类型的 Popover 预览直接显示图片，没有 loading 骨架屏。

**方案**：添加图片加载中的骨架屏动画

---

### 3.4 `dialog-body` 的 `padding: 16px 20px` 在不同弹窗中不一致

**位置**：`app.css` `.dialog-body`

**问题**：SettingsDialog 使用 `style={{ padding: 0, gap: 0 }}` 覆盖，QuickPreview 用 `style={{ gap: 10 }}` 覆盖，CardList 图片详情用 `style={{ gap: 12 }}` 覆盖。

**方案**：将 `dialog-body` 的 padding/gap 设为 CSS 变量，各组件通过 `--dialog-body-gap` 和 `--dialog-body-padding` 覆盖

---

## 总结优先级排序

| # | 优化项 | 优先级 | 预计工时 |
|---|--------|--------|----------|
| 1 | 图片详情 Esc 关闭 | 🔴 高 | 5 分钟 |
| 2 | QuickPreview 重复内容 | 🔴 高 | 3 分钟 |
| 3 | 图片拖拽回弹动画 | 🔴 高 | 5 分钟 |
| 4 | 全局/Module 混用规范 | 🔴 高 | 文档 |
| 5 | 图片详情快捷键提示 | 🟡 中 | 3 分钟 |
| 6 | 图片加载失败降级 | 🟡 中 | 15 分钟 |
| 7 | app.css 拆分 | 🟡 中 | 30 分钟 |
| 8 | 主题切换过渡动画 | 🟡 中 | 5 分钟 |
| 9 | 搜索无结果提示 | 🟡 中 | 10 分钟 |
| 10 | inline style → CSS Module | 🟡 中 | 3 分钟 |
| 11 | OCR 框动画 | 🟢 低 | 3 分钟 |
| 12 | TopBar 图标统一 | 🟢 低 | 15 分钟 |
| 13 | Popover 图片 loading | 🟢 低 | 10 分钟 |
| 14 | dialog-body 变量化 | 🟢 低 | 20 分钟 |

---

## 建议执行顺序

**第一批（今天）**：1 → 2 → 3 → 10（4 项，约 15 分钟）

**第二批（按需）**：5 → 8 → 11 → 9（体验提升）

**第三批（重构）**：4 → 7 → 14 → 12 → 6 → 13
