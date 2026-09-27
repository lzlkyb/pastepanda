/**
 * 守卫测试（规则 11.1）：`normalizeGlass` 是遮盖度的唯一收口口径——
 * 设置页滑杆、岛前端写 CSS 变量、appStore 旧值迁移三处都过它。
 * 只要有一条不变量被破（越界值漏进 calc、旧档位字符串变 NaN），岛面材质就会拿到非法变量。
 */
import { describe, expect, it } from "vitest";
import { GLASS_DEFAULT, GLASS_MAX, GLASS_MIN, normalizeGlass } from "./glass";

describe("normalizeGlass", () => {
  it("合法区间内取整", () => {
    expect(normalizeGlass(78)).toBe(78);
    expect(normalizeGlass(90.4)).toBe(90);
    expect(normalizeGlass(90.6)).toBe(91);
  });

  it("越界值必须被夹进 66–100，不能漏进 CSS calc（66 = 对比度地板，见 glass.ts 推演）", () => {
    expect(normalizeGlass(0)).toBe(GLASS_MIN);
    expect(normalizeGlass(-30)).toBe(GLASS_MIN);
    // 旧的「随便透」区间（<66）整体钳进地板：50.4/50.6 都落 66
    expect(normalizeGlass(50.4)).toBe(GLASS_MIN);
    expect(normalizeGlass(50.6)).toBe(GLASS_MIN);
    expect(normalizeGlass(100)).toBe(GLASS_MAX);
    expect(normalizeGlass(180)).toBe(GLASS_MAX);
    expect(normalizeGlass(Number.MAX_SAFE_INTEGER)).toBe(GLASS_MAX);
  });

  it("旧四档字符串按原 tint α 折算，再钳进 66–100（clear=30 低于地板 → 66）", () => {
    expect(normalizeGlass("clear")).toBe(GLASS_MIN);
    expect(normalizeGlass("frost")).toBe(78);
    expect(normalizeGlass("steady")).toBe(90);
    expect(normalizeGlass("dark")).toBe(92);
  });

  it("认不出来的值落默认档，不返回 NaN", () => {
    for (const raw of [undefined, null, NaN, Infinity, "", "bright", {}, [], true]) {
      expect(normalizeGlass(raw)).toBe(GLASS_DEFAULT);
    }
  });

  it("默认档本身在合法区间内（三处同账：DEFAULT_CONFIG / CSS 初值 / 这里）", () => {
    expect(GLASS_DEFAULT).toBeGreaterThanOrEqual(GLASS_MIN);
    expect(GLASS_DEFAULT).toBeLessThanOrEqual(GLASS_MAX);
  });
});
