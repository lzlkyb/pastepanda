import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RcConnectionBadge, RcConnectionDetails } from "./RcConnectionDetails";
import type { MobileConnectionInfo } from "./useMobileConnectionInfo";
import "@testing-library/jest-dom/vitest";

const info: MobileConnectionInfo = { sessionId: "a", state: "connecting", label: "测量中", grade: "unknown", rttMs: 0, path: "", frames: null, lossPermille: 0, samples: [], sampledAt: Date.now() };
it("无样本仍有可达详情入口，面板不展示虚假 0ms / 0%", () => {
  const open = vi.fn();
  render(<><RcConnectionBadge info={info} onOpen={open} /><RcConnectionDetails open title="工作电脑" info={info} quality="auto" onClose={vi.fn()} onQuality={vi.fn()} /></>);
  expect(screen.getByRole("dialog", { name: "连接详情" })).toBeInTheDocument();
  expect(screen.queryByText("0 ms")).toBeNull();
  fireEvent.click(screen.getByText("高级参数"));
  expect(screen.queryByText("0.0%")).toBeNull();
  expect(screen.getAllByText("暂无样本").length).toBeGreaterThan(3);
});
it("只看模式也可查看详情；画质入口与关闭均不结束会话", () => {
  const close = vi.fn(), quality = vi.fn();
  render(<RcConnectionDetails open title="工作电脑" info={{ ...info, rttMs: 36, state: "connected", label: "流畅", grade: "ok" }} quality="auto" onClose={close} onQuality={quality} />);
  fireEvent.click(screen.getByRole("button", { name: "画面与画质" }));
  expect(quality).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(close).toHaveBeenCalledOnce();
});
it("没有足够样本不画伪造趋势，RTT 偏慢不称为断线", () => {
  render(<RcConnectionDetails open title="工作电脑" info={{ ...info, rttMs: 240, state: "connected", label: "偏慢", grade: "poor", samples: [{ t: Date.now(), ms: 240 }] }} quality="balanced" onClose={vi.fn()} onQuality={vi.fn()} />);
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText("已连接")).toBeInTheDocument();
  expect(screen.getByText(/降低画质可能减轻/)).toBeInTheDocument();
});
it("延时按钮提供文字、当前读数和点击反馈", () => {
  const open = vi.fn();
  render(<RcConnectionBadge info={{ ...info, rttMs: 36, state: "connected", label: "流畅", grade: "ok" }} onOpen={open} />);
  fireEvent.click(screen.getByRole("button", { name: /往返延时 36 毫秒/ }));
  expect(open).toHaveBeenCalledOnce();
});
