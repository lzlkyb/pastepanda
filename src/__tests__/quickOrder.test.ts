/**
 * quickOrder 拖拽排序纯函数测试(G6)。
 */

import { describe, it, expect } from "vitest";
import { applyQuickOrder, reorderAction } from "@/lib/quickOrder";

interface Item {
  id: string;
  label: string;
}

function items(ids: string[]): Item[] {
  return ids.map((id, i) => ({ id, label: `${id}-${i}` }));
}

describe("applyQuickOrder 按保存顺序重排", () => {
  it("按记录顺序排", () => {
    const out = applyQuickOrder(items(["a", "b", "c"]), ["c", "a"]);
    expect(out.map((i) => i.id)).toEqual(["c", "a", "b"]);
  });

  it("不在记录里的排后面(保持相对顺序)", () => {
    const out = applyQuickOrder(items(["x", "y", "z"]), ["y"]);
    expect(out.map((i) => i.id)).toEqual(["y", "x", "z"]);
  });

  it("空记录 → 保持原顺序", () => {
    const out = applyQuickOrder(items(["a", "b"]), []);
    expect(out.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("不改原数组(纯函数)", () => {
    const src = items(["a", "b", "c"]);
    applyQuickOrder(src, ["b"]);
    expect(src.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});

describe("reorderAction 拖拽换位", () => {
  it("前移", () => {
    expect(reorderAction(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
  });

  it("后移", () => {
    expect(reorderAction(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("非法输入返回 null(from==to / 越界 / 负值)", () => {
    expect(reorderAction(["a", "b"], 1, 1)).toBeNull();
    expect(reorderAction(["a", "b"], 0, 5)).toBeNull();
    expect(reorderAction(["a", "b"], -1, 1)).toBeNull();
    expect(reorderAction(["a", "b"], 2, 0)).toBeNull();
  });
});
