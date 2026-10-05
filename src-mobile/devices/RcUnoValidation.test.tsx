import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { UseRc } from "@/hooks/useRc";
import { RcUnoJoinCard } from "./RcUnoJoinCard";

it("两种凭证模式都显示真实目标；无效密码说明原因，显隐不改变值", () => {
  const requestPass = vi.fn().mockResolvedValue(true);
  const rc = { targets: [{ node_id: "pc", name: "工作电脑", os: "windows" }], identity: { node_id: "phone" }, requestPass } as unknown as UseRc;
  render(<RcUnoJoinCard rc={rc} fixedTarget="pc" onClose={vi.fn()} onConnected={vi.fn()} />);
  expect(screen.getByText(/连接对象：工作电脑/)).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: /固定密码/ }));
  const input = screen.getByLabelText("对方的固定密码");
  fireEvent.change(input, { target: { value: "123" } });
  expect(screen.getByText(/密码长度不符合要求/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "连接" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "显示密码" }));
  expect(input).toHaveAttribute("type", "text");
  expect(input).toHaveValue("123");
  fireEvent.change(input, { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "连接" }));
  expect(requestPass).toHaveBeenCalledWith("pc", "123456", "control");
});
