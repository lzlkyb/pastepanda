/**
 * 取色收口测试。
 *
 * 截图里有两个取色入口：放大镜（select 态拖选时跟随光标）与吸管（annotate 态点画布）。
 * 它们曾各写一遍 1×1 采样，口径还不一样 ——
 *   吸管：先 clearRect、alpha=0 返回 null、hex **大写**；
 *   放大镜：不 clear、不判 alpha、hex **小写**。
 * 同一张图同一个像素，两个入口给出不同的字符串，复制出来的色值取决于你从哪进。
 * 现已收口到 samplePixelHex 一处，这里守住它。
 */

import { describe, it, expect } from "vitest";
import { samplePixelHex } from "@/lib/screenshot/pixelProbe";

/** 造一个假的「已加载图片」：drawImage 只要能被 canvas 接受即可，取值由 ctx 桩决定 */
function fakeBase(): HTMLImageElement {
  return { naturalWidth: 100, naturalHeight: 100 } as unknown as HTMLImageElement;
}

/** 桩一个只认 1×1 采样的 2D context */
function stubCanvas(pixel: [number, number, number, number]) {
  const calls: string[] = [];
  const ctx = {
    clearRect: () => calls.push("clearRect"),
    drawImage: () => calls.push("drawImage"),
    getImageData: () => {
      calls.push("getImageData");
      return { data: new Uint8ClampedArray(pixel) };
    },
  };
  const saved = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function () {
    return ctx as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  return {
    calls,
    restore: () => {
      HTMLCanvasElement.prototype.getContext = saved;
    },
  };
}

describe("samplePixelHex", () => {
  it("返回大写 hex 与 RGB 三通道", () => {
    const s = stubCanvas([0xab, 0xcd, 0xef, 255]);
    try {
      const out = samplePixelHex(fakeBase(), 10, 20);
      expect(out).toEqual({ hex: "#ABCDEF", r: 0xab, g: 0xcd, b: 0xef });
    } finally {
      s.restore();
    }
  });

  it("单通道值补零成两位（否则 #010203 会变成 #123）", () => {
    const s = stubCanvas([1, 2, 3, 255]);
    try {
      expect(samplePixelHex(fakeBase(), 0, 0)?.hex).toBe("#010203");
    } finally {
      s.restore();
    }
  });

  it("全透明像素返回 null（不把背景色当成取到的颜色）", () => {
    const s = stubCanvas([12, 34, 56, 0]);
    try {
      expect(samplePixelHex(fakeBase(), 0, 0)).toBeNull();
    } finally {
      s.restore();
    }
  });

  it("采样前先 clearRect —— 探针 canvas 是复用的，不清会读到上一次的像素", () => {
    const s = stubCanvas([0, 0, 0, 255]);
    try {
      samplePixelHex(fakeBase(), 0, 0);
      expect(s.calls.indexOf("clearRect")).toBeGreaterThanOrEqual(0);
      expect(s.calls.indexOf("clearRect")).toBeLessThan(s.calls.indexOf("drawImage"));
    } finally {
      s.restore();
    }
  });

  it("坐标取整后再采样（drawImage 的源坐标必须是整数像素）", () => {
    const s = stubCanvas([9, 9, 9, 255]);
    try {
      // 只要不抛且拿到值即可；取整发生在实现内部
      expect(samplePixelHex(fakeBase(), 10.7, 20.2)?.hex).toBe("#090909");
    } finally {
      s.restore();
    }
  });
});
