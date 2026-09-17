import { describe, expect, it } from "vitest";
import { DEFAULT_QUALITY, RC_QUALITIES, qualityLabel } from "@/lib/rcQuality";

describe("qualityLabel（短文案）", () => {
  it("五档的中文名", () => {
    expect(qualityLabel("smooth")).toBe("流畅");
    expect(qualityLabel("balanced")).toBe("均衡");
    expect(qualityLabel("sharp")).toBe("清晰");
    expect(qualityLabel("ultra")).toBe("超清");
    expect(qualityLabel("uhd")).toBe("原生");
  });

  it("未知 / 空串回落默认档文案，不显示空字符串", () => {
    expect(qualityLabel("nonsense")).toBe(qualityLabel(DEFAULT_QUALITY));
    expect(qualityLabel("")).toBe(qualityLabel(DEFAULT_QUALITY));
  });
});

describe("RC_QUALITIES（画质档唯一真源）", () => {
  it("🔴 唯一真源：短文案必须取自同一张表，不允许出现第二套 label", () => {
    // 收口之前 `RcAllowPanel` 写「超清（约 2.5K）」、画质条写「超清」，
    // 设置页与画质条对同一个档给出不同按钮文字。这条钉子钉住「只有一张表」。
    for (const o of RC_QUALITIES) {
      expect(qualityLabel(o.key)).toBe(o.label);
      expect(o.label.length).toBeGreaterThan(0);
      expect(o.tip.length).toBeGreaterThan(0);
    }
  });

  it("五档且顺序固定为 流畅 → 均衡 → 清晰 → 超清 → 原生（界面按这个顺序排）", () => {
    expect(RC_QUALITIES.map((o) => o.key)).toEqual([
      "smooth",
      "balanced",
      "sharp",
      "ultra",
      "uhd",
    ]);
  });

  it("key 不重复", () => {
    expect(new Set(RC_QUALITIES.map((o) => o.key)).size).toBe(RC_QUALITIES.length);
  });

  it("默认档是「均衡」（与后端默认档一致）", () => {
    expect(DEFAULT_QUALITY).toBe("balanced");
  });

  it("说明性文字留在 tip 里（fps / 宽度），不挤进按钮文案", () => {
    const ultra = RC_QUALITIES.find((o) => o.key === "ultra")!;
    // 「约 2.5K」这类原本只在设置页出现的信息不能丢，它现在是共享 tip 的一部分
    expect(ultra.tip).toContain("2.5K");
    expect(ultra.label).toBe("超清");
  });
});
