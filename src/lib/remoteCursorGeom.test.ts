/**
 * `cursorCssFor` 与遥控光标几何的守卫测试——钉住几件「错了也看不出来」的事：
 *
 * ① 形状 → CSS 的映射**只有一份**（`lib/utils.ts`，桌面/手机共用）。桌面把它
 *    设到画布上，手机端按同一个值挑图形；两份各写一份，迟早分叉。
 * ② `mapNormToClient` 是 `mapNormFromCanvas` 的正向逆：发起端按被控端推来的
 *    归一化坐标画光标，几何必须和发输入时用的同一套（contain 居中裁切），
 *    否则「看到光标在 A、点下去落在 B」。
 * ③ payload 里 x/y 缺省（对端不可见 / 旧版只发形状）必须能被识别出来，
 *    不能退化成「光标摆在 (0,0)」。
 */
import { describe, expect, it } from "vitest";
import { cursorCssFor } from "@/lib/utils";
import { mapNormFromCanvas, mapNormToClient } from "@/lib/rcPointer";

function fakeCanvas(rect: { left: number; top: number; width: number; height: number }) {
  return {
    getBoundingClientRect: () => ({ ...rect, right: 0, bottom: 0, x: 0, y: 0 }),
    width: 0,
    height: 0,
  } as unknown as HTMLCanvasElement;
}

describe("cursorCssFor", () => {
  it("文本输入位 I-beam 映射成 text（输入框/编辑器的高频形状）", () => {
    expect(cursorCssFor("ibeam")).toBe("text");
  });

  it("缩放柄四个方向各自映射，不能挤成同一个", () => {
    expect(cursorCssFor("size_ns")).toBe("ns-resize");
    expect(cursorCssFor("size_we")).toBe("ew-resize");
    expect(cursorCssFor("size_nwse")).toBe("nwse-resize");
    expect(cursorCssFor("size_nesw")).toBe("nesw-resize");
    expect(cursorCssFor("size_all")).toBe("move");
  });

  it("hidden 必须映射成 none——远端藏了光标，不能留个视觉谎", () => {
    expect(cursorCssFor("hidden")).toBe("none");
  });

  it("arrow / unknown / 未识别形状都没有等价 CSS，返回 null 让调用方用默认图形", () => {
    expect(cursorCssFor("arrow")).toBeNull();
    expect(cursorCssFor("unknown")).toBeNull();
    expect(cursorCssFor("some_future_shape")).toBeNull();
    expect(cursorCssFor(null)).toBeNull();
  });
});

describe("mapNormToClient", () => {
  it("fit(contain)：内容是 letterbox 中心，归一化中心回到画布中心", () => {
    // 画布 200×100、内容 100×100 → scale=1，内容区 ox=50、oy=0
    const el = fakeCanvas({ left: 0, top: 0, width: 200, height: 100 });
    const p = mapNormToClient(32768, 32768, el, 100, 100, "fit");
    expect(p.clientX).toBeCloseTo(100, 0);
    expect(p.clientY).toBeCloseTo(50, 0);
  });

  it("与 mapNormFromCanvas 互为逆：同一个点往返只差四舍五入", () => {
    const el = fakeCanvas({ left: 30, top: 40, width: 360, height: 200 });
    for (const [cx, cy] of [
      [40, 45],
      [120, 60],
      [210, 140],
      [380, 230],
    ] as const) {
      const norm = mapNormFromCanvas({ clientX: cx, clientY: cy }, el, 1280, 720, "fit");
      const back = mapNormToClient(norm.x, norm.y, el, 1280, 720, "fit");
      expect(Math.abs(back.clientX - cx)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.clientY - cy)).toBeLessThanOrEqual(1);
    }
  });

  it("归一化端点落在内容区两端（不会偏出 letterbox）", () => {
    const el = fakeCanvas({ left: 0, top: 0, width: 200, height: 100 });
    const tl = mapNormToClient(0, 0, el, 100, 100, "fit");
    const br = mapNormToClient(65535, 65535, el, 100, 100, "fit");
    expect(tl.clientX).toBeCloseTo(50, 0); // ox
    expect(tl.clientY).toBeCloseTo(0, 0); // oy
    expect(br.clientX).toBeCloseTo(150, 0); // ox + dw
    expect(br.clientY).toBeCloseTo(100, 0);
  });
});
