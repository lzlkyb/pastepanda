import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { UseRc } from "@/hooks/useRc";
import { RcUnoJoinCard } from "./RcUnoJoinCard";

function renderCard(requestPass = vi.fn().mockResolvedValue(true)) {
  const onClose = vi.fn();
  const rc = {
    targets: [{ node_id: "pc", name: "工作电脑" }],
    identity: { node_id: "phone" },
    requestUno: vi.fn().mockResolvedValue(true),
    requestPass,
  } as unknown as UseRc;
  render(<RcUnoJoinCard rc={rc} fixedTarget="pc" onClose={onClose} onConnected={vi.fn()} />);
  return { rc, onClose };
}

describe("无人值守字段反馈时机", () => {
  it("接入码未完成时只显示关联帮助，失焦才标记错误，继续输入即回到中性态", () => {
    const { rc } = renderCard();
    const input = screen.getByLabelText("无人值守接入码");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "7K2" } });
    expect(screen.queryByText(/认不出无人值守码/)).toBeNull();
    expect(input).toHaveAttribute("aria-invalid", "false");
    const hintId = input.getAttribute("aria-describedby");
    expect(hintId).toBeTruthy();
    expect(document.getElementById(hintId!)).toHaveTextContent(/8 位/);
    expect(screen.getByRole("button", { name: "连接" })).toBeDisabled();
    fireEvent.blur(input);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(document.getElementById(hintId!)).toHaveTextContent(/认不出无人值守码/);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.focus(input);
    expect(input).toHaveAttribute("aria-invalid", "false");
    fireEvent.change(input, { target: { value: "7K2M-9PQX" } });
    expect(screen.getByRole("button", { name: "连接" })).toBeEnabled();
    expect(rc.requestUno).not.toHaveBeenCalled();
  });

  it("可解析但字符无效的接入码仍在失焦后就地解释", () => {
    renderCard();
    const input = screen.getByLabelText("无人值守接入码");
    fireEvent.change(input, { target: { value: "UUUU-XXXX" } });
    expect(screen.queryByText(/码里有无效字符/)).toBeNull();
    fireEvent.blur(input);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/码里有无效字符/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "连接" })).toBeDisabled();
  });

  it("密码输入期间不报警；失焦报错后换模式不污染接入码状态", () => {
    const { onClose } = renderCard();
    fireEvent.click(screen.getByRole("radio", { name: /固定密码/ }));
    const input = screen.getByLabelText("对方的固定密码");
    fireEvent.change(input, { target: { value: "123" } });
    expect(screen.queryByText(/密码长度不符合要求/)).toBeNull();
    expect(input).toHaveAttribute("aria-invalid", "false");
    fireEvent.blur(input);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(document.getElementById(input.getAttribute("aria-describedby")!)).toHaveTextContent(/密码长度不符合要求/);
    fireEvent.click(screen.getByRole("radio", { name: /接入码/ }));
    expect(screen.getByLabelText("无人值守接入码")).toHaveAttribute("aria-invalid", "false");
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("连接失败保留密码及返回入口，修改后可以重试", async () => {
    const requestPass = vi.fn().mockRejectedValueOnce(new Error("连接失败")).mockResolvedValue(true);
    const { onClose } = renderCard(requestPass);
    fireEvent.click(screen.getByRole("radio", { name: /固定密码/ }));
    const input = screen.getByLabelText("对方的固定密码");
    fireEvent.change(input, { target: { value: "hunter2!" } });
    fireEvent.click(screen.getByRole("button", { name: "连接" }));
    await screen.findByText("未能连接无人值守电脑");
    expect(input).toHaveValue("hunter2!");
    expect(screen.getByRole("button", { name: "返回" })).toBeEnabled();
    fireEvent.change(input, { target: { value: "hunter3!" } });
    fireEvent.click(screen.getByRole("button", { name: "连接" }));
    await waitFor(() => expect(requestPass).toHaveBeenLastCalledWith("pc", "hunter3!", "control"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
