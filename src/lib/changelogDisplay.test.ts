import { describe, it, expect } from "vitest";
import { stripBold, splitChangelogText } from "./changelogDisplay";

// 守卫钉住「桌面弹框与手机半屏同源」的显示口径；反例逐条喂进三臂，
// 保证判据不是只在 happy path 绿灯（见记忆 Falsify-your-guards）。
describe("changelogDisplay", () => {
  it("stripBold 只去 ** 不动其它", () => {
    expect(stripBold("**甲**乙")).toBe("甲乙");
    expect(stripBold("无星号")).toBe("无星号");
  });

  it("**标题**：明细 → titleOnly（吞掉明细）", () => {
    expect(splitChangelogText("**手机端自更新**：不用回电脑")).toEqual({
      kind: "titleOnly",
      title: "手机端自更新",
    });
    // 半角冒号同样命中
    expect(splitChangelogText("**X**:rest").kind).toBe("titleOnly");
  });

  it("反例：粗体不在句首 / 无冒号 → 不落 titleOnly", () => {
    // 冒号缺失
    expect(splitChangelogText("**甲** 乙").kind).toBe("plain");
    // 粗体前有前缀（不匹配 ^**）**
    const r = splitChangelogText("前缀**甲**：乙");
    expect(r.kind).not.toBe("titleOnly");
  });

  it("标题：明细 → lead 拆加粗引导词", () => {
    expect(splitChangelogText("画质更清晰：链路切换后回升")).toEqual({
      kind: "lead",
      lead: "画质更清晰",
      sep: "：",
      rest: "链路切换后回升",
    });
  });

  it("标题 — 明细 → lead（破折号分隔）", () => {
    expect(splitChangelogText("录屏暂停 — 中途停不中断")).toMatchObject({
      kind: "lead",
      lead: "录屏暂停",
      sep: " — ",
    });
  });

  it("无冒号无破折号 → plain 且剥 **", () => {
    expect(splitChangelogText("修复了**某**问题")).toEqual({ kind: "plain", text: "修复了某问题" });
  });

  it("lead 只按第一个分隔符切一次（贪心前缀最短）", () => {
    expect(splitChangelogText("甲：乙：丙")).toMatchObject({ lead: "甲", rest: "乙：丙" });
  });
});
