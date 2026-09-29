/**
 * 乙档-①（2026-09-29）守卫：顶缘 hover 唤出偏好的读取口径（规则 11.1）。
 *
 * 与 `rcClipAuto.test.ts` 同一类判据：**缺键必须默认开**。这条一旦写反，
 * 老用户升级后发现顶缘划过不再唤出浮条，而 UI 上「顶缘悬停唤出」明明写着「开」——
 * 读起来像 bug，实际是缺键分支被改成了 false。
 */
import { describe, expect, it } from "vitest";
import { RC_HOVER_REVEAL_KEY, rcHoverRevealFromConfig } from "./rcHoverReveal";

describe("rcHoverRevealFromConfig", () => {
  it("缺键（旧用户配置）→ 默认开，保留甲方案那条顶缘唤出", () => {
    expect(rcHoverRevealFromConfig({})).toBe(true);
  });

  it("显式 false → 关（顶缘零触发，只剩把手与 F10）", () => {
    expect(rcHoverRevealFromConfig({ [RC_HOVER_REVEAL_KEY]: false })).toBe(false);
  });

  it("显式 true → 开", () => {
    expect(rcHoverRevealFromConfig({ [RC_HOVER_REVEAL_KEY]: true })).toBe(true);
  });

  it("脏值（字符串 / 数字）→ 默认开，不把垃圾当偏好", () => {
    expect(rcHoverRevealFromConfig({ [RC_HOVER_REVEAL_KEY]: "off" })).toBe(true);
    expect(rcHoverRevealFromConfig({ [RC_HOVER_REVEAL_KEY]: 0 })).toBe(true);
  });

  it("非对象（null / undefined / 原始值）→ 默认开", () => {
    expect(rcHoverRevealFromConfig(null)).toBe(true);
    expect(rcHoverRevealFromConfig(undefined)).toBe(true);
    expect(rcHoverRevealFromConfig("config")).toBe(true);
  });
});
