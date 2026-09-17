import { describe, expect, it } from "vitest";
import { scopeOptions, scopeLabel, scopeLabelLong } from "@/lib/rcScope";
import type { RcMonitorInfo } from "@/lib/api/rc";

const MON = (index: number, primary = false): RcMonitorInfo => ({
  index,
  primary,
  w: 1920,
  h: 1080,
  x: 0,
  y: 0,
});

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

describe("scopeOptions（会话画质条与设置页共用的唯一档位表）", () => {
  it("没给显示器列表时只有两个固定档——会话中拿不到对端的屏，不许列本机的", () => {
    expect(scopeOptions([]).map((o) => o.key)).toEqual(["virtual", "primary"]);
  });

  it("有显示器时逐屏追加在后，label 用 1 起序号", () => {
    const opts = scopeOptions([MON(0, true), MON(1)]);
    expect(opts.map((o) => o.key)).toEqual(["virtual", "primary", "monitor:0", "monitor:1"]);
    expect(opts[2].label).toBe("屏1·主");
    expect(opts[3].label).toBe("屏2");
  });

  it("🔴 唯一真源：按钮文案必须取自共享词汇表，不允许出现第三套说法", () => {
    // 收口之前设置页写「整个虚拟屏（含副屏）」、画质条写「整屏」——同一档两种说法。
    // 规则：要么就是长文案本身（primary 用「仅主屏」），
    //       要么以短文案开头（「屏2」/「屏1·主」）。
    // 这条钉子保证以后新增档位只能复用 scopeLabel/scopeLabelLong，不能自己造词。
    for (const o of scopeOptions([MON(0, true), MON(1)])) {
      const short = scopeLabel(o.key);
      const long = scopeLabelLong(o.key);
      expect(o.label === long || o.label.startsWith(short)).toBe(true);
      expect(o.tip.length).toBeGreaterThan(0);
    }
  });

  it("设置页也能拿到逐屏档（改前只有整屏/仅主屏两项）", () => {
    expect(scopeOptions([MON(0, true), MON(1)]).length).toBe(4);
  });
});
