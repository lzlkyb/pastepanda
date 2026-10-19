import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ToolboxView } from "@/components/ToolboxView";
import { setMotionPreference } from "@/lib/motionPreference";

const policy = vi.hoisted(() => ({ mode: "full" }));
vi.mock("@/components/MotionPolicy", () => ({ useInterfaceMotion: () => policy.mode }));
vi.mock("@/stores/appStore", () => ({ useAppStore: (selector: (s: unknown) => unknown) => selector({ config: {} }) }));
vi.mock("@/components/recsel/RecRecentList", () => ({ RecRecentList: () => null }));
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
afterEach(() => { cleanup(); vi.restoreAllMocks(); policy.mode = "full"; });

it("cancels superseded transitions and consumes hidden-window changes without replay", () => {
  setMotionPreference(true);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
  const cancel = vi.fn(), animate = vi.fn(() => ({ cancel }));
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  try {
    const { rerender } = render(<ToolboxView handlers={{}} />);
    expect(animate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: /^文本与文件/ }));
    expect(animate).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("tab", { name: /^开发与数据/ }));
    expect(animate).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledOnce();
    policy.mode = "hidden"; rerender(<ToolboxView handlers={{}} />);
    expect(cancel).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("tab", { name: /^设备连接/ }));
    expect(animate).toHaveBeenCalledTimes(2);
    policy.mode = "full"; rerender(<ToolboxView handlers={{}} />);
    expect(animate).toHaveBeenCalledTimes(2);
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, "animate", original);
    else delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  }
});
