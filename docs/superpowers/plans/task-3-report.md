# Task 3 报告：颜色值拾取预览 — 卡片色块渲染

## 概述

按 `docs/superpowers/plans/2026-07-19-color-preview.md` 中 "Task 3: Card swatch rendering" 一节的要求，对 `src/components/Card.tsx` 的 `Card`（纯展示组件，非 `CardWithContext`）做了 3 处代码修改，并在 `src/components/CardList.module.css` 中新增了 2 条 CSS 规则。未触碰 Task 4 涉及的 `CardWithContext`/`ContextMenu.tsx`。

## 修改 1：新增 import（Card.tsx 顶部）

```diff
 import { relativeTime, detectTextType } from "@/lib/utils";
+import { detectColor } from "@/lib/color";
+import type { CSSProperties } from "react";
 import SourceBadge from "@/components/SourceBadge";
```

## 修改 2：计算 parsedColor（Card 组件内部，约第 78 行）

```diff
   const subType = item.type === "text" ? detectTextType(item.text) : item.type;
+  const parsedColor = subType === "color" ? detectColor(item.text || "") : null;
   const cfg = ICONS[subType] || ICONS.text;
```

确认：这是 `export const Card = memo(function Card({...` 内部的 `subType`，不是 `CardWithContext` 组件后段（`handlePasteTransform` 附近）单独计算的那个同名局部变量。

## 修改 3：图标渲染 JSX 新增颜色分支（Card 组件 return 内，约第 220-240 行）

```diff
           )
+        ) : parsedColor ? (
+          <div
+            className={`${styles.cardIcon} ${styles.colorIcon}`}
+            style={{
+              "--swatch-color": item.text.trim(),
+              "--swatch-bg": `rgba(${parsedColor.r}, ${parsedColor.g}, ${parsedColor.b}, 0.12)`,
+              "--swatch-border": `rgba(${parsedColor.r}, ${parsedColor.g}, ${parsedColor.b}, 0.22)`,
+              "--swatch-inset": `rgba(${parsedColor.r}, ${parsedColor.g}, ${parsedColor.b}, 0.1)`,
+            } as CSSProperties}
+          >
+            <div className={styles.colorDot} />
+          </div>
         ) : (
           <div className={`${styles.cardIcon} ${iconBg}`}>
             <Icon size={18} color={iconColor} strokeWidth={2.2} />
           </div>
         )}
```

分支顺序为：`item.type === "image" ? (...多个图片状态...) : parsedColor ? (颜色色块) : (原有 lucide 图标 fallback)`。仅当 `parsedColor` 真值时才走新分支，非颜色文本项和图片项完全走原有逻辑，未受影响。

## 修改 4：CSS 新增（CardList.module.css，紧跟 `.bgPurple` 规则之后）

```diff
 .bgPurple { background: rgba(139, 92, 246, 0.12);  border-color: rgba(139, 92, 246, 0.22);  box-shadow: inset 0 2px 4px rgba(139, 92, 246, 0.1), 0 2px 8px rgba(0,0,0,0.15); }

+/* 颜色值拾取预览 (#10) — 图标底色/边框/内阴影用当前颜色本身的低透明度，而非固定色系 */
+.colorIcon {
+  background: var(--swatch-bg);
+  border-color: var(--swatch-border);
+  box-shadow: inset 0 2px 4px var(--swatch-inset), 0 2px 8px rgba(0,0,0,0.15);
+}
+.colorDot {
+  width: 22px;
+  height: 22px;
+  border-radius: 50%;
+  background: var(--swatch-color);
+  box-shadow: 0 0 0 2px rgba(255,255,255,0.55), inset 0 0 0 1px rgba(0,0,0,0.08);
+}

 /* 图片缩略图 */
 .cardImgThumb {
```

CSS 变量名（`--swatch-bg`/`--swatch-border`/`--swatch-inset`/`--swatch-color`）与 JSX 内联 style 中设置的名称完全一致。

## 验证结果

### `npx tsc --noEmit`
退出码 0，无任何输出（无类型错误）。`as CSSProperties` 类型断言按计划精确应用，未做结构性调整。

### `npx vitest run`（全量测试）
```
Test Files  11 passed (11)
     Tests  205 passed (205)
  Duration  21.28s
```
全部 11 个测试文件、205 个用例通过，无回归（本任务未新增测试，仅涉及渲染/CSS 改动，未被现有测试覆盖，因此测试数量与改动前一致）。

## 自查（Self-review）

- JSX 改动确认落在 `Card` 组件内（return 语句内的图标渲染分支），未触碰 `CardWithContext` 组件及其独立的 `subType`/`handlePasteTransform` 逻辑（Task 4 范畴）。
- 新分支仅在 `parsedColor` 为真值时命中；`parsedColor` 为 `null` 时（图片项、非颜色文本项、其他普通文本）会正确落入原有的 `iconBg`/`Icon` fallback 分支，行为与改动前完全一致。
- CSS 新增位置、变量命名均与计划一致。

## Git 提交

- Commit hash: `5180ce2`
- 提交信息：`feat: 卡片列表新增颜色值色块预览`（含 Task 3/4 说明与 Co-Authored-By 尾行）
- 提交范围：仅 `src/components/Card.tsx` 与 `src/components/CardList.module.css`（2 files changed, 29 insertions(+)）
- 临时提交信息文件 `.git\COMMIT_MSG_TASK3.txt` 已在提交后删除。

## 遗留事项 / 需人工确认

**尚未做可视化验证。** 本次工作全程通过 cc-bridge 在远程 Windows 主机上进行文件读写与命令执行，没有条件启动 `npm run tauri dev` 并截图查看实际渲染效果，因此**没有**也**不能**声称已经用肉眼确认色块渲染符合 `design/color-preview.html` 设计稿。建议后续由人工：
1. 运行 `npm run tauri dev`；
2. 复制 `#FF5733`、`rgba(59, 130, 246, 0.5)`、`hsl(160, 84%, 39%)` 到剪贴板，确认卡片图标位置出现对应实心圆色块（而非默认 lucide 图标）；
3. 复制一段普通代码/文本，确认其图标未受影响；
4. 对照 `design/color-preview.html` 的视觉稿核对间距、圆角、阴影等细节。

除上述"未做可视化验证"这一点外，本任务未发现其他需要关注的问题；tsc 与全量测试均通过。
