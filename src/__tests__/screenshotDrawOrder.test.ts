import { describe, expect, it } from "vitest";
import { contrastInk, inDrawOrder } from "@/lib/screenshot/draw";
import type { Annotation, ToolId } from "@/lib/screenshot/types";

function a(id: number, type: ToolId, color = "#ef4444"): Annotation {
  return { id, type, color, width: 3, x: 0, y: 0, x2: 10, y2: 10 };
}

describe("inDrawOrder · 高亮先画", () => {
  it("高亮被提到最前", () => {
    const list = [a(1, "rect"), a(2, "highlight"), a(3, "text")];
    expect(inDrawOrder(list).map((x) => x.id)).toEqual([2, 1, 3]);
  });

  it("多个高亮之间保持原有先后（稳定排序）", () => {
    // 同类元素的先后就是 z 序，打乱了后画的高亮会跑到先画的下面
    const list = [a(1, "highlight"), a(2, "rect"), a(3, "highlight")];
    expect(inDrawOrder(list).map((x) => x.id)).toEqual([1, 3, 2]);
  });

  it("非高亮之间也保持原有先后", () => {
    const list = [a(1, "rect"), a(2, "ellipse"), a(3, "arrow")];
    expect(inDrawOrder(list).map((x) => x.id)).toEqual([1, 2, 3]);
  });

  it("没有高亮时原数组顺序不变", () => {
    const list = [a(1, "rect"), a(2, "pen")];
    expect(inDrawOrder(list).map((x) => x.id)).toEqual([1, 2]);
  });

  it("空数组", () => {
    expect(inDrawOrder([])).toEqual([]);
  });

  it("不修改入参", () => {
    const list = [a(1, "rect"), a(2, "highlight")];
    inDrawOrder(list);
    expect(list.map((x) => x.id)).toEqual([1, 2]);
  });
});

describe("contrastInk · 文字/序号描边的对比墨色", () => {
  it("浅色→深墨", () => {
    expect(contrastInk("#ffffff")).toBe("#1a1a1a");
    expect(contrastInk("#facc15")).toBe("#1a1a1a"); // 调色板里的黄
  });

  it("深色→白墨", () => {
    expect(contrastInk("#000000")).toBe("#ffffff");
    expect(contrastInk("#1f2937")).toBe("#ffffff"); // 调色板里的近黑
    expect(contrastInk("#ef4444")).toBe("#ffffff"); // 红
  });

  it("纯绿走感知亮度而不是算术平均", () => {
    // #22c55e 算术平均 (34+197+94)/3 ≈ 108（判为暗），
    // 感知亮度 0.299*34+0.587*197+0.114*94 ≈ 136……仍然 <150，该给白墨。
    // 这条钉的是“不能因为绿看着亮就给深墨”——白字压这个绿对比度更好。
    expect(contrastInk("#22c55e")).toBe("#ffffff");
    // 而明显偏亮的绿（感知亮度 >150）应该给深墨
    expect(contrastInk("#86efac")).toBe("#1a1a1a");
  });

  it("容错：非六位十六进制不能算出 NaN，给默认白", () => {
    expect(contrastInk("rgba(1,2,3,0.5)")).toBe("#ffffff");
    expect(contrastInk("")).toBe("#ffffff");
  });

  it("容错：带/不带 # 与大小写都认", () => {
    expect(contrastInk("FFFFFF")).toBe("#1a1a1a");
    expect(contrastInk("  #FfFfFf ")).toBe("#1a1a1a");
  });
});
