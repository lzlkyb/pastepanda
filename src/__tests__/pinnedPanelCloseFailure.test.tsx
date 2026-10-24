/**
 * 🔴 批次③（2026-10-24）：贴图管理面板的失败反馈守卫。
 *
 * 改前两类静默失败：
 * 1. `closeOne/closeAll` 先改本地列表再 fire-and-forget invoke——后端关窗
 *    失败时列表里图片已消失、屏幕上贴图还在，**界面与桌面相反**（连 catch 都没有）。
 * 2. `copyOne/transformOne` 失败只 logger.warn，用户点「复制」毫无反应。
 *
 * 两条用例改前均为红。mock 配方沿用 clotheslinePinnedPanel.test.tsx。
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../stores/appStore";
import PinnedPanel from "../components/PinnedPanel";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("../components/Toast", () => ({ useToast: () => ({ toast }) }));

function mockInvoke(overrides: Record<string, (args: unknown) => unknown> = {}) {
  vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
    const hit = overrides[command];
    if (hit) return hit(args);
    return command === "list_pinned_images"
      ? ["C:/shots/a.png"]
      : command === "get_image_data_url"
        ? "data:image/png;base64,AAAA"
        : undefined;
  });
}

beforeEach(() => {
  useAppStore.getState().updateConfig({ clothesline: false });
  toast.mockReset();
  vi.mocked(invoke).mockReset();
  mockInvoke();
});

it("批次③：关闭贴图失败不得先从列表移除（改前先删 UI 再发命令，失败 = 界面与桌面相反）", async () => {
  mockInvoke({ close_pinned_image_by_path: () => { throw new Error("句柄失效"); } });
  render(<PinnedPanel open onClose={() => {}} />);
  // 🔗 先等条目渲染完再取按钮：findAllByRole 找到 1 个就返回，列表异步加载期间
  // 只有面板头的「关闭」在场，点它等于点了 onClose。
  await screen.findByText("a.png");
  // 「关闭」有两个：面板头的 aria-label 与条目内的文字按钮——点最后一个（条目按钮）
  const closeBtns = screen.getAllByRole("button", { name: "关闭" });
  fireEvent.click(closeBtns[closeBtns.length - 1]);
  await waitFor(() =>
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("关闭贴图失败"), "error"),
  );
  expect(screen.getByText("a.png"), "后端关闭失败时列表不得移除该贴图").toBeTruthy();
});

it("批次③：复制贴图失败要有反馈（改前只有 logger.warn，等于点了没反应）", async () => {
  mockInvoke({ copy_image_only: () => { throw new Error("剪贴板被占用"); } });
  render(<PinnedPanel open onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "复制" }));
  await waitFor(() =>
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("复制贴图失败"), "error"),
  );
});
