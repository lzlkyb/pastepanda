import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MobileUpdateBanner } from "./MobileUpdateBanner";
import { MobileUpdateSection } from "../settings/MobileUpdateSection";
import { useMobileUpdate, type MobileUpdate } from "./MobileUpdate";
vi.mock("./MobileUpdate", async importOriginal => ({ ...await importOriginal<typeof import("./MobileUpdate")>(), useMobileUpdate: vi.fn() }));
vi.mock("./MobileUpdateSheet", () => ({ MobileUpdateSheet: () => null }));
afterEach(cleanup);

it("更新失败不会在其他任务上弹跨页错误，但设置中仍有详情和重试入口", () => {
  vi.mocked(useMobileUpdate).mockReturnValue({ status: "error", info: null, installed: "1", progress: null, error: "网络暂不可用",
    busy: false, dismiss: vi.fn() } as unknown as MobileUpdate);
  const view = render(<MobileUpdateBanner />);
  expect(screen.queryByText("更新失败")).toBeNull();
  view.rerender(<><MobileUpdateBanner /><MobileUpdateSection /></>);
  expect(screen.getByRole("button", { name: /更新未完成.*重试/ })).toBeTruthy();
});
