import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import * as assets from "@/lib/api/mobileKnowledgeAssets";
import { KnowledgeAssetSheet } from "./KnowledgeAssetSheet";
import type { ReactNode } from "react";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/api/mobileKnowledgeAssets", () => ({ mobileKnowledgeAssetFetch: vi.fn(), mobileKnowledgeAssetCancel: vi.fn() }));
vi.mock("../ui/MobileSheet", () => ({ MobileSheet: ({ open, children, footer, actions }: { open: boolean; children: ReactNode; footer: ReactNode; actions: ReactNode }) => open ? <aside role="dialog">{children}<div data-testid="feedback">{footer}</div><div data-testid="actions">{actions}</div></aside> : null }));
const target = { noteId: "note", src: "pp-asset:0123456789abcdef0123456789abcdef.png" };
const devices = [{ node_id: "knowledge-peer", name: "知识库电脑", paused: false }];
let syncEnabled = true;
beforeEach(() => {
  vi.clearAllMocks(); syncEnabled = true;
  vi.mocked(invoke).mockImplementation(async command => command === "kb_sync_devices" ? { devices } : syncEnabled);
  vi.mocked(assets.mobileKnowledgeAssetCancel).mockResolvedValue();
  vi.mocked(assets.mobileKnowledgeAssetFetch).mockResolvedValue({ src: target.src, bytes: 20, peer: "knowledge-peer", already_local: false });
});
afterEach(() => cleanup());
it("does not download when opening; manual request uses only an authorized knowledge peer", async () => {
  const loaded = vi.fn();
  const close = vi.fn();
  render(<KnowledgeAssetSheet target={target} active onClose={close} onLoaded={loaded} />);
  await waitFor(() => expect((screen.getByRole("button", { name: "取得这张图片" }) as HTMLButtonElement).disabled).toBe(false));
  expect(assets.mobileKnowledgeAssetFetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "取得这张图片" }));
  await screen.findByText("图片已保存到手机");
  expect(assets.mobileKnowledgeAssetFetch).toHaveBeenCalledWith(expect.any(String), "knowledge-peer", "note", target.src);
  expect(loaded).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "返回正文" }));
  expect(close).toHaveBeenCalledTimes(1);
  expect(assets.mobileKnowledgeAssetFetch).toHaveBeenCalledTimes(1);
});
it("unsupported peer shows the recovery path, keeps content and generates a new retry identity", async () => {
  vi.mocked(assets.mobileKnowledgeAssetFetch).mockRejectedValue({ code: "unsupported", message: "private/path" });
  render(<KnowledgeAssetSheet target={target} active onClose={vi.fn()} onLoaded={vi.fn()} />);
  await waitFor(() => expect((screen.getByRole("button", { name: "取得这张图片" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "取得这张图片" }));
  await screen.findByText(/请升级电脑，或在同步面板运行一次正常同步/);
  expect(document.body.textContent).not.toContain("private/path");
  fireEvent.click(screen.getByRole("button", { name: "取得这张图片" }));
  await waitFor(() => expect(assets.mobileKnowledgeAssetFetch).toHaveBeenCalledTimes(2));
  expect(vi.mocked(assets.mobileKnowledgeAssetFetch).mock.calls[0][0]).not.toBe(vi.mocked(assets.mobileKnowledgeAssetFetch).mock.calls[1][0]);
});
it("leaving cancels the exact in-flight request and a late result cannot update the new page", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof assets.mobileKnowledgeAssetFetch>>) => void;
  vi.mocked(assets.mobileKnowledgeAssetFetch).mockImplementation(() => new Promise(r => { resolve = r; }));
  const loaded = vi.fn();
  const page = render(<KnowledgeAssetSheet target={target} active onClose={vi.fn()} onLoaded={loaded} />);
  await waitFor(() => expect((screen.getByRole("button", { name: "取得这张图片" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "取得这张图片" }));
  const id = vi.mocked(assets.mobileKnowledgeAssetFetch).mock.calls[0][0];
  page.rerender(<KnowledgeAssetSheet target={target} active={false} onClose={vi.fn()} onLoaded={loaded} />);
  expect(assets.mobileKnowledgeAssetCancel).toHaveBeenCalledWith(id);
  await act(async () => resolve({ src: target.src, bytes: 20, peer: "knowledge-peer", already_local: false }));
  expect(loaded).not.toHaveBeenCalled();
});
it("disabled knowledge sync does not use remote-control pairing as a fallback", async () => {
  syncEnabled = false;
  render(<KnowledgeAssetSheet target={target} active onClose={vi.fn()} onLoaded={vi.fn()} />);
  await screen.findByText("知识库同步已关闭");
  fireEvent.click(screen.getByRole("button", { name: "取得这张图片" }));
  expect(assets.mobileKnowledgeAssetFetch).not.toHaveBeenCalled();
});

it("failed authorization reads never claim sync is off or there are no computers; retry recovers", async () => {
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "kb_sync_devices") throw new Error("offline");
    return true;
  });
  render(<KnowledgeAssetSheet target={target} active onClose={vi.fn()} onLoaded={vi.fn()} />);
  await screen.findByText("知识库电脑未能读取");
  expect(screen.queryByText("知识库同步已关闭")).toBeNull();
  expect(screen.queryByText("尚未连接知识库电脑")).toBeNull();
  const retry = screen.getByRole("button", { name: "重新读取电脑" });
  expect(screen.getByTestId("actions").contains(retry)).toBe(true);
  vi.mocked(invoke).mockImplementation(async command => command === "kb_sync_devices" ? { devices } : true);
  fireEvent.click(retry);
  await waitFor(() => expect((screen.getByRole("button", { name: "取得这张图片" }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByTestId("actions").contains(screen.getByRole("button", { name: "取得这张图片" }))).toBe(true);
});
