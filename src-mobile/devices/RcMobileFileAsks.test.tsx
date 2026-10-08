import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RcFileView } from "@/hooks/useRcFile";
import { RcMobileFileAsks } from "./RcMobileFileAsks";

function setup(respond = vi.fn().mockResolvedValue(true), busy = false) {
  const file = { asks: [{ id: "request", peer: "pc", peer_name: "工作电脑", kind: "push",
    name: "资料.pdf", size: 1024, first_seen_ms: Date.now() }], busy, respond } as unknown as RcFileView;
  const onHandled = vi.fn();
  const props = { file, receiveDir: "/receive", active: true, onHandled };
  const view = render(<RcMobileFileAsks {...props} />);
  return { file, onHandled, props, view, respond };
}

describe("文件请求的同域结果", () => {
  it.each(["接受", "拒绝"])("%s 成功后请求消失仍保留结果，可手动关闭", async action => {
    const { view, props, respond, onHandled } = setup();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: action })));
    expect(respond).toHaveBeenCalledExactlyOnceWith("request", action === "接受" ? "/receive" : null);
    expect(onHandled).toHaveBeenCalledTimes(1);
    view.rerender(<RcMobileFileAsks {...props} file={{ ...props.file, asks: [] }} />);
    expect(screen.getByRole("status")).toHaveTextContent(action === "接受" ? "已接受文件请求，等待传输" : "已拒绝文件请求");
    expect(screen.queryByText(/传输完成/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("返回 false 不显示成功，保留失败说明并允许原动作重试", async () => {
    const { respond, onHandled } = setup(vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "接受" })));
    expect(screen.getByRole("alert")).toHaveTextContent("请重试");
    expect(screen.queryByText("已接受文件请求，等待传输")).toBeNull();
    expect(onHandled).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "接受" })).toBeEnabled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "接受" })));
    expect(respond).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("等待传输");
  });
  it("拒绝抛错显示可重试失败，锁释放且不调用成功回调", async () => {
    const { onHandled } = setup(vi.fn().mockRejectedValue(new Error("network")));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "拒绝" })));
    expect(screen.getByRole("alert")).toHaveTextContent("文件请求未能处理");
    expect(screen.getByRole("alert")).toHaveTextContent("请重试");
    expect(screen.getByRole("button", { name: "拒绝" })).toBeEnabled();
    expect(onHandled).not.toHaveBeenCalled();
  });
  it("处理期间同时禁用接收与拒绝，不重复提交", async () => {
    let finish!: (ok: boolean) => void;
    const { respond } = setup(vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; })));
    fireEvent.click(screen.getByRole("button", { name: "接受" }));
    expect(screen.getByRole("button", { name: "正在接受…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    expect(respond).toHaveBeenCalledTimes(1);
    await act(async () => finish(true));
  });
  it("全局忙碌时不提交请求", () => {
    const { respond } = setup(vi.fn(), true);
    expect(screen.getByRole("button", { name: "接受" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    expect(respond).not.toHaveBeenCalled();
  });
  it("切到后台暂停展示，回到原面板保留结果", async () => {
    const { view, props } = setup();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "拒绝" })));
    const file = { ...props.file, asks: [] };
    view.rerender(<RcMobileFileAsks {...props} file={file} active={false} />);
    expect(screen.queryByRole("status")).toBeNull();
    view.rerender(<RcMobileFileAsks {...props} file={file} active />);
    expect(screen.getByRole("status")).toHaveTextContent("已拒绝文件请求");
  });
});
