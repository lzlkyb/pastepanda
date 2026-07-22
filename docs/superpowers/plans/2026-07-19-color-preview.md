# 颜色值拾取预览 (#10) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect clipboard text that is entirely a Hex/RGB/HSL color value, show a live color swatch on its card, and let the user copy it converted to any of the three formats via the existing "粘贴并变换" menu.

**Architecture:** Pure frontend, zero new dependencies. A new `src/lib/color.ts` module owns detection + format conversion as pure functions. `detectTextType` (`src/lib/utils.ts`) gains a `"color"` branch that feeds the existing card-icon/subtype system. `Card.tsx`'s icon-rendering branch special-cases `subType === "color"` to render a live-colored dot instead of a fixed lucide icon. `ContextMenu.tsx`'s `buildTransformMenu` gains a `"color"` branch offering HEX/RGB/HSL conversion, wired to three new cases in `Card.tsx`'s `handlePasteTransform`.

**Tech Stack:** TypeScript, React 19, Vitest, CSS Modules. No new npm packages.

## Global Constraints

- Zero new dependencies (spec requirement).
- Detection triggers ONLY when the entire trimmed text is a color value — never a substring match inside larger text.
- CSS named colors (red, dodgerblue, etc.) are explicitly NOT detected — Hex/RGB/HSL only.
- Format conversion is exposed only via the existing "粘贴并变换" (paste-and-transform) context menu — no new click-to-cycle UI on the swatch itself.
- No changes to the Rust backend, `content_classifier.rs`, or the database — this is purely a frontend classification/display feature.
- Full spec: `docs/颜色值拾取预览方案.md`. Design reference: `design/color-preview.html`.

---

### Task 1: Color detection & conversion module (`src/lib/color.ts`)

**Files:**
- Create: `src/lib/color.ts`
- Test: `src/__tests__/color.test.ts`

**Interfaces:**
- Produces: `ParsedColor { r: number; g: number; b: number; a: number }` (r/g/b ∈ [0,255], a ∈ [0,1]), `detectColor(text: string): ParsedColor | null`, `toHex(c: ParsedColor): string`, `toRgb(c: ParsedColor): string`, `toHsl(c: ParsedColor): string`. These four exports are consumed by Task 2 (`utils.ts`) and Task 3/4 (`Card.tsx`).

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/color.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { detectColor, toHex, toRgb, toHsl } from "@/lib/color";

describe("detectColor", () => {
  it("detects 6-digit hex", () => {
    expect(detectColor("#FF5733")).toEqual({ r: 255, g: 87, b: 51, a: 1 });
  });

  it("detects 3-digit hex and expands it", () => {
    expect(detectColor("#0f0")).toEqual({ r: 0, g: 255, b: 0, a: 1 });
  });

  it("detects 8-digit hex with alpha", () => {
    // ff = alpha 255/255 = 1, 80 = 128/255 ≈ 0.502
    const result = detectColor("#3B82F680");
    expect(result?.r).toBe(59);
    expect(result?.g).toBe(130);
    expect(result?.b).toBe(246);
    expect(result?.a).toBeCloseTo(0.502, 2);
  });

  it("detects 4-digit hex with alpha and expands it", () => {
    const result = detectColor("#0f08");
    expect(result?.r).toBe(0);
    expect(result?.g).toBe(255);
    expect(result?.b).toBe(0);
    expect(result?.a).toBeCloseTo(0.533, 2);
  });

  it("detects rgb()", () => {
    expect(detectColor("rgb(255, 87, 51)")).toEqual({ r: 255, g: 87, b: 51, a: 1 });
  });

  it("detects rgba() with decimal alpha", () => {
    expect(detectColor("rgba(59, 130, 246, 0.5)")).toEqual({ r: 59, g: 130, b: 246, a: 0.5 });
  });

  it("detects hsl()", () => {
    const result = detectColor("hsl(9, 100%, 60%)");
    expect(result).not.toBeNull();
    expect(result!.a).toBe(1);
    // hsl(9,100%,60%) ≈ rgb(255, 89, 51)
    expect(result!.r).toBeGreaterThan(240);
    expect(result!.g).toBeGreaterThan(70);
    expect(result!.g).toBeLessThan(110);
    expect(result!.b).toBeLessThan(70);
  });

  it("detects hsla() with alpha", () => {
    const result = detectColor("hsla(160, 84%, 39%, 0.6)");
    expect(result?.a).toBe(0.6);
  });

  it("is case-insensitive and tolerates internal whitespace", () => {
    expect(detectColor("#FF5733")).toEqual(detectColor("#ff5733"));
    expect(detectColor("RGB( 255 , 87 , 51 )")).toEqual({ r: 255, g: 87, b: 51, a: 1 });
  });

  it("rejects rgb() with out-of-range components", () => {
    expect(detectColor("rgb(300, 0, 0)")).toBeNull();
  });

  it("rejects hsl() with out-of-range percentages", () => {
    expect(detectColor("hsl(0, 150%, 50%)")).toBeNull();
  });

  it("rejects invalid hex length", () => {
    expect(detectColor("#FF57")).toBeNull();
  });

  it("returns null for plain text", () => {
    expect(detectColor("hello world")).toBeNull();
  });

  it("returns null for code containing a color substring", () => {
    expect(detectColor("body { color: #FF5733; }")).toBeNull();
  });

  it("returns null for a bare CSS named color", () => {
    expect(detectColor("red")).toBeNull();
    expect(detectColor("dodgerblue")).toBeNull();
  });

  it("returns null for empty or whitespace-only input", () => {
    expect(detectColor("")).toBeNull();
    expect(detectColor("   ")).toBeNull();
  });
});

describe("toHex / toRgb / toHsl", () => {
  it("toHex renders opaque color without alpha suffix", () => {
    expect(toHex({ r: 255, g: 87, b: 51, a: 1 })).toBe("#ff5733");
  });

  it("toHex renders alpha suffix when a < 1", () => {
    expect(toHex({ r: 59, g: 130, b: 246, a: 0.5 })).toBe("#3b82f680");
  });

  it("toRgb renders rgb() when opaque, rgba() when transparent", () => {
    expect(toRgb({ r: 255, g: 87, b: 51, a: 1 })).toBe("rgb(255, 87, 51)");
    expect(toRgb({ r: 255, g: 87, b: 51, a: 0.5 })).toBe("rgba(255, 87, 51, 0.5)");
  });

  it("toHsl renders hsl() when opaque, hsla() when transparent", () => {
    expect(toHsl({ r: 255, g: 87, b: 51, a: 1 })).toBe("hsl(9, 100%, 60%)");
    expect(toHsl({ r: 255, g: 87, b: 51, a: 0.5 })).toBe("hsla(9, 100%, 60%, 0.5)");
  });

  it("round-trips hex -> parsed -> hex", () => {
    const parsed = detectColor("#3B82F6")!;
    expect(toHex(parsed)).toBe("#3b82f6");
  });

  it("round-trips rgb -> hsl -> rgb within rounding tolerance", () => {
    const parsed = detectColor("rgb(59, 130, 246)")!;
    const hslStr = toHsl(parsed);
    const reparsed = detectColor(hslStr)!;
    expect(Math.abs(reparsed.r - parsed.r)).toBeLessThanOrEqual(2);
    expect(Math.abs(reparsed.g - parsed.g)).toBeLessThanOrEqual(2);
    expect(Math.abs(reparsed.b - parsed.b)).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/color.test.ts`
Expected: FAIL — `Cannot find module '@/lib/color'` (module doesn't exist yet).

- [ ] **Step 3: Implement `src/lib/color.ts`**

```ts
/** 统一的颜色中间表示：RGB(A)，r/g/b ∈ [0,255]，a ∈ [0,1] */
export interface ParsedColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_RE = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0|1|0?\.\d+)\s*)?\)$/i;
const HSL_RE = /^hsla?\(\s*(\d{1,3})\s*,\s*(\d{1,3})%\s*,\s*(\d{1,3})%\s*(?:,\s*(0|1|0?\.\d+)\s*)?\)$/i;

/** 3/4 位 hex 展开为 6/8 位（每个字符重复一次） */
function expandHex(hex: string): string {
  if (hex.length === 3 || hex.length === 4) {
    return hex.split("").map((c) => c + c).join("");
  }
  return hex;
}

function parseHex(text: string): ParsedColor | null {
  const m = HEX_RE.exec(text);
  if (!m) return null;
  const hex = expandHex(m[1].toLowerCase());
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

function parseRgb(text: string): ParsedColor | null {
  const m = RGB_RE.exec(text);
  if (!m) return null;
  const r = Number(m[1]);
  const g = Number(m[2]);
  const b = Number(m[3]);
  if (r > 255 || g > 255 || b > 255) return null;
  const a = m[4] !== undefined ? Number(m[4]) : 1;
  return { r, g, b, a };
}

/** HSL (h: 0-360, s/l: 0-100) -> RGB (0-255) */
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const sNorm = s / 100;
  const lNorm = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sNorm * Math.min(lNorm, 1 - lNorm);
  const f = (n: number) => lNorm - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return {
    r: Math.round(f(0) * 255),
    g: Math.round(f(8) * 255),
    b: Math.round(f(4) * 255),
  };
}

/** RGB (0-255) -> HSL (h: 0-360, s/l: 0-100) */
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rNorm = r / 255, gNorm = g / 255, bNorm = b / 255;
  const max = Math.max(rNorm, gNorm, bNorm);
  const min = Math.min(rNorm, gNorm, bNorm);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rNorm: h = (gNorm - bNorm) / d + (gNorm < bNorm ? 6 : 0); break;
      case gNorm: h = (bNorm - rNorm) / d + 2; break;
      default: h = (rNorm - gNorm) / d + 4; break;
    }
    h /= 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function parseHsl(text: string): ParsedColor | null {
  const m = HSL_RE.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  const s = Number(m[2]);
  const l = Number(m[3]);
  if (h > 360 || s > 100 || l > 100) return null;
  const { r, g, b } = hslToRgb(h, s, l);
  const a = m[4] !== undefined ? Number(m[4]) : 1;
  return { r, g, b, a };
}

/**
 * 检测一段文本是否整体是 Hex/RGB/HSL 颜色值（内部会 trim），
 * 是则返回统一的 RGB(A) 表示，否则返回 null。不识别 CSS 命名颜色。
 */
export function detectColor(text: string): ParsedColor | null {
  const t = text.trim();
  if (!t) return null;
  return parseHex(t) ?? parseRgb(t) ?? parseHsl(t);
}

function toHexByte(n: number): string {
  return Math.round(n).toString(16).padStart(2, "0");
}

export function toHex(c: ParsedColor): string {
  const hex = `#${toHexByte(c.r)}${toHexByte(c.g)}${toHexByte(c.b)}`;
  return c.a < 1 ? `${hex}${toHexByte(Math.round(c.a * 255))}` : hex;
}

export function toRgb(c: ParsedColor): string {
  return c.a < 1 ? `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})` : `rgb(${c.r}, ${c.g}, ${c.b})`;
}

export function toHsl(c: ParsedColor): string {
  const { h, s, l } = rgbToHsl(c.r, c.g, c.b);
  return c.a < 1 ? `hsla(${h}, ${s}%, ${l}%, ${c.a})` : `hsl(${h}, ${s}%, ${l}%)`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/color.test.ts`
Expected: PASS — all tests green (24 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/color.ts src/__tests__/color.test.ts
git commit -m "feat: 新增颜色检测与格式转换纯函数 src/lib/color.ts"
```

---

### Task 2: Wire color detection into `detectTextType`

**Files:**
- Modify: `src/lib/utils.ts` (the `detectTextType` function, currently ending around line 69-70 with the multiline-text check and final `return "text"`)
- Test: `src/__tests__/utils.test.ts` (existing `describe("detectTextType", ...)` block)

**Interfaces:**
- Consumes: `detectColor` from Task 1 (`src/lib/color.ts`).
- Produces: `detectTextType(text)` now returns `"color"` for qualifying input — consumed by Task 3 (`Card.tsx`'s `subType` variable) and Task 4 (`ContextMenu.tsx`'s `buildTransformMenu` `subType` parameter).

- [ ] **Step 1: Write the failing test**

In `src/__tests__/utils.test.ts`, inside the existing `describe("detectTextType", ...)` block, add:

```ts
  it("detects color values", () => {
    expect(detectTextType("#FF5733")).toBe("color");
    expect(detectTextType("rgba(59, 130, 246, 0.5)")).toBe("color");
    expect(detectTextType("hsl(160, 84%, 39%)")).toBe("color");
  });

  it("does not classify a color substring inside a larger snippet as color", () => {
    expect(detectTextType("body { color: #FF5733; }")).not.toBe("color");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/utils.test.ts -t "detects color values"`
Expected: FAIL — `detectTextType("#FF5733")` currently returns `"text"`, not `"color"`.

- [ ] **Step 3: Implement the `detectTextType` change**

In `src/lib/utils.ts`, add the import at the top of the file (alongside the existing `clsx`/`tailwind-merge` imports at the very top):

```ts
import { detectColor } from "./color";
```

Then change the end of `detectTextType` from:

```ts
  // 多行文本
  if (t.includes("\n") && t.split("\n").length > 3) return "text";
  return "text";
}
```

to:

```ts
  // 多行文本
  if (t.includes("\n") && t.split("\n").length > 3) return "text";
  // 颜色值 (Hex/RGB/HSL)
  if (detectColor(t)) return "color";
  return "text";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/utils.test.ts`
Expected: PASS — all tests in the file green, including the 2 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/lib/utils.ts src/__tests__/utils.test.ts
git commit -m "feat: detectTextType 新增颜色值识别分支"
```

---

### Task 3: Card swatch rendering

**Files:**
- Modify: `src/components/Card.tsx` (the `Card` component — imports at top, and the icon-rendering JSX inside `Card`, currently around lines 76 and 195-229)
- Modify: `src/components/CardList.module.css` (add `.colorIcon` / `.colorDot` rules after the existing `.bgPurple` rule)

**Interfaces:**
- Consumes: `detectColor` from Task 1 (`src/lib/color.ts`); `detectTextType` returning `"color"` from Task 2.
- Produces: nothing consumed by later tasks (this is the visible swatch on the card list; Task 4 is independent — it touches the context menu and `handlePasteTransform` in a different component, `CardWithContext`, in the same file).

- [ ] **Step 1: Add the import**

In `src/components/Card.tsx`, change:

```ts
import { relativeTime, detectTextType } from "@/lib/utils";
```

to:

```ts
import { relativeTime, detectTextType } from "@/lib/utils";
import { detectColor } from "@/lib/color";
import type { CSSProperties } from "react";
```

- [ ] **Step 2: Compute the parsed color alongside `subType`**

In the `Card` component (the one starting `export const Card = memo(function Card({...`), find:

```ts
  const subType = item.type === "text" ? detectTextType(item.text) : item.type;
  const cfg = ICONS[subType] || ICONS.text;
```

Change to:

```ts
  const subType = item.type === "text" ? detectTextType(item.text) : item.type;
  const parsedColor = subType === "color" ? detectColor(item.text || "") : null;
  const cfg = ICONS[subType] || ICONS.text;
```

- [ ] **Step 3: Render the color swatch**

Find the icon-rendering JSX (still inside the `Card` component's `return (...)`):

```tsx
        ) : (
          <div className={`${styles.cardIcon} ${iconBg}`}>
            <Icon size={18} color={iconColor} strokeWidth={2.2} />
          </div>
        )}
```

(this is the closing `else` branch of the `item.type === "image" ? ( ... ) : ( ... )` conditional). Change it to add a `color` branch before the final fallback:

```tsx
        ) : parsedColor ? (
          <div
            className={`${styles.cardIcon} ${styles.colorIcon}`}
            style={{
              "--swatch-color": item.text.trim(),
              "--swatch-bg": `rgba(${parsedColor.r}, ${parsedColor.g}, ${parsedColor.b}, 0.12)`,
              "--swatch-border": `rgba(${parsedColor.r}, ${parsedColor.g}, ${parsedColor.b}, 0.22)`,
              "--swatch-inset": `rgba(${parsedColor.r}, ${parsedColor.g}, ${parsedColor.b}, 0.1)`,
            } as CSSProperties}
          >
            <div className={styles.colorDot} />
          </div>
        ) : (
          <div className={`${styles.cardIcon} ${iconBg}`}>
            <Icon size={18} color={iconColor} strokeWidth={2.2} />
          </div>
        )}
```

- [ ] **Step 4: Add the CSS**

In `src/components/CardList.module.css`, find the existing rule:

```css
.bgPurple { background: rgba(139, 92, 246, 0.12);  border-color: rgba(139, 92, 246, 0.22);  box-shadow: inset 0 2px 4px rgba(139, 92, 246, 0.1), 0 2px 8px rgba(0,0,0,0.15); }
```

Add immediately after it:

```css

/* 颜色值拾取预览 (#10) — 图标底色/边框/内阴影用当前颜色本身的低透明度，而非固定色系 */
.colorIcon {
  background: var(--swatch-bg);
  border-color: var(--swatch-border);
  box-shadow: inset 0 2px 4px var(--swatch-inset), 0 2px 8px rgba(0,0,0,0.15);
}
.colorDot {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--swatch-color);
  box-shadow: 0 0 0 2px rgba(255,255,255,0.55), inset 0 0 0 1px rgba(0,0,0,0.08);
}
```

- [ ] **Step 5: Type-check and visually verify**

Run: `npx tsc --noEmit`
Expected: no errors.

If `npm run tauri dev` is already running (Vite HMR picks up the change automatically), copy `#FF5733` to the clipboard and confirm a new history card shows a solid orange circular swatch inside the icon slot, matching `design/color-preview.html`. Also copy `rgba(59, 130, 246, 0.5)` and `hsl(160, 84%, 39%)` and confirm both render correctly. Copy a normal code snippet and confirm its icon is unaffected.

- [ ] **Step 6: Run the full test suite to check for regressions**

Run: `npx vitest run`
Expected: all existing test files still pass (no change to their behavior — this task only touched non-test files plus the isolated CSS/JSX rendering path).

- [ ] **Step 7: Commit**

```bash
git add src/components/Card.tsx src/components/CardList.module.css
git commit -m "feat: 卡片列表新增颜色值色块预览"
```

---

### Task 4: Format-conversion context menu

**Files:**
- Modify: `src/components/ContextMenu.tsx` (the `buildTransformMenu` function)
- Modify: `src/components/Card.tsx` (the `CardWithContext` component's `handlePasteTransform`, and its import list — shares the file with Task 3 but this is a different component within it)

**Interfaces:**
- Consumes: `detectColor`, `toHex`, `toRgb`, `toHsl` from Task 1 (`src/lib/color.ts`); `subType === "color"` from Task 2/3.
- Produces: three new transform identifiers (`"color_hex"`, `"color_rgb"`, `"color_hsl"`) that `onPasteTransform` (already wired end-to-end via `createCardMenuItems`) passes through to `handlePasteTransform`.

- [ ] **Step 1: Add the menu items in `ContextMenu.tsx`**

In `src/components/ContextMenu.tsx`, inside `buildTransformMenu`, find the `phone` subtype branch and the trailing `else` branch:

```tsx
    } else if (subType === "phone") {
      children.push(
        { icon: <span style={{ fontSize: 12 }}>📞</span>, label: "粘贴为 tel 链接", onClick: () => onTransform("tel") },
        { icon: <span style={{ fontSize: 12 }}>+</span>, label: "粘贴为 +86 格式", onClick: () => onTransform("phone_cn") },
      );
    } else {
      // 普通文本：也有 Markdown 链接
      children.push(
        { icon: <span style={{ fontSize: 12 }}>🔗</span>, label: "粘贴为 Markdown 链接", onClick: () => onTransform("md_link") },
      );
    }
```

Insert a new `color` branch between them:

```tsx
    } else if (subType === "phone") {
      children.push(
        { icon: <span style={{ fontSize: 12 }}>📞</span>, label: "粘贴为 tel 链接", onClick: () => onTransform("tel") },
        { icon: <span style={{ fontSize: 12 }}>+</span>, label: "粘贴为 +86 格式", onClick: () => onTransform("phone_cn") },
      );
    } else if (subType === "color") {
      children.push(
        { icon: <span className={styles.ctxTextIcon} style={{ background: "rgba(255,87,51,.15)", color: "#FF5733" }}>#</span>, label: "复制为 HEX", onClick: () => onTransform("color_hex") },
        { icon: <span className={styles.ctxTextIcon} style={{ background: "rgba(59,130,246,.15)", color: "#3B82F6" }}>R</span>, label: "复制为 RGB", onClick: () => onTransform("color_rgb") },
        { icon: <span className={styles.ctxTextIcon} style={{ background: "rgba(16,185,129,.15)", color: "#10B981" }}>H</span>, label: "复制为 HSL", onClick: () => onTransform("color_hsl") },
      );
    } else {
      // 普通文本：也有 Markdown 链接
      children.push(
        { icon: <span style={{ fontSize: 12 }}>🔗</span>, label: "粘贴为 Markdown 链接", onClick: () => onTransform("md_link") },
      );
    }
```

- [ ] **Step 2: Add the transform cases in `Card.tsx`**

In `src/components/Card.tsx`, update the import added in Task 3 to also bring in the conversion functions:

```ts
import { detectColor } from "@/lib/color";
```

becomes:

```ts
import { detectColor, toHex, toRgb, toHsl } from "@/lib/color";
```

Then, in the `CardWithContext` component's `handlePasteTransform`, find the phone-transform cases:

```ts
        case "tel": text = `tel:${text.replace(/[- ]/g, "")}`; break;
        case "phone_cn": {
          const digits = text.replace(/[- ()（）+]/g, "");
          text = digits.startsWith("86") ? `+${digits}` : `+86${digits}`;
          break;
        }
```

Add the three color cases immediately after `phone_cn`'s closing `}`:

```ts
        case "tel": text = `tel:${text.replace(/[- ]/g, "")}`; break;
        case "phone_cn": {
          const digits = text.replace(/[- ()（）+]/g, "");
          text = digits.startsWith("86") ? `+${digits}` : `+86${digits}`;
          break;
        }

        // === 颜色子类型专属 ===
        case "color_hex": {
          const parsed = detectColor(text.trim());
          if (parsed) text = toHex(parsed);
          break;
        }
        case "color_rgb": {
          const parsed = detectColor(text.trim());
          if (parsed) text = toRgb(parsed);
          break;
        }
        case "color_hsl": {
          const parsed = detectColor(text.trim());
          if (parsed) text = toHsl(parsed);
          break;
        }
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manually verify the end-to-end flow**

With `npm run tauri dev` running, copy `#FF5733` to the clipboard, right-click its card, open "粘贴并变换", confirm three new items "复制为 HEX" / "复制为 RGB" / "复制为 HSL" appear (matching `design/color-preview.html`'s menu mockup). Click "复制为 RGB", then paste into a text editor and confirm it produces `rgb(255, 87, 51)`. Repeat for a `hsl(...)` and `rgba(...)` source value to confirm all 3-way conversions work, including alpha preservation (copy `rgba(59, 130, 246, 0.5)`, convert to HEX, confirm output is `#3b82f680`).

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: all test files pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/components/ContextMenu.tsx src/components/Card.tsx
git commit -m "feat: 颜色值支持粘贴并变换为 HEX/RGB/HSL"
```

---

## Self-Review Notes

- **Spec coverage:** All 6 spec sections (检测规则/展示设计/格式互转/边界情况/文件变更清单/测试计划) map to Task 1 (detection + conversion + edge cases), Task 2 (wiring), Task 3 (display), Task 4 (conversion menu). No gaps.
- **File changes match spec's file list exactly:** `src/lib/color.ts` (new), `src/lib/utils.ts`, `src/components/Card.tsx`, `src/components/CardList.module.css`, `src/components/ContextMenu.tsx` — 1 new + 4 modified, 0 new dependencies, as specified.
- **Type consistency:** `ParsedColor` defined once in Task 1, used identically (same field names `r/g/b/a`) in Task 3's swatch rendering and Task 4's transform cases. `detectColor`/`toHex`/`toRgb`/`toHsl` signatures unchanged across all consuming tasks.
- **No placeholders:** every step has complete, runnable code and exact commands.
