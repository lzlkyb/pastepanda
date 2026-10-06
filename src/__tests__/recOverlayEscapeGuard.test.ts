/**
 * 录屏选区覆盖层的两条「重写即丢」守卫（2026-10-05 方案 A 审查）。
 *
 * 方案 A 把 RecSelectOverlay 从 469 行拆成 hook + 展示部件时，旧版的 keydown
 * Escape 处理器被整段弄丢：提示条 / 尺寸标签 / 倒计时层 / 失败卡里所有「Esc ××」
 * 文案变成空头支票，而倒计时态忽略鼠标事件，用户在录制开始前没有任何取消手段。
 * dialogEscapeLayering 的层序行为测试管不到独立窗口入口，这里按仓库惯例钉源码
 * 形状——重写再丢时必须变红，而不是等用户按 Esc 没反应。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const overlaySrc = readFileSync(
  join(process.cwd(), "src/components/recsel/RecSelectOverlay.tsx"),
  "utf8",
);
const mouseSrc = readFileSync(join(process.cwd(), "src/hooks/useRecSelectMouse.ts"), "utf8");

describe("录屏选区覆盖层 Esc 处理器不得丢失", () => {
  it("RecSelectOverlay 挂了 keydown Escape（两级取消的命脉）", () => {
    expect(overlaySrc).toContain('addEventListener("keydown"');
    expect(overlaySrc).toContain('e.key !== "Escape"');
  });

  it("preview 态兑现提示条「Esc 退出」，countdown 态兑现「Esc 取消」", () => {
    expect(overlaySrc).toContain("phase === \"preview\"");
    expect(overlaySrc).toContain('phase === "countdown"');
  });
});

describe("悬停目标只许在预览态被继承", () => {
  it("mousedown 继承 hoverRect 必须以 phase === preview 为条件", () => {
    // 不设条件 = confirm 态点选区外重画时继承上一次预览的陈旧高亮，
    // 单击空白处会凭空采纳几秒前悬停过的窗口（P1，2026-10-05 审查）
    expect(mouseSrc).toContain('phase === "preview" ? hoverRect : null');
  });
});
