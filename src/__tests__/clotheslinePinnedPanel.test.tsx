import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../stores/appStore";
import PinnedPanel from "../components/PinnedPanel";
const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("../components/Toast", () => ({ useToast: () => ({ toast }) }));
beforeEach(() => {
  useAppStore.getState().updateConfig({ clothesline: true });
  toast.mockReset();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "list_pinned_images"
      ? ["C:/shots/a.png"]
      : command === "get_image_data_url"
        ? "data:image/png;base64,AAAA"
        : undefined,
  );
});
it("关闭晾衣绳时挂回禁用，仍保留原有贴图管理操作", async () => {
  useAppStore.getState().updateConfig({ clothesline: false });
  render(<PinnedPanel open onClose={() => {}} />);
  const button = await screen.findByRole("button", { name: "挂回" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "复制" })).toBeTruthy();
});
it("挂回失败不移除贴图，反馈可见并恢复重试按钮", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "clothesline_hang_path") throw new Error("接收失败");
    return command === "list_pinned_images" ? ["C:/shots/a.png"] : undefined;
  });
  render(<PinnedPanel open onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "挂回" }));
  await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining("原贴图保留"), "error"));
  expect(screen.getByText("a.png")).toBeTruthy();
  expect((screen.getByRole("button", { name: "挂回" }) as HTMLButtonElement).disabled).toBe(false);
});
