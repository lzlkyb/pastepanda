import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionFrameState, SessionModeNotice } from "./SessionScreenNotices";
import type { RcConnectStage } from "./rcConnectStage";
afterEach(cleanup);
const pointer = { charging: false, dragging: false, scrolling: false, modeHint: "触控板 · 划动移动指针" };
const stage = (extra: Partial<RcConnectStage> = {}): RcConnectStage =>
  ({ stage: 2, pill: "", pillWarn: false, relayExtra: "", ...extra });

it("常态不持续遮住画面，拖拽、滚动和只看状态仍有明确反馈", () => {
  const view = render(<SessionModeNotice hasFrame canControl pointer={pointer} />);
  expect(screen.queryByRole("status")).toBeNull();
  view.rerender(<SessionModeNotice hasFrame canControl pointer={{ ...pointer, dragging: true }} />);
  expect(screen.getByRole("status").textContent).toContain("拖拽中");
  view.rerender(<SessionModeNotice hasFrame canControl pointer={{ ...pointer, scrolling: true }} />);
  expect(screen.getByRole("status").textContent).toContain("滚动中");
  view.rerender(<SessionModeNotice hasFrame canControl={false} pointer={pointer} />);
  expect(screen.getByRole("status").textContent).toContain("只看模式");
});

it("等待和恢复阶段说清状态，保留取消与返回入口，恢复后撤掉提示", () => {
  const onReturn = vi.fn();
  const view = render(<SessionFrameState text="电脑正在准备画面…" hasFrame={false} onReturn={onReturn} />);
  fireEvent.click(screen.getByRole("button", { name: "取消连接" }));
  expect(onReturn).toHaveBeenCalledOnce();
  view.rerender(<SessionFrameState text="正在恢复画面…" hasFrame onReturn={onReturn} />);
  expect(screen.getByRole("status").textContent).toContain("输入已暂停");
  expect(screen.getByRole("button", { name: "返回设备" })).toBeTruthy();
  view.rerender(<SessionFrameState text="" hasFrame onReturn={onReturn} />);
  expect(screen.queryByRole("status")).toBeNull();
});

it("① 甲+乙：等待期给真标水位+步进点，当前段呼吸、已过段打勾", () => {
  const onReturn = vi.fn();
  const { container } = render(<SessionFrameState text="已通知电脑，等待对方同意…" hasFrame={false} stage={stage()} onReturn={onReturn} />);
  expect(container.querySelectorAll("img[src='/icon.png']")).toHaveLength(2);
  expect(screen.getByText("拨号").closest("span")?.getAttribute("data-done")).toBe("true");
  expect(screen.getByText("批准").closest("span")?.getAttribute("data-cur")).toBe("true");
  expect(screen.getByText("起画面").closest("span")?.getAttribute("data-cur")).toBe("false");
  expect(screen.getByText("✓")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消连接" }));
  expect(onReturn).toHaveBeenCalledOnce();
});

it("① 甲+乙：路径胶囊只信机器值，中继超时话术拼在 hint 后", () => {
  const view = render(<SessionFrameState text="电脑正在准备画面…" hasFrame={false}
    stage={stage({ stage: 3, pill: "绕中继", pillWarn: true })} onReturn={vi.fn()} />);
  expect(screen.getByText("绕中继")).toBeTruthy();
  expect(screen.queryByText("经中继转发的连接出画面会慢一些")).toBeNull();
  view.rerender(<SessionFrameState text="电脑正在准备画面…" hasFrame={false} hint="首次连接要探测硬件编码器，稍慢；一直不出画面可尝试重连。"
    stage={stage({ stage: 3, pill: "绕中继", pillWarn: true, relayExtra: "经中继转发的连接出画面会慢一些；恢复直连后延时会自动回落。" })} onReturn={vi.fn()} />);
  expect(screen.getByRole("status").textContent).toContain("首次连接要探测硬件编码器");
  expect(screen.getByRole("status").textContent).toContain("经中继转发的连接出画面会慢一些");
});

it("① 甲+乙：无 stage（被控态）与已出画面都回退现役卡，不画步进点", () => {
  const view = render(<SessionFrameState text="等待对方画面…" hasFrame={false} onReturn={vi.fn()} />);
  expect(screen.queryByText("拨号")).toBeNull();
  expect(view.container.querySelector("svg")).toBeTruthy();
  view.rerender(<SessionFrameState text="正在恢复画面…" hasFrame stage={stage()} onReturn={vi.fn()} />);
  expect(screen.queryByText("拨号")).toBeNull();
  expect(screen.getByRole("button", { name: "返回设备" })).toBeTruthy();
});
