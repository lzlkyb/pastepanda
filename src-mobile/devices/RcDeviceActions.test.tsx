import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { UseRc } from "@/hooks/useRc";
import type { RcTargetDevice } from "@/lib/api/rc";
import { RcDeviceActions } from "./RcDeviceActions";

function setup() {
  const request = vi.fn(() => new Promise<boolean>(() => {}));
  const forget = vi.fn(() => new Promise<boolean>(() => {}));
  const rc = { request, forget, busy: false, reachability: {}, status: { running: true, enabled: true } } as unknown as UseRc;
  const target = { node_id: "pc", name: "工作电脑", os: "windows", presence: "live" } as RcTargetDevice;
  render(<RcDeviceActions rc={rc} target={target} onClose={vi.fn()} onSendFiles={vi.fn()} onUno={vi.fn()} />);
  return { request, forget };
}
it("申请观看只改变观看按钮，并阻止切换到其他动作", () => {
  const { request } = setup();
  fireEvent.click(screen.getByRole("button", { name: "只看画面" }));
  expect(request).toHaveBeenCalledWith("pc", "view");
  expect(screen.getByRole("button", { name: "正在申请观看…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "远程控制" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "传文件" })).toBeDisabled();
});
it("解除配对在管理中二次确认，提交后不能假装保留", () => {
  const { forget } = setup();
  expect(screen.queryByRole("button", { name: "解除配对" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "管理设备" }));
  fireEvent.click(screen.getByRole("button", { name: "解除配对" }));
  expect(forget).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认解除配对" }));
  expect(forget).toHaveBeenCalledWith("pc");
  expect(screen.getByRole("button", { name: "保留设备" })).toBeDisabled();
});
