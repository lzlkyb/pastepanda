import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMobilePager } from "./useMobilePager";
import { reportScroll, setupPagerLayout } from "./mobilePagerTestUtils";

function Harness({ active = true }: { active?: boolean }) {
  const pager = useMobilePager(active);
  return (
    <>
      <output>{pager.tab}</output>
      <span ref={pager.selectionRef} data-testid="indicator" />
      <div ref={pager.contentRef} data-testid="pager" {...pager.events}>
        <section data-testid="vertical">
          <button onClick={() => clicks()}>业务操作</button>
        </section>
      </div>
      <button onClick={() => pager.selectTab("devices")}>设备</button>
      <button onClick={() => pager.selectTab("files")}>文件</button>
      <button onClick={() => pager.selectTab("settings")}>设置</button>
    </>
  );
}
const clicks = vi.fn();
let layout: ReturnType<typeof setupPagerLayout>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(window.matchMedia).mockImplementation((query) => ({ matches: false, media: query }) as MediaQueryList);
  layout = setupPagerLayout(true);
});
afterEach(() => {
  cleanup();
  delete document.body.dataset.mobileSheets;
  vi.clearAllTimers();
  vi.useRealTimers();
  clicks.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const pager = () => screen.getByTestId("pager");
const current = () => screen.getByRole("status").textContent;
const advance = () => act(() => vi.advanceTimersByTime(200));
const sheet = async (open: boolean) => {
  await act(async () => {
    if (open) document.body.dataset.mobileSheets = "1";
    else delete document.body.dataset.mobileSheets;
    await Promise.resolve();
  });
};

it("仅整页停止后提交，静止仍未对齐时吸附最近整页并复位 moving", () => {
  render(<Harness />);
  expect(vi.getTimerCount()).toBe(0);
  reportScroll(pager(), 170, true);
  advance();
  expect(current()).toBe("devices");
  expect(screen.getByTestId("indicator").style.getPropertyValue("--mobile-tab-offset")).toBe("42.5%");
  expect(pager().dataset.moving).toBe("true");
  advance(); // 静止超 200ms 仍未落在整页：吸附最近整页并提交，moving 不得滞留
  expect(current()).toBe("devices");
  expect(pager().dataset.moving).toBe("false");
  reportScroll(pager(), 400, true);
  expect(current()).toBe("files");
  expect(pager().dataset.moving).toBe("false");
  expect(vi.getTimerCount()).toBe(0);
});

it("没有 scrollend 的 WebView 在静止兜底后提交，连续滚动重置计时", () => {
  render(<Harness />);
  reportScroll(pager(), 200);
  act(() => vi.advanceTimersByTime(100));
  reportScroll(pager(), 400);
  act(() => vi.advanceTimersByTime(100));
  expect(current()).toBe("devices");
  advance();
  expect(current()).toBe("files");
  expect(vi.getTimerCount()).toBe(0);
});

it("相邻点击平滑、跨页即时；旧导航的 scrollend 不抢占新目标", () => {
  render(<Harness />);
  fireEvent.click(screen.getByText("文件"));
  expect(layout.scrollTo).toHaveBeenLastCalledWith({ left: 400, behavior: "smooth" });
  expect(current()).toBe("devices");
  reportScroll(pager(), 120);
  fireEvent.click(screen.getByText("设置"));
  expect(layout.scrollTo).toHaveBeenLastCalledWith({ left: 800, behavior: "instant" });
  expect(current()).toBe("settings");
  fireEvent.click(screen.getByText("文件"));
  reportScroll(pager(), 600);
  fireEvent.click(screen.getByText("设置"));
  reportScroll(pager(), 400, true);
  expect(current()).toBe("settings");
  reportScroll(pager(), 800, true);
  expect(current()).toBe("settings");
});

it("减少动态效果时相邻导航也即时完成", () => {
  vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
  render(<Harness />);
  fireEvent.click(screen.getByText("文件"));
  expect(layout.scrollTo).toHaveBeenLastCalledWith({ left: 400, behavior: "instant" });
  expect(current()).toBe("files");
});

it("手指按住时不激活，松开后才提交，滑动后的兼容点击不能触发业务", () => {
  render(<Harness />);
  fireEvent.touchStart(pager(), { touches: [{ identifier: 1 }] });
  reportScroll(pager(), 400, true);
  advance();
  expect(current()).toBe("devices");
  fireEvent.pointerCancel(pager());
  advance();
  expect(current()).toBe("devices");
  fireEvent.touchEnd(window, { touches: [] });
  advance();
  expect(current()).toBe("files");
  fireEvent.click(screen.getByText("业务操作"));
  expect(clicks).not.toHaveBeenCalled();
  fireEvent.pointerDown(screen.getByText("业务操作"));
  fireEvent.click(screen.getByText("业务操作"));
  expect(clicks).toHaveBeenCalledTimes(1);
});

it("新的原生触摸可以接管点击导航，触摸取消后允许浏览器落在实际页", () => {
  render(<Harness />);
  fireEvent.click(screen.getByText("文件"));
  reportScroll(pager(), 100);
  fireEvent.touchStart(pager(), { touches: [{ identifier: 1 }] });
  reportScroll(pager(), 0, true);
  fireEvent.touchCancel(window, { touches: [] });
  advance();
  expect(current()).toBe("devices");
  expect(pager().dataset.moving).toBe("false");
});

it("内容竖滚不影响横向分页，分页移动时拦截业务点击", () => {
  render(<Harness />);
  fireEvent.scroll(screen.getByTestId("vertical"));
  expect(pager().dataset.moving).toBe("false");
  expect(vi.getTimerCount()).toBe(0);
  reportScroll(pager(), 100);
  fireEvent.click(screen.getByText("业务操作"));
  expect(clicks).not.toHaveBeenCalled();
});

it("高度变化不重置滑动；旋转宽度变化按已提交页面重新对齐", () => {
  render(<Harness />);
  reportScroll(pager(), 400, true);
  reportScroll(pager(), 520);
  layout.scrollTo.mockClear();
  layout.resize();
  expect(layout.scrollTo).not.toHaveBeenCalled();
  expect(pager().scrollLeft).toBe(520);
  layout.resize(390.5);
  expect(pager().scrollLeft).toBe(390.5);
  expect(current()).toBe("files");
  reportScroll(pager(), 780.8, true);
  expect(current()).toBe("settings");
});

it("弹层打开取消背景滑动，弹层按钮跳转等关闭后执行", async () => {
  render(<Harness />);
  reportScroll(pager(), 200);
  await sheet(true);
  expect(pager().scrollLeft).toBe(0);
  expect(pager().dataset.moving).toBe("false");
  fireEvent.click(screen.getByText("文件"));
  expect(current()).toBe("devices");
  await sheet(false);
  expect(layout.scrollTo).toHaveBeenLastCalledWith({ left: 400, behavior: "smooth" });
  reportScroll(pager(), 400, true);
  expect(current()).toBe("files");
});

it("远控等暂停状态清除未完成及排队导航，回来保留已提交页", async () => {
  const view = render(<Harness />);
  reportScroll(pager(), 400, true);
  await sheet(true);
  fireEvent.click(screen.getByText("设置"));
  view.rerender(<Harness active={false} />);
  await sheet(false);
  fireEvent.click(screen.getByText("设备"));
  expect(current()).toBe("files");
  expect(vi.getTimerCount()).toBe(0);
  view.rerender(<Harness />);
  expect(pager().scrollLeft).toBe(400);
});

it("后台隐藏取消滚动和排队请求，卸载释放观察器和兜底计时", async () => {
  const view = render(<Harness />);
  reportScroll(pager(), 200);
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  fireEvent(document, new Event("visibilitychange"));
  expect(pager().scrollLeft).toBe(0);
  fireEvent.click(screen.getByText("文件"));
  expect(current()).toBe("devices");
  expect(vi.getTimerCount()).toBe(0);
  view.unmount();
  expect(layout.disconnect).toHaveBeenCalledTimes(1);
});
