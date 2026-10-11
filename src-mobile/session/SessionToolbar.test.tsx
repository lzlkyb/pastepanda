import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { SessionToolbar } from "./SessionToolbar";
import type { MobileQuality } from "./qualityCycle";
import type { useSessionClipboard } from "./useSessionClipboard";

const clipboardStub = () =>
  ({
    feedback: null,
    hint: "",
    clipOpen: false,
    toggleClip: vi.fn(),
    openClip: vi.fn(),
    push: vi.fn(),
    pull: vi.fn(),
    retry: vi.fn(),
    dismiss: vi.fn(),
    busy: false,
  }) as unknown as ReturnType<typeof useSessionClipboard>;

const props = () => ({
  landscape: false,
  visible: true,
  keyboardOn: false,
  onToggleKeyboard: vi.fn(),
  onResetZoom: vi.fn(),
  quality: "balanced" as MobileQuality,
  onPickQuality: vi.fn(),
  audioOn: false,
  onToggleAudio: vi.fn(),
  onToggleOrientation: vi.fn(),
  clipboard: clipboardStub(),
  onEnd: vi.fn(),
});
afterEach(async () => {
  cleanup();
  await waitFor(() => expect(history.state?.mobileBackLayer).toBeUndefined());
});
it("更多进入画面后返回仍回更多，关闭全部回画面", async () => {
  render(<SessionToolbar {...props()} />);
  fireEvent.click(screen.getByRole("button", { name: "更多" }));
  fireEvent.click(screen.getByRole("button", { name: "画面与画质" }));
  fireEvent.click(screen.getByRole("button", { name: "返回" }));
  await waitFor(() => expect(screen.getByRole("dialog", { name: "更多" })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
it("横屏失败回执不属于工具滚动区域", () => {
  render(<SessionToolbar {...props()} landscape feedbackEntry={<p>画质未能切换</p>} />);
  expect(screen.getByText("画质未能切换").closest('[class*="toolRailScroll"]')).toBeNull();
});

it("批准前退出直接取消申请，失败才出现重试入口", () => {
  const p = props();
  const view = render(<SessionToolbar {...p} landscape waiting />);
  fireEvent.click(screen.getByRole("button", { name: "取消申请" }));
  expect(p.onEnd).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "确认断开" })).toBeNull();
  view.rerender(<SessionToolbar {...p} landscape waiting endError="取消失败" />);
  fireEvent.click(screen.getByRole("button", { name: "重试取消申请" }));
  expect(p.onEnd).toHaveBeenCalledTimes(2);
});

it("断开必须明确确认，失败仍留在确认面板", async () => {
  const p = props();
  const view = render(<SessionToolbar {...p} />);
  fireEvent.click(screen.getByRole("button", { name: "更多" }));
  fireEvent.click(screen.getByRole("button", { name: "断开连接" }));
  expect(p.onEnd).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认断开" }));
  expect(p.onEnd).toHaveBeenCalledTimes(1);
  view.rerender(<SessionToolbar {...p} endError="断开失败" />);
  expect(screen.getByRole("alert").textContent).toContain("断开失败");
  expect(screen.getByRole("button", { name: "继续连接" })).toBeTruthy();
});

it("只看模式不提供可点击键盘与剪贴板入口", () => {
  render(<SessionToolbar {...props()} canControl={false} />);
  expect(screen.getByRole("button", { name: "键盘" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "触控板" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "更多" }));
  expect(screen.getByRole("button", { name: "剪贴板" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "画面与画质" })).not.toBeDisabled();
});

it("画质选项发送所选档位而不是盲目循环", () => {
  const p = props();
  render(<SessionToolbar {...p} />);
  fireEvent.click(screen.getByRole("button", { name: "更多" }));
  fireEvent.click(screen.getByRole("button", { name: "画面与画质" }));
  fireEvent.click(screen.getByRole("radio", { name: "清晰" }));
  expect(p.onPickQuality).toHaveBeenCalledWith("sharp");
  expect(screen.getByRole("radio", { name: "均衡" })).toHaveAttribute("aria-checked", "true");
});

it("画质面板先讲清锁档语义，锁档/自动/未确认各有可见状态", () => {
  const p = props();
  const view = render(<SessionToolbar {...p} />);
  fireEvent.click(screen.getByRole("button", { name: "更多" }));
  fireEvent.click(screen.getByRole("button", { name: "画面与画质" }));
  // 语义必须先于第一次点击可见：点实名档会整场关掉电脑自动档（复测 B 的误触陷阱）。
  expect(screen.getByText(/锁档并关闭电脑自动档/)).toBeInTheDocument();
  expect(screen.getByText(/已锁档「均衡」：电脑自动档已关闭/)).toBeInTheDocument();
  view.rerender(<SessionToolbar {...p} quality="auto" />);
  expect(screen.getByText(/电脑正按网络状况自动换档/)).toBeInTheDocument();
  expect(screen.queryByText(/已锁档「均衡」/)).toBeNull();
  view.rerender(<SessionToolbar {...p} quality={null} />);
  expect(screen.getByText(/尚未确认/)).toBeInTheDocument();
});

it("横屏收起仍有可见工具入口，键盘展开替换工具栏", () => {
  const reveal = vi.fn();
  const p = props();
  const view = render(<SessionToolbar {...p} landscape visible={false} onRevealTools={reveal} />);
  expect(screen.queryByRole("navigation", { name: "会话工具" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "工具" }));
  expect(reveal).toHaveBeenCalledOnce();
  view.rerender(<SessionToolbar {...p} keyboardOn />);
  expect(screen.queryByRole("navigation", { name: "会话工具" })).toBeNull();
});

it("紧凑横屏隐藏辅助操作，展开后恢复；沉浸入口能重新打开工具", () => {
  const p = props(); const restore = vi.fn(); const immersive = vi.fn();
  const view = render(<SessionToolbar {...p} landscape visible={false} mouseAssist={<button>左键</button>} onImmersive={immersive} />);
  expect(screen.queryByRole("button", { name: "左键" })).toBeNull();
  expect(screen.getByRole("button", { name: "工具" })).toHaveAttribute("aria-expanded", "false");
  view.rerender(<SessionToolbar {...p} landscape visible mouseAssist={<button>左键</button>} onImmersive={immersive} />);
  expect(screen.getByRole("button", { name: "左键" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "沉浸画面" })); expect(immersive).toHaveBeenCalledOnce();
  view.rerender(<SessionToolbar {...p} landscape visible={false} immersive onRestoreTools={restore} />);
  expect(screen.queryByRole("button", { name: "退出" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "工具" })); expect(restore).toHaveBeenCalledOnce();
});

it("横屏退出在收起、请求和键盘状态下始终可达，并保留二次确认", () => {
  const p = props();
  const view = render(<SessionToolbar {...p} landscape visible={false} fileEntry={<button>文件 · 3</button>} feedbackEntry={<p>画质未能切换</p>} />);
  expect(screen.getByRole("button", { name: "退出" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "文件 · 3" })).toBeInTheDocument();
  expect(screen.getByText("画质未能切换")).toBeInTheDocument();
  view.rerender(<SessionToolbar {...p} landscape visible={false} keyboardOn />);
  fireEvent.click(screen.getByRole("button", { name: "退出" }));
  expect(p.onToggleKeyboard).toHaveBeenCalledOnce();
  expect(p.onEnd).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "断开连接？" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "确认断开" }));
  expect(p.onEnd).toHaveBeenCalledOnce();
});

it("横屏工具栏直接打开画面，两次点击即可适应屏幕", () => {
  const p = props();
  render(<SessionToolbar {...p} landscape />);
  fireEvent.click(screen.getByRole("button", { name: "画面" }));
  fireEvent.click(screen.getByRole("button", { name: "适应屏幕" }));
  expect(p.onResetZoom).toHaveBeenCalledOnce();
});

it("更多可直达连接详情，横屏收起工具后仍保留延时入口", () => {
  const details = vi.fn();
  const p = props();
  const view = render(<SessionToolbar {...p} landscape onConnectionDetails={details} connectionEntry={<button>延时 36 ms</button>} />);
  expect(screen.getByRole("button", { name: "延时 36 ms" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "更多" }));
  fireEvent.click(screen.getByRole("button", { name: "连接详情" }));
  expect(details).toHaveBeenCalledOnce();
  view.rerender(<SessionToolbar {...p} landscape visible={false} connectionEntry={<button>延时 36 ms</button>} />);
  expect(screen.getByRole("button", { name: "延时 36 ms" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "工具" })).toBeInTheDocument();
});

it("横屏首次引导：收起态把手脉冲+气泡，展开或未引导时不出现", () => {
  const p = props();
  const view = render(<SessionToolbar {...p} landscape visible={false} toolHint />);
  expect(screen.getByRole("button", { name: "工具" }).className).toContain("toolHandlePulse");
  expect(screen.getByText("画面、键盘、画质工具都收在这里")).toBeInTheDocument();
  view.rerender(<SessionToolbar {...p} landscape visible toolHint />);
  expect(screen.queryByText("画面、键盘、画质工具都收在这里")).toBeNull();
  view.rerender(<SessionToolbar {...p} landscape visible={false} />);
  expect(screen.queryByText("画面、键盘、画质工具都收在这里")).toBeNull();
  expect(screen.getByRole("button", { name: "工具" }).className).not.toContain("toolHandlePulse");
});

it("四种操作方式可直接选择，选择后关闭面板，恢复默认有明确入口", async () => {
  const choose = vi.fn();
  const p = props();
  const view = render(<SessionToolbar {...p} onPointerMode={choose} />);
  fireEvent.click(screen.getByRole("button", { name: "触控板" }));
  expect(screen.getByRole("dialog", { name: "操作方式" })).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: /触控板 · 推荐默认/ })).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("radio", { name: /直接点击.*点哪里/ })).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: /独立触控板.*上方/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: /浮动鼠标.*拖动/ }));
  expect(choose).toHaveBeenCalledWith("floating");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  view.rerender(<SessionToolbar {...p} pointerMode="floating" onPointerMode={choose} />);
  fireEvent.click(screen.getByRole("button", { name: "浮动鼠标" }));
  expect(screen.queryByText("辅助选项")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "恢复推荐默认" }));
  expect(choose).toHaveBeenLastCalledWith("trackpad");
});
