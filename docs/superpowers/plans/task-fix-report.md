# 颜色值拾取预览 — 最终评审两处修复报告

提交: `6a4bca3` (`fix: 颜色值补充格式徽标(HEX/RGB/HSL) + 修正 alpha 输出精度`)

## Fix 1: HEX/RGB/HSL 格式徽标

### `src/lib/color.ts`
- `ParsedColor` 接口新增 `format: "hex" | "rgb" | "hsl"` 字段。
- `parseHex` 返回值补 `format: "hex"`。
- `parseRgb` 返回值补 `format: "rgb"`。
- `parseHsl` 返回值补 `format: "hsl"`。

```diff
 export interface ParsedColor {
   r: number;
   g: number;
   b: number;
   a: number;
+  format: "hex" | "rgb" | "hsl";
 }
...
-  return { r, g, b, a };
+  return { r, g, b, a, format: "hex" };   // parseHex
...
-  return { r, g, b, a };
+  return { r, g, b, a, format: "rgb" };   // parseRgb
...
-  return { r, g, b, a };
+  return { r, g, b, a, format: "hsl" };   // parseHsl
```

### `src/components/Card.tsx`
在 `Card`（纯展示组件）的 `cardSub` 内，`cardPin` 之后、`SourceBadge` 之前新增徽标，仅当 `parsedColor` 存在时渲染：

```diff
             )}
+            {parsedColor && (
+              <span className={styles.colorFormatTag}>{parsedColor.format.toUpperCase()}</span>
+            )}
             {item.source && <SourceBadge source={item.source} sourceIcon={item.source_icon} size="small" />}
```

### `src/components/CardList.module.css`
在 `.colorIcon`/`.colorDot` 规则之后新增 `.colorFormatTag`：

```css
.colorFormatTag {
  display: inline-flex;
  align-items: center;
  height: 15px;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 9.5px;
  font-weight: 700;
  background: var(--accent-light);
  color: var(--accent);
}
```

### `src/__tests__/color.test.ts`
全文检索所有构造/断言 `ParsedColor` 形状字面量的用例，逐一补上 `format`：
- `detects 6-digit hex` → `format: "hex"`
- `detects 3-digit hex and expands it` → `format: "hex"`
- `detects rgb()` → `format: "rgb"`
- `detects rgba() with decimal alpha` → `format: "rgb"`
- `is case-insensitive...`（`RGB(...)` 断言）→ `format: "rgb"`
- `toHex renders opaque...` / `toHex renders alpha suffix...` → `format: "hex"`
- `toRgb renders rgb()...`（两处字面量）→ `format: "rgb"`
- `toHsl renders hsl()...`（两处字面量）→ `format: "hsl"`

其余用例（如 `detects 8-digit hex with alpha`、`detects hsl()`、`detects hsla() with alpha` 等）通过 `result?.r` / `result!.a` 等属性访问断言，不构造完整对象字面量，无需改动。

## Fix 2: alpha 输出精度

`toRgb`/`toHsl` 在插值前先 `Math.round(c.a * 100) / 100` 取整到 2 位小数（`toHex` 已用整数字节转换，无需改动）：

```diff
 export function toRgb(c: ParsedColor): string {
-  return c.a < 1 ? `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})` : `rgb(${c.r}, ${c.g}, ${c.b})`;
+  const a = Math.round(c.a * 100) / 100;
+  return c.a < 1 ? `rgba(${c.r}, ${c.g}, ${c.b}, ${a})` : `rgb(${c.r}, ${c.g}, ${c.b})`;
 }
 
 export function toHsl(c: ParsedColor): string {
   const { h, s, l } = rgbToHsl(c.r, c.g, c.b);
-  return c.a < 1 ? `hsla(${h}, ${s}%, ${l}%, ${c.a})` : `hsl(${h}, ${s}%, ${l}%)`;
+  const a = Math.round(c.a * 100) / 100;
+  return c.a < 1 ? `hsla(${h}, ${s}%, ${l}%, ${a})` : `hsl(${h}, ${s}%, ${l}%)`;
 }
```

新增回归测试（`describe("toHex / toRgb / toHsl", ...)` 块内）：

```ts
it("rounds alpha derived from 8-digit hex to 2 decimal places in toRgb/toHsl", () => {
  const parsed = detectColor("#3B82F680")!;
  expect(toRgb(parsed)).toBe("rgba(59, 130, 246, 0.5)");
  expect(toHsl(parsed)).toBe("hsla(217, 91%, 60%, 0.5)");
});
```

（`#3B82F6` 手工验算 HSL ≈ h=217.2→217, s=91.2%→91, l=59.8%→60，与断言一致。）

## 验证结果

- `npx vitest run src/__tests__/color.test.ts`：**23/23 通过**（原 22 + 新增 1）。
- `npx vitest run`（全量）：**11 个测试文件、206 个用例全部通过**，无回归（stderr 中出现的 ERROR/WARN 日志均为既有错误路径用例的预期日志输出，不代表失败）。
- `npx tsc --noEmit`：退出码 0，无输出，无类型错误。

## 自查清单

- [x] 徽标仅在 `parsedColor` 为真时渲染（`{parsedColor && (...)}` 守卫）。
- [x] CSS 类名 `colorFormatTag` 与 JSX 中 `styles.colorFormatTag` 完全一致。
- [x] `color.test.ts` 中所有 `ParsedColor` 形状的对象字面量已全部检索并补齐 `format`（8 处 `toEqual`/输入字面量），其余基于属性访问的断言无需改动。

## Git

- 暂存文件：`src/lib/color.ts` `src/__tests__/color.test.ts` `src/components/Card.tsx` `src/components/CardList.module.css`（仅这 4 个文件，未触碰仓库中其他未暂存/未跟踪的无关改动，如 `src-tauri/config_backups/*`、`design/*.html` 等）。
- Commit message 通过 `.git/COMMIT_MSG_FIX.txt` 临时文件以 `git commit -F` 提交，提交后已删除该临时文件。
- Commit hash: `6a4bca31a9982a81b0fbd97899b058cdaff7422a`（短哈希 `6a4bca3`）。

## 备注/关注点

- 无。两处修复均已通过目标测试文件、全量测试套件与 tsc 类型检查验证。
- 工作区中存在与本任务无关的其他改动（`src-tauri/config_backups/` 若干增删、`design/*.html`、`docs/*.md` 等未跟踪文件），本次提交未涉及，按要求只提交了任务范围内的 4 个文件。
