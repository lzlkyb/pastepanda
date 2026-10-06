import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RcFileView } from "@/hooks/useRcFile";
import { RcMobileSession } from "./RcMobileSession";

const inputState = vi.hoisted(() => ({ allowed: false }));
vi.mock("./useRcMobileInput", async () => {
  const actual = await vi.importActual<typeof import("./useRcMobileInput")>("./useRcMobileInput");
  return { ...actual, useRcMobileInput: (options: Parameters<typeof actual.useRcMobileInput>[0]) => {
    inputState.allowed = options.canControl;
    return actual.useRcMobileInput(options);
  } };
});
vi.mock("@/lib/api/rcFile", () => ({ rcFileDefaultDir: async () => "/receive" }));
afterEach(() => vi.unstubAllGlobals());

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
