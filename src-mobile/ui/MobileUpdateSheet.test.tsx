import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi, expect, it } from "vitest";

// 只测半屏自身的逻辑（解析分组 / 状态→页脚 / 主操作触发）。
// MobileSheet 的拖拽、返回键、弹簧卸载由 MobileSheet.test 覆盖，这里透传隔离。
const ctx = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("./MobileUpdate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./MobileUpdate")>();
  return { ...actual, useMobileUpdate: () => ctx.current };
});
vi.mock("./MobileSheet", () => ({
  MobileSheet: ({ open, title, children, footer }: { open: boolean; title: string; children: React.ReactNode; footer?: React.ReactNode }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        {children}
        <div data-testid="footer">{footer}</div>
      </div>
    ) : null,
}));

import { MobileUpdateSheet } from "./MobileUpdateSheet";

const BODY = [
  "## [7.2.10] - 2026-10-06",
  "### 新增",
  "- **手机端应用内自更新**：手机上直接检查、下载、安装",
  "### 修复",
  "- **录屏时长更准**：按实际帧数计算时长",
].join("\n");

function set(partial: Record<string, unknown>) {
  ctx.current = {
    status: "available",
    info: { version: "7.2.10", body: BODY },
    installed: "7.2.9",
    progress: null,
    error: null,
    installAllowed: true,
    busy: false,
    checkNow: vi.fn(),
    startUpdate: vi.fn(),
    openInstallSettings: vi.fn(),
    clearError: vi.fn(),
    dismiss: vi.fn(),
    ...partial,
  };
}

beforeEach(() => set({}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("发现新版本：解析出分组条目（剥 ** 且标题式只显标题），主按钮触发下载", () => {
  render(<MobileUpdateSheet open onClose={() => {}} />);
  expect(screen.getByText("手机端应用内自更新")).toBeTruthy();
  expect(screen.getByText("录屏时长更准")).toBeTruthy();
  expect(screen.getByText("新增 · 1")).toBeTruthy();
  expect(screen.getByText("修复 · 1")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /下载并更新/ }));
  expect(ctx.current.startUpdate).toHaveBeenCalled();
});

it("待安装：页脚切「打开安装器」，不再显示说明卡", () => {
  set({ status: "ready" });
  render(<MobileUpdateSheet open onClose={() => {}} />);
  expect(screen.getByRole("button", { name: /打开安装器/ })).toBeTruthy();
  expect(screen.queryByText("手机端应用内自更新")).toBeNull();
});

it("需授权：无权限时主按钮走 openInstallSettings", () => {
  set({ status: "needPermission", installAllowed: false });
  render(<MobileUpdateSheet open onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: /去授权/ }));
  expect(ctx.current.openInstallSettings).toHaveBeenCalled();
});
