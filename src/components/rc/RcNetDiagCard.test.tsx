import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { rcNetDiag } from "@/lib/api/rcNetDiag";
import { RcNetDiagCard } from "./RcNetDiagCard";

// 只替掉取数，判定/文案仍用真实实现（punchSummary / mappingLabel 的口径不该被测试重写）
vi.mock("@/lib/api/rcNetDiag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/rcNetDiag")>()),
  rcNetDiag: vi.fn(),
}));

afterEach(() => cleanup());

it("a failed probe is reported in the card instead of silently keeping the old state", async () => {
  vi.mocked(rcNetDiag).mockRejectedValue(new Error("探测服务未就绪"));
  render(<RcNetDiagCard />);
  fireEvent.click(screen.getByRole("button", { name: /网络诊断/ }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("网络诊断读取失败");
  expect(alert.textContent).toContain("探测服务未就绪");
  // 失败时不许再冒充「报告还没生成」（原来的静态占位文案）
  expect(screen.queryByText(/报告还没生成/)).toBeNull();
});
