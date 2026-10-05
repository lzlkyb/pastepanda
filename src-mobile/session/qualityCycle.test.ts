import { describe, expect, it } from "vitest";
import { DEFAULT_QUALITY, qualityLabel } from "@/lib/rcQuality";
import {
  MOBILE_QUALITY_CYCLE,
  defaultMobileQuality,
  normalizeMobileQuality,
} from "./qualityCycle";

/**
 * 2026-10-02 真机回归：手机端默认画质显示「均衡」，而后端跑的是自动换档——
 * 根因是档位表缺 `auto` + 回落值硬编码 `"balanced"`。这里把两条不变量钉住：
 * ① 默认档必须在手机可选集里（否则永远显示不出真实策略）；
 * ② 任何未知/缺失 hint 都必须落到默认档，不许落到某个实名档。
 */
describe("手机端画质档收敛", () => {
  it("默认档在手机可选集里", () => {
    expect(MOBILE_QUALITY_CYCLE).toContain(DEFAULT_QUALITY);
    expect(defaultMobileQuality()).toBe(DEFAULT_QUALITY);
  });

  it("未知与缺失一律回落默认档，不猜 balanced", () => {
    expect(normalizeMobileQuality(undefined)).toBe("auto");
    expect(normalizeMobileQuality(null)).toBe("auto");
    expect(normalizeMobileQuality("")).toBe("auto");
    expect(normalizeMobileQuality("uhd60")).toBe("auto");
    expect(normalizeMobileQuality("garbage")).toBe("auto");
  });

  it("已知档原样通过", () => {
    for (const q of MOBILE_QUALITY_CYCLE) {
      expect(normalizeMobileQuality(q)).toBe(q);
    }
  });

  it("中文名与桌面同源（auto = 自动，不再显示成均衡）", () => {
    expect(qualityLabel("auto")).toBe("自动");
    expect(MOBILE_QUALITY_CYCLE.map(qualityLabel)).toContain("自动");
  });
});
