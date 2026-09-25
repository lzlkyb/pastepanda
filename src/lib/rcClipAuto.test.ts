import { describe, expect, it } from "vitest";
import { RC_CLIP_AUTO_KEY, rcClipAutoFromConfig } from "./rcClipAuto";

/** 🔴 守卫：缺键 / 脏值必须落到「默认开」——这是 B 方案升级旧配置的语义本体。 */
describe("rcClipAutoFromConfig", () => {
  it("缺键（旧用户配置）→ 默认开", () => {
    expect(rcClipAutoFromConfig({})).toBe(true);
  });

  it("显式 false → 关（记住的关闭选择）", () => {
    expect(rcClipAutoFromConfig({ [RC_CLIP_AUTO_KEY]: false })).toBe(false);
  });

  it("显式 true → 开", () => {
    expect(rcClipAutoFromConfig({ [RC_CLIP_AUTO_KEY]: true })).toBe(true);
  });

  it("脏值（字符串 / 数字）→ 默认开，不把垃圾当偏好", () => {
    expect(rcClipAutoFromConfig({ [RC_CLIP_AUTO_KEY]: "off" })).toBe(true);
    expect(rcClipAutoFromConfig({ [RC_CLIP_AUTO_KEY]: 0 })).toBe(true);
  });

  it("非对象（null / undefined / 原始值）→ 默认开", () => {
    expect(rcClipAutoFromConfig(null)).toBe(true);
    expect(rcClipAutoFromConfig(undefined)).toBe(true);
    expect(rcClipAutoFromConfig("config")).toBe(true);
  });
});
