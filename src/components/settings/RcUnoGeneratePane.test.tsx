/**
 * RcUnoGeneratePane 首屏减负（2026-09-26 对齐稿）的守卫测试：
 * 承诺句必须如实反映即将提交的默认值；高级区改哪条，承诺句与 payload 跟到哪条。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UseRc } from "@/hooks/useRc";
import { GeneratePane } from "./RcUnoGeneratePane";

function renderPane() {
  const unoGenerate = vi.fn(async () => ({
    code: "PPU-TEST",
    full: "PPU-TEST full串",
    expires_at: Date.now() + 15 * 60_000,
  }));
  const rc = { status: { enabled: true }, unoGenerate } as unknown as UseRc;
  render(<GeneratePane rc={rc} toast={vi.fn()} onClose={vi.fn()} />);
  return unoGenerate;
}

describe("RcUnoGeneratePane 首屏减负", () => {
  it("首屏只有一句默认承诺 + 大按钮，不展开高级也能一步出码", async () => {
    const unoGenerate = renderPane();
    expect(screen.getByText(/将生成：/).textContent).toContain("15 分钟 · 用 1 次 · 可控");
    fireEvent.click(screen.getByRole("button", { name: "生成接入码" }));
    await waitFor(() =>
      expect(unoGenerate).toHaveBeenCalledWith({
      ttlSecs: 15 * 60,
      unlimited: false,
      capability: "control",
      alsoTrust: false,
    })
    );
  });

  it("高级区改时效/能力后承诺句实时更新，提交跟随", async () => {
    const unoGenerate = renderPane();
    fireEvent.click(screen.getByText("24 小时 · 不限次（装机 / 挂机，可随时撤销）"));
    fireEvent.click(screen.getByText("只看画面（对方不能动键鼠）"));
    expect(screen.getByText(/将生成：/).textContent).toContain("24 小时 · 不限次 · 只看画面");
    fireEvent.click(screen.getByRole("button", { name: "生成接入码" }));
    await waitFor(() =>
      expect(unoGenerate).toHaveBeenCalledWith({
      ttlSecs: 24 * 60 * 60,
      unlimited: true,
      capability: "view",
      alsoTrust: false,
    })
    );
  });

  it("勾免确认后承诺句带上「开免确认」", () => {
    renderPane();
    fireEvent.click(screen.getByText(/接入后给这台设备开免确认/));
    expect(screen.getByText(/将生成：/).textContent).toContain("可控 · 开免确认");
  });
});
