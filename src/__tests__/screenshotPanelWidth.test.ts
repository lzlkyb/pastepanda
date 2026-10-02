/**
 * 浮层宽度常量 ↔ CSS 宽度的一致性守卫（规则 11.1）。
 *
 * 为什么钉这一条：`layoutSidePanel` 用 JS 常量算左右位置与可用高度，CSS 决定实际画多宽。
 * 两边分叉的失败方式是**静默**的 —— 面板会溢出算好的位置、或比算好的窄一截而右侧留白，
 * 而单测里的几何断言用的还是常量，全绿。
 *
 * 读源文件而不是渲染：jsdom 里样式表被 stub，量不到真实宽度（同 screenshotThemeTokens）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AI_POP_W, OCR_PANEL_W } from "@/lib/screenshot/shotConstants";

// vitest 从项目根启动，process.cwd() = 项目根（import.meta.url 在 vitest 下不是 file scheme）
const css = readFileSync(resolve(process.cwd(), "src/styles/screenshot.css"), "utf8");

/** 取某选择器声明块里的 `width: Npx`，没写就返回 null */
function widthOf(selector: string): number | null {
  const at = css.indexOf(selector);
  if (at === -1) throw new Error(`screenshot.css 里找不到 ${selector}`);
  const block = css.slice(css.indexOf("{", at), css.indexOf("}", at));
  const m = block.match(/(^|[^-])width:\s*(\d+)px/);
  return m ? Number(m[2]) : null;
}

describe("浮层宽度常量与 CSS 同值", () => {
  it("OCR 抽屉宽度 = OCR_PANEL_W", () => {
    expect(widthOf(".ocr-drawer")).toBe(OCR_PANEL_W);
  });
  it("云端弹层宽度 = AI_POP_W", () => {
    expect(widthOf(".pop-layer")).toBe(AI_POP_W);
  });
});
