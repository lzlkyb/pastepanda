import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMobileViewport } from "./useMobileViewport";
import { useImmersiveCapsule } from "../session/useImmersiveCapsule";

class Orientation extends EventTarget { type = "portrait-primary"; }
class Viewport extends EventTarget { height = 844; offsetTop = 0; }
class Media extends EventTarget {
  matches = false;
  media = "";
  onchange = null;
  addListener() {}
  removeListener() {}
  dispatchEvent(event: Event) { return super.dispatchEvent(event); }
}
let orientation: Orientation;
let viewport: Viewport;
let coarse: Media;
let landscape: Media;
function Harness() {
  useMobileViewport();
  const capsule = useImmersiveCapsule({ keyboardOpen: false });
  return <output>{capsule.landscape ? "横屏" : "竖屏"}</output>;
}
beforeEach(() => {
  orientation = new Orientation();
  viewport = new Viewport();
  coarse = new Media(); coarse.matches = true;
  landscape = new Media();
  vi.stubGlobal("screen", { orientation, height: 844 });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerHeight", 844);
  vi.stubGlobal("matchMedia", (query: string) => query === "(pointer: coarse)" ? coarse : landscape);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("输入法缩小视口不会把竖屏页面和会话工具改成横屏", () => {
  render(<Harness />);
  expect(screen.getByText("竖屏")).toBeTruthy();
  act(() => {
    landscape.matches = true;
    landscape.dispatchEvent(new Event("change"));
    viewport.height = 430; viewport.offsetTop = 12;
    viewport.dispatchEvent(new Event("resize"));
  });
  expect(document.documentElement.dataset.mobileLayout).toBe("portrait");
  expect(document.documentElement.dataset.mobileKeyboard).toBe("true");
  expect(document.documentElement.style.getPropertyValue("--mobile-viewport-height")).toBe("430px");
  expect(document.documentElement.style.getPropertyValue("--mobile-viewport-top")).toBe("12px");
  expect(screen.getByText("竖屏")).toBeTruthy();
  act(() => { viewport.height = 844; viewport.dispatchEvent(new Event("resize")); });
  expect(document.documentElement.dataset.mobileKeyboard).toBe("false");
});

it("设备真实旋转时页面和远程工具使用同一个方向", () => {
  render(<Harness />);
  act(() => {
    orientation.type = "landscape-primary";
    viewport.height = 390;
    vi.stubGlobal("innerHeight", 390);
    orientation.dispatchEvent(new Event("change"));
  });
  expect(document.documentElement.dataset.mobileLayout).toBe("landscape");
  expect(document.documentElement.dataset.mobileKeyboard).toBe("false");
  expect(screen.getByText("横屏")).toBeTruthy();
});

it("无屏幕方向 API 的浏览器沿用布局方向，卸载释放标记和监听", () => {
  coarse.matches = false;
  const view = render(<Harness />);
  act(() => { landscape.matches = true; landscape.dispatchEvent(new Event("change")); });
  expect(screen.getByText("横屏")).toBeTruthy();
  view.unmount();
  viewport.height = 100;
  viewport.dispatchEvent(new Event("resize"));
  expect(document.documentElement.dataset.mobileLayout).toBeUndefined();
  expect(document.documentElement.style.getPropertyValue("--mobile-viewport-height")).toBe("");
});

it("旧移动浏览器可使用系统 orientation，缺少 visualViewport 也有可视高度", () => {
  vi.stubGlobal("screen", { height: 844 });
  vi.stubGlobal("orientation", 90);
  vi.stubGlobal("visualViewport", undefined);
  render(<Harness />);
  expect(screen.getByText("横屏")).toBeTruthy();
  expect(document.documentElement.style.getPropertyValue("--mobile-viewport-height")).toBe("844px");
});
