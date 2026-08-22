/**
 * ScreenshotOverlay · 放大镜 + 取色回归测试。
 *
 * 这一块是批 2 要提取成 useMagnifier 的目标（66 行、零 useState、全靠 ref），
 * 所以它的行为必须先被钉住：显示时机、hex 取值、复制出口、隐藏时机。
 *
 * 取色值来自 getImageData，夹具里可用 setProbePixel 指定，因此 hex 是可断言的确定值。
 *
 * hex 统一为**大写**：放大镜与吸管现在共用 lib/screenshot/pixelProbe，
 * 不再是「同一个像素两个入口给出不同字符串」（放大镜曾是小写）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fireEvent, cleanup } from "@testing-library/react";
import {
  setupShotEnv,
  cleanupShotEnv,
  renderOverlay,
  flush,
  setProbePixel,
  shotRoot,
  q,
  type ShotEnv,
} from "./helpers/shotHarness";

let env: ShotEnv;

beforeEach(() => {
  env = setupShotEnv();
});

afterEach(() => {
  cleanup();
  cleanupShotEnv();
});

const magView = () => q(".mag-view")!;
const magInfo = () => q(".mag-info")!;

describe("显示时机", () => {
  it("初始隐藏", async () => {
    await renderOverlay();
    expect(magView().style.display).toBe("none");
  });

  it("拖选过程中显示", async () => {
    await renderOverlay();

    fireEvent.mouseDown(shotRoot(), { clientX: 300, clientY: 300 });
    fireEvent.mouseMove(shotRoot(), { clientX: 420, clientY: 400 });
    await flush(1);

    expect(magView().style.display).toBe("flex");
  });

  it("松手后隐藏", async () => {
    await renderOverlay();

    fireEvent.mouseDown(shotRoot(), { clientX: 300, clientY: 300 });
    fireEvent.mouseMove(shotRoot(), { clientX: 420, clientY: 400 });
    await flush(1);
    expect(magView().style.display).toBe("flex");

    fireEvent.mouseUp(shotRoot());
    await flush(1);
    expect(magView().style.display).toBe("none");
  });

  it("未按下时移动鼠标不显示（只在拖选时跟随）", async () => {
    await renderOverlay();

    fireEvent.mouseMove(shotRoot(), { clientX: 500, clientY: 500 });
    await flush(1);

    expect(magView().style.display).toBe("none");
  });
});

describe("取色", () => {
  it("信息条显示 RGB 与 hex", async () => {
    setProbePixel(0x12, 0x34, 0x56);
    await renderOverlay();

    fireEvent.mouseDown(shotRoot(), { clientX: 300, clientY: 300 });
    fireEvent.mouseMove(shotRoot(), { clientX: 420, clientY: 400 });
    await flush(1);

    const html = magInfo().innerHTML;
    expect(html).toContain("RGB(18, 52, 86)");
    expect(html).toContain("#123456");
    expect(html).toContain("点击复制");
  });

  it("单通道值补零成两位十六进制", async () => {
    setProbePixel(1, 2, 3);
    await renderOverlay();

    fireEvent.mouseDown(shotRoot(), { clientX: 300, clientY: 300 });
    fireEvent.mouseMove(shotRoot(), { clientX: 420, clientY: 400 });
    await flush(1);

    // 不补零会得到 "#123"，与 #010203 是完全不同的颜色
    expect(magInfo().innerHTML).toContain("#010203");
  });

  it("点放大镜复制当前 hex", async () => {
    setProbePixel(0xab, 0xcd, 0xef);
    await renderOverlay();

    fireEvent.mouseDown(shotRoot(), { clientX: 300, clientY: 300 });
    fireEvent.mouseMove(shotRoot(), { clientX: 420, clientY: 400 });
    await flush(1);

    fireEvent.click(magView());
    await flush(1);

    expect(env.countInvoke("copy_only")).toBe(1);
    expect(env.lastArgs("copy_only")).toEqual({ text: "#ABCDEF" });
    expect(magInfo().innerHTML).toContain("已复制 #ABCDEF");
  });

  it("复制失败不影响界面（不抛到顶层）", async () => {
    env.failCommand("copy_only", "剪贴板被占用");
    await renderOverlay();

    fireEvent.mouseDown(shotRoot(), { clientX: 300, clientY: 300 });
    fireEvent.mouseMove(shotRoot(), { clientX: 420, clientY: 400 });
    await flush(1);

    fireEvent.click(magView());
    await flush(1);

    // 仍然活着，放大镜还在
    expect(q(".shot-root")).toBeTruthy();
    expect(magView().style.display).toBe("flex");
  });
});

describe("跟随定位", () => {
  it("默认落在光标右上方", async () => {
    await renderOverlay();

    fireEvent.mouseDown(shotRoot(), { clientX: 500, clientY: 500 });
    fireEvent.mouseMove(shotRoot(), { clientX: 600, clientY: 600 });
    await flush(1);

    // MAG_SIZE = 30*2*4 = 240，dpr=1 → cssSize 240
    // left = 600 + 18 = 618；top = 600 - 240 - 10 = 350
    expect(magView().style.left).toBe("618px");
    expect(magView().style.top).toBe("350px");
  });

  it("贴近右边缘时翻到光标左侧", async () => {
    // jsdom 默认 window.innerWidth = 1024
    await renderOverlay();

    fireEvent.mouseDown(shotRoot(), { clientX: 900, clientY: 500 });
    fireEvent.mouseMove(shotRoot(), { clientX: 950, clientY: 500 });
    await flush(1);

    // 950 + 240 + 10 > 1024 → 翻到左侧：950 - 240 - 18 = 692
    expect(magView().style.left).toBe("692px");
  });

  it("贴近上边缘时翻到光标下方", async () => {
    await renderOverlay();

    fireEvent.mouseDown(shotRoot(), { clientX: 500, clientY: 20 });
    fireEvent.mouseMove(shotRoot(), { clientX: 520, clientY: 30 });
    await flush(1);

    // top = 30 - 240 - 10 < 10 → 翻到下方：30 + 18 = 48
    expect(magView().style.top).toBe("48px");
  });
});
