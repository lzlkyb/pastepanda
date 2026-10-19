/**
 * 选区尺寸提示条的水平定位守卫。
 *
 * 2026-10-18 实测：从屏幕右缘往右拖（rect.x = 1786，条自然宽 224）时，
 * 条按 `left: rect.x` 起画 → 右边界 2010 > 1920，**右边 90px 被窗口裁掉**，
 * 用户看不到「Esc 重选」。这不是审美问题：它是拖拽中唯一的取消提示。
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { SizeHintBar } from "./RecSourceHints";

const base = {
  phase: "dragging" as const,
  rect: { x: 200, y: 500, w: 124, h: 130 },
  dpr: 1,
  snapRect: null,
  rectFromWindow: false,
};

describe("选区尺寸提示条：不许伸到屏幕外", () => {
  it("贴右缘时改贴右边（left:rect.x 会溢出被裁）", () => {
    const { container } = render(
      <SizeHintBar {...base} rect={{ x: 1786, y: 500, w: 124, h: 130 }} screenCssW={1920} />,
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.right).toBe("8px");
    // 同时不能再留着 left，否则两者一起生效会拉成整屏宽
    expect(el.style.left).toBe("");
  });

  it("左侧正常位置仍从选区左缘起画", () => {
    const { container } = render(<SizeHintBar {...base} screenCssW={1920} />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.left).toBe("200px");
    expect(el.style.right).toBe("");
  });

  it("分区容差：恰好卡在边界前一侧仍走 left", () => {
    // 1920 - 240 = 1680 ⇒ x = 1680 时刚好不溢出，用 > 而不是 >=
    const { container } = render(
      <SizeHintBar {...base} rect={{ x: 1680, y: 500, w: 60, h: 60 }} screenCssW={1920} />,
    );
    expect((container.firstElementChild as HTMLElement).style.left).toBe("1680px");
  });
});
