import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RcCodecChoice } from "./RcCodecChoice";
import type { RcCodecChoice as Choice } from "@/hooks/useRcCodecChoice";
const choice: Choice = {
  options: [{ key: "h264", label: "H.264", tip: "兼容" }, { key: "av1", label: "AV1", tip: "软件解码" }],
  value: "av1", actualLabel: "H.264", pending: false, disabled: false, mac: true, pick: vi.fn(async () => {}),
};
describe("编码菜单的可见反馈", () => {
  it("请求和实际接收分开显示；纯鼠标能选择 H.264", () => {
    render(<RcCodecChoice choice={choice} />);
    expect(screen.getByRole("status").textContent).toContain("实际接收：H.264");
    expect(screen.getByText(/软件接收最高/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /编码/ }));
    fireEvent.click(screen.getByRole("option", { name: /H.264/ }));
    expect(choice.pick).toHaveBeenCalledWith("h264");
  });
  it("切换期间禁用下拉，并保留实际帧编码", () => {
    render(<RcCodecChoice choice={{ ...choice, pending: true, disabled: true }} />);
    expect((screen.getByRole("button", { name: /编码/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("正在切换 · 实际接收：H.264");
  });
});
