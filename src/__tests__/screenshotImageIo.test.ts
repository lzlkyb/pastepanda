/**
 * lib/screenshot/imageIo 单测。
 *
 * 这几个函数原先是 ScreenshotOverlay 里的模块私有函数，一行测不了。抽出来的目的之一
 * 就是让它们可测 —— 其中两个的行为是有真实代价的：
 * - withTimeout：长截图循环里每个 IPC 都靠它。不生效的后果是「截图窗永久隐藏、
 *   全屏透明覆盖层挡着鼠标，只能杀进程」（见函数注释）。
 * - errText：Tauri invoke 抛出来的常常是**字符串**而不是 Error，直接读 .message 会得到
 *   undefined，错误提示就成了「长截图失败：undefined」。
 */

import { describe, it, expect, vi } from "vitest";
import { errText, sleep, withTimeout, canvasToDataUrl, thumbOf } from "@/lib/screenshot/imageIo";

describe("withTimeout", () => {
  it("在时限内完成则原样返回结果", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "测试")).resolves.toBe(42);
  });

  it("原样抛出被包裹 promise 的错误（不改写成超时）", async () => {
    const boom = new Error("后端拒绝");
    await expect(withTimeout(Promise.reject(boom), 1000, "测试")).rejects.toBe(boom);
  });

  it("超时则 reject，消息里带上操作名与时限", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<number>(() => {});
      const p = withTimeout(never, 3000, "截取一帧");
      const assertion = expect(p).rejects.toThrow(/截取一帧 超时（3000ms）/);
      await vi.advanceTimersByTimeAsync(3000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("提前完成会清掉定时器，不留悬挂 timer", async () => {
    vi.useFakeTimers();
    try {
      const clearSpy = vi.spyOn(window, "clearTimeout");
      await withTimeout(Promise.resolve("ok"), 5000, "测试");
      expect(clearSpy).toHaveBeenCalled();
      // 时限过去之后也不该有未处理的 rejection
      await vi.advanceTimersByTimeAsync(6000);
      expect(vi.getTimerCount()).toBe(0);
      clearSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("失败路径同样清掉定时器", async () => {
    vi.useFakeTimers();
    try {
      await withTimeout(Promise.reject(new Error("x")), 5000, "测试").catch(() => undefined);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("errText", () => {
  it("Error 取 message", () => {
    expect(errText(new Error("越界"))).toBe("越界");
  });

  it("字符串原样返回 —— Tauri invoke 抛的常常就是字符串", () => {
    expect(errText("窗口句柄失效")).toBe("窗口句柄失效");
  });

  it("其他类型退回 String()，不产出 undefined", () => {
    expect(errText(404)).toBe("404");
    expect(errText(null)).toBe("null");
    expect(errText(undefined)).toBe("undefined");
    expect(errText({ code: 5 })).toBe("[object Object]");
  });
});

describe("sleep", () => {
  it("按给定毫秒数等待", async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      void sleep(200).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(199);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("canvasToDataUrl", () => {
  /** jsdom 不实现 toBlob，这里按需桩 */
  function stubToBlob(blob: Blob | null) {
    const saved = (HTMLCanvasElement.prototype as { toBlob?: unknown }).toBlob;
    (HTMLCanvasElement.prototype as unknown as { toBlob: unknown }).toBlob = function (
      cb: (b: Blob | null) => void,
    ) {
      cb(blob);
    };
    return () => {
      (HTMLCanvasElement.prototype as unknown as { toBlob: unknown }).toBlob = saved;
    };
  }

  it("编码成 dataURL", async () => {
    const restore = stubToBlob(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
    try {
      const url = await canvasToDataUrl(document.createElement("canvas"));
      expect(url.startsWith("data:image/png;base64,")).toBe(true);
    } finally {
      restore();
    }
  });

  it("编码失败（toBlob 给 null）时 reject，不静默返回空串", async () => {
    const restore = stubToBlob(null);
    try {
      await expect(canvasToDataUrl(document.createElement("canvas"))).rejects.toThrow(
        /canvas 编码失败/,
      );
    } finally {
      restore();
    }
  });
});

describe("thumbOf", () => {
  it("canvas 拿不到 2D context 时返回 null，而不是抛", () => {
    const saved = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    try {
      expect(thumbOf(document.createElement("canvas"))).toBeNull();
    } finally {
      HTMLCanvasElement.prototype.getContext = saved;
    }
  });

  it("绘制异常也返回 null —— 缩略图失败不能影响长截图本身", () => {
    const saved = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => ({
      drawImage() {
        throw new Error("boom");
      },
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    try {
      expect(thumbOf(document.createElement("canvas"))).toBeNull();
    } finally {
      HTMLCanvasElement.prototype.getContext = saved;
    }
  });
});
