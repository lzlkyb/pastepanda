import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { SessionToolbarPanels } from "./SessionToolbarPanels";
import { useSessionSettings } from "./useSessionSettings";
import type { SessionToolbarProps } from "./SessionToolbar";
const api = vi.hoisted(() => ({ apply: vi.fn() }));
vi.mock("@/lib/api/rcCommands", () => ({ rcApplySetting: api.apply }));
// The panel, hook and receipt are real; modal geometry/history have separate coverage.
vi.mock("../ui/MobileSheet", () => ({ MobileSheet: ({ open, title, children, footer, onClose }: { open: boolean; title: string; children: React.ReactNode; footer: React.ReactNode; onClose: () => void }) => open ? <section role="dialog" aria-label={title} data-state="open"><button onClick={onClose}>关闭工具</button>{children}{footer}</section> : null }));
afterEach(() => { cleanup(); api.apply.mockReset(); vi.useRealTimers(); });
function Harness() {
  const settings = useSessionSettings("session"); const [open, setOpen] = useState(true);
  const props = { landscape: false, quality: settings.confirmed.quality, settings,
    onPickQuality: (value: string) => void settings.pick("quality", value), onResetZoom: vi.fn(), onToggleOrientation: vi.fn(), onRevealPointer: vi.fn() } as unknown as SessionToolbarProps;
  return <><button onClick={() => setOpen(true)}>打开工具</button>
    <SessionToolbarPanels {...props} panel={open ? "screen" : null} onClose={() => setOpen(false)} onScreen={vi.fn()} onExit={vi.fn()} onClipboard={vi.fn()} onConnection={vi.fn()} /></>;
}
it("面板关闭成功回执再打开仍保留档位，但不再占位", async () => {
  api.apply.mockResolvedValue({ status: "accepted", value: "sharp" }); render(<Harness />);
  fireEvent.click(screen.getByRole("radio", { name: "清晰" }));
  await screen.findByText("电脑已接受画质设置");
  fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
  fireEvent.click(screen.getByRole("button", { name: "关闭工具" }));
  fireEvent.click(screen.getByRole("button", { name: "打开工具" }));
  expect(screen.queryByText("电脑已接受画质设置")).toBeNull();
  expect(screen.getByRole("radio", { name: "清晰" })).toHaveAttribute("aria-checked", "true");
});
it("成功到时收起且再次打开不重现，失败不会到时消失", async () => {
  api.apply.mockResolvedValueOnce({ status: "accepted", value: "sharp" }); render(<Harness />);
  fireEvent.click(screen.getByRole("radio", { name: "清晰" })); await screen.findByText("电脑已接受画质设置");
  vi.useFakeTimers();
  // Rerendering through an event gives the visible-time hook its fake clock.
  fireEvent.click(screen.getByRole("button", { name: "关闭工具" })); fireEvent.click(screen.getByRole("button", { name: "打开工具" }));
  act(() => vi.advanceTimersByTime(4000)); expect(screen.queryByText("电脑已接受画质设置")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "关闭工具" })); fireEvent.click(screen.getByRole("button", { name: "打开工具" }));
  expect(screen.queryByText("电脑已接受画质设置")).toBeNull();
  vi.useRealTimers(); api.apply.mockRejectedValueOnce(new Error("连接中断"));
  fireEvent.click(screen.getByRole("radio", { name: "流畅" })); await waitFor(() => expect(screen.getByText("画质未能切换")).toBeVisible());
  vi.useFakeTimers(); act(() => vi.advanceTimersByTime(30000)); expect(screen.getByRole("button", { name: "重试" })).toBeVisible();
});
