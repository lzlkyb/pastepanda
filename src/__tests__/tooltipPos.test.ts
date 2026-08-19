import { describe, it, expect } from "vitest";
import { tipPlacement } from "@/lib/screenshot/tooltipPos";

describe("tipPlacement 悬浮提示翻转", () => {
  // estH=30, gap=8 为默认值；上弹阈值 = top - 38，低于 0 才下弹
  it("工具栏在选区下方（中上部）：上弹，不撞属性条（below=false）", () => {
    // rect.top=100，100-38=62 > 0 → 上弹
    expect(tipPlacement({ top: 100, bottom: 150 }, 800)).toBe(false);
  });

  it("工具栏在选区上方 top-attached（中下部）：上弹，不压画布（below=false）", () => {
    // 选区分在屏幕下部、工具栏翻到选区上方，rect.top=600 落中下部，但上方放得下 → 上弹
    expect(tipPlacement({ top: 600, bottom: 640 }, 800)).toBe(false);
  });

  it("贴顶：上方放不下则下弹（below=true）", () => {
    // rect.top=5，5-38 < 0 → 下弹
    expect(tipPlacement({ top: 5, bottom: 30 }, 800)).toBe(true);
  });

  it("贴顶边界：top 恰好 38 时仍上弹（below=false）", () => {
    // top=38，38-38=0，不满足 < 0 → 上弹
    expect(tipPlacement({ top: 38, bottom: 70 }, 800)).toBe(false);
  });

  it("自定义 estH/gap 生效：更紧凑时贴顶判定阈值随之变化", () => {
    // 同一位置 top=30：
    // 紧凑参数 estH=20,gap=4 → 阈值=top-24=6≥0 → 上弹(false)
    expect(tipPlacement({ top: 30, bottom: 60 }, 800, 20, 4)).toBe(false);
    // 默认参数 estH=30,gap=8 → 阈值=top-38=-8<0 → 下弹(true)
    expect(tipPlacement({ top: 30, bottom: 60 }, 800)).toBe(true);
  });
});
