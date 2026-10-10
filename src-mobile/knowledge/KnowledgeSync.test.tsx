import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { KnowledgeSync } from "./KnowledgeSync";

vi.mock("../ui/MobileSheet", () => ({
  MobileSheet: ({
    open,
    title,
    children,
    footer,
    onClose,
  }: {
    open: boolean;
    title: string;
    children: ReactNode;
    footer: ReactNode;
    onClose: () => void;
  }) =>
    open ? (
      <section role="dialog" aria-label={title}>
        <button onClick={onClose}>关闭</button>
        {children}
        {footer}
      </section>
    ) : null,
}));
const pc = { node_id: "pc", name: "My PC", paused: false };
let devices: (typeof pc)[];
beforeEach(() => {
  devices = [];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "kb_sync_devices") return { devices, last: [], conflict_backlog: 0 };
    if (command === "rc_sync_offers") return [{ node_id: "pc", name: "My PC", paired_at: "today" }];
    if (command === "get_kb_sync_status") return false;
    if (command === "kb_sync_allow_from_rc") devices = [pc];
    return undefined;
  });
});
afterEach(() => cleanup());

it("the authorization action requires an explicit full-library consent and preserves its visible result after closing", async () => {
  render(<KnowledgeSync active />);
  await waitFor(() => expect(screen.getByRole("button", { name: /仅本机使用/ })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: /仅本机使用/ }));
  fireEvent.click(await screen.findByRole("radio", { name: /My PC/ }));
  expect(screen.getByText(/当前无法预先取得电脑资料数量/)).toBeTruthy();
  const authorize = screen.getByRole("button", { name: "授权并开启同步" });
  expect(authorize.hasAttribute("disabled")).toBe(true);
  expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === "kb_sync_allow_from_rc")).toBe(false);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(authorize);
  await waitFor(() => expect(screen.getAllByText("已授权并开启同步").length).toBeGreaterThan(0));
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(screen.getByRole("status").textContent).toContain("已授权并开启同步");
});

it("an existing authorization suppresses another-computer selection", async () => {
  devices = [pc];
  render(<KnowledgeSync active />);
  await waitFor(() => expect(screen.getByRole("button", { name: /同步已关闭/ })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: /同步已关闭/ }));
  expect(screen.queryByRole("radio", { name: /My PC/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "授权并开启同步" })).toBeNull();
  expect(screen.getByRole("button", { name: "取消并暂停同步" })).toBeTruthy();
});

it("refresh feedback does not replace the persistent authorization status and can be dismissed", async () => {
  render(<KnowledgeSync active />);
  fireEvent.click(await screen.findByRole("button", { name: /仅本机使用/ }));
  fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));
  await screen.findByText("同步状态已刷新");
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(screen.getByRole("button", { name: /仅本机使用/ })).toBeTruthy();
  expect(screen.getAllByText("同步状态已刷新")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
  expect(screen.queryByText("同步状态已刷新")).toBeNull();
  expect(screen.getByRole("button", { name: /仅本机使用/ })).toBeTruthy();
});
