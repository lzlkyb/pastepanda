import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { RcFileView } from "@/hooks/useRcFile";
import { RcMobileSession } from "./RcMobileSession";
import type { DirectSwitchToast } from "./useDirectSwitchToast";
import type { AutoSuggestToast } from "./useAutoSuggestToast";

const inputState = vi.hoisted(() => ({ allowed: false, pointerEnabled: false }));
const notices = vi.hoisted(() => ({ direct: null as DirectSwitchToast | null, suggestion: null as AutoSuggestToast | null }));
vi.mock("./useDirectSwitchToast", () => ({ useDirectSwitchToast: () => notices.direct }));
vi.mock("./useAutoSuggestToast", () => ({ useAutoSuggestToast: () => notices.suggestion }));
vi.mock("./useRcMobileInput", async () => {
  const actual = await vi.importActual<typeof import("./useRcMobileInput")>("./useRcMobileInput");
  return { ...actual, useRcMobileInput: (options: Parameters<typeof actual.useRcMobileInput>[0]) => {
    inputState.allowed = options.canControl;
    return actual.useRcMobileInput(options);
  } };
});
vi.mock("./useSessionPointer", async () => {
  const actual = await vi.importActual<typeof import("./useSessionPointer")>("./useSessionPointer");
  return { ...actual, useSessionPointer: (options: Parameters<typeof actual.useSessionPointer>[0]) => {
    inputState.pointerEnabled = options.enabled;
    return actual.useSessionPointer(options);
  } };
});
vi.mock("@/lib/api/rcFile", () => ({ rcFileDefaultDir: async () => "/receive" }));
afterEach(() => { vi.unstubAllGlobals(); notices.direct = null; notices.suggestion = null; });

it("真实会话组件打开文件面板暂停远程输入，关闭后恢复且不结束会话", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const file = { asks: [{ id: "ask", peer: "pc", peer_name: "工作电脑", kind: "push", name: "a.txt", size: 1, first_seen_ms: Date.now() }], busy: false, error: null } as unknown as RcFileView;
  const end = vi.fn();
  render(<RcMobileSession title="工作电脑" canvasRef={{ current: null }} contentSize={{ w: 1440, h: 900 }} file={file} onEnd={end} />);
  expect(inputState.allowed).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "文件 · 1" }));
  expect(inputState.allowed).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "返回远程画面" }));
  await waitFor(() => expect(inputState.allowed).toBe(true));
  expect(end).not.toHaveBeenCalled();
});

it("连接详情暂停触控，关闭后继续控制而不结束会话", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const end = vi.fn();
  render(<RcMobileSession title="工作电脑" canvasRef={{ current: null }} contentSize={{ w: 1440, h: 900 }} onEnd={end} />);
  expect(inputState.allowed).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /连接详情/ }));
  expect(inputState.allowed).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(inputState.allowed).toBe(true));
  expect(end).not.toHaveBeenCalled();
});

it("键盘展开暂停画面手势，保留文字通道；收起释放焦点后恢复触控", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  render(<RcMobileSession title="工作电脑" canvasRef={{ current: null }} contentSize={{ w: 1440, h: 900 }} onEnd={vi.fn()} />);
  expect(inputState.pointerEnabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "键盘" }));
  const field = screen.getByRole("textbox", { name: "输入到电脑的文字" });
  expect(field).toHaveFocus();
  expect(inputState.pointerEnabled).toBe(false);
  expect(inputState.allowed).toBe(true);
  fireEvent.change(field, { target: { value: "未发送的草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "收起" }));
  await waitFor(() => expect(inputState.pointerEnabled).toBe(true));
  expect(field).not.toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "键盘" }));
  expect(field).toHaveValue("未发送的草稿");
});

it("真实会话把直连与自动画质结果单次挂在反馈区，面板关闭后恢复", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  notices.direct = { title: "已切回直连", detail: "延时会自动回落", dismiss: vi.fn() };
  notices.suggestion = { title: "链路已持续顺畅", detail: "当前画质已锁档", dismiss: vi.fn(), accept: vi.fn() };
  render(<RcMobileSession title="工作电脑" canvasRef={{ current: null }} contentSize={{ w: 1440, h: 900 }} onEnd={vi.fn()} />);
  expect(screen.getAllByText("已切回直连")).toHaveLength(1);
  expect(screen.getByText("已切回直连").closest('[class*="feedbackSlot"]')).not.toBeNull();
  expect(screen.getByText("链路已持续顺畅").closest('[class*="feedbackSlot"]')).not.toBeNull();
  expect(document.querySelector('[class*="toastHost"]')).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /连接详情/ }));
  expect(screen.queryByText("已切回直连")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(screen.getByText("已切回直连")).toBeInTheDocument());
  expect(screen.getByRole("button", { name: "切回自动" })).toBeInTheDocument();
});
