import { describe, expect, it } from "vitest";
import { scopeLabel, scopeLabelLong } from "@/lib/rcSessionStats";

describe("scopeLabel（HUD 短文案）", () => {
  it("virtual → 整屏", () => {
    expect(scopeLabel("virtual")).toBe("整屏");
  });

  it("primary → 主屏", () => {
    expect(scopeLabel("primary")).toBe("主屏");
  });

  it("monitor:N 用 1 起的序号", () => {
    expect(scopeLabel("monitor:0")).toBe("屏1");
    expect(scopeLabel("monitor:2")).toBe("屏3");
  });

  it("monitor: 后面不是数字时不说成「屏NaN」", () => {
    expect(scopeLabel("monitor:abc")).toBe("指定屏");
  });
});

describe("scopeLabelLong（B3 被控端通知文案）", () => {
  it("virtual 必须点明「含副屏」——这是隐私提示的关键信息", () => {
    expect(scopeLabelLong("virtual")).toContain("副屏");
  });

  it("primary → 仅主屏", () => {
    expect(scopeLabelLong("primary")).toBe("仅主屏");
  });

  it("monitor:N 用 1 起的序号且可读", () => {
    expect(scopeLabelLong("monitor:0")).toBe("第 1 台显示器");
    expect(scopeLabelLong("monitor:1")).toBe("第 2 台显示器");
  });

  it("monitor: 后面不是数字时退回「指定显示器」", () => {
    expect(scopeLabelLong("monitor:abc")).toBe("指定显示器");
  });

  it("未知 scope 退回最宽范围描述（宁可说多，不可说少）", () => {
    expect(scopeLabelLong("")).toBe("整个虚拟屏（含副屏）");
    expect(scopeLabelLong("nonsense")).toBe("整个虚拟屏（含副屏）");
  });

  it("短文案与长文案不能互相说反（防复制粘贴改错）", () => {
    expect(scopeLabel("virtual")).toBe("整屏");
    expect(scopeLabel("primary")).toBe("主屏");
    expect(scopeLabelLong("virtual")).not.toBe(scopeLabelLong("primary"));
  });
});
