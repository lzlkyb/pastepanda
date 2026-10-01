/**
 * 手机端设置页的守卫测试 —— 历史列表是**只读**的（手机端不做筛选/详情，
 * 那是桌面工作台的事），但清空必须两步确认：一键误触会把两端共用的
 * 会话历史全删掉，后悔药不存在。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UseRc } from "@/hooks/useRc";
import { RcSettingsView } from "./RcSettingsView";

const api = vi.hoisted(() => ({
  history: vi.fn(),
  clear: vi.fn(),
  setEnabled: vi.fn(),
}));
vi.mock("@/lib/api/rc", () => ({
  rcSessionHistory: api.history,
  rcHistoryClear: api.clear,
  rcSetEnabled: api.setEnabled,
  // 设置页还会被 useRc 的其他取值点碰到；给足空实现避免意外调用炸掉
  rcStatus: vi.fn(),
}));

function renderView(status: Record<string, unknown>) {
  const rc = {
    status,
    busy: false,
    setEnabled: api.setEnabled,
    clearHistory: api.clear,
  } as unknown as UseRc;
  render(<RcSettingsView rc={rc} onOpenSandbox={() => {}} />);
}

const HISTORY = [
  {
    peer: "pc-1", peer_name: "台式机", display_name: "台式机", capability: "control",
    dir: "outbound", started_ms: Date.now() - 3600_000, ended_ms: Date.now() - 3500_000,
    duration_ms: 100_000, reason: "正常结束",
  },
  {
    peer: "pc-2", peer_name: "笔记本", capability: "view",
    dir: "inbound", started_ms: Date.now() - 86_400_000, ended_ms: Date.now() - 86_000_000,
    duration_ms: 60_000, reason: "",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.clear.mockResolvedValue(undefined);
  api.setEnabled.mockResolvedValue(undefined);
});

describe("会话历史", () => {
  it("渲染对端 / 方向 / 时长", async () => {
    api.history.mockResolvedValueOnce(HISTORY);
    renderView({});
    expect(await screen.findByText(/连到 台式机/)).toBeTruthy();
    expect(screen.getByText(/被连 笔记本/)).toBeTruthy();
    // formatDuration 口径：分:秒（补零）
    expect(screen.getByText("01:40")).toBeTruthy();
  });

  it("空列表说人话", async () => {
    api.history.mockResolvedValueOnce([]);
    renderView({});
    expect(await screen.findByText("还没有会话记录")).toBeTruthy();
  });

  it("拉取失败给出错误 + 重试", async () => {
    api.history.mockRejectedValueOnce("boom");
    renderView({});
    expect(await screen.findByText(/boom/)).toBeTruthy();
    // 🔴 先排队成功值再点重试：点击同步触发 reload，队列空了就会落到
    // 无默认实现的 mock 上（返回 undefined），list 变 undefined 直接崩渲染。
    api.history.mockResolvedValueOnce(HISTORY);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText(/连到 台式机/)).toBeTruthy();
  });

  it("清空两步确认：第一下只亮确认，第二下才调命令并刷新", async () => {
    api.history.mockResolvedValue(HISTORY);
    renderView({});
    await screen.findByText(/连到 台式机/);

    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(api.clear).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "再点一次确认清空" }));
    await waitFor(() => expect(api.clear).toHaveBeenCalledTimes(1));
  });
});

describe("远程通道开关", () => {
  it("开 → 点关闭 → setEnabled(false)", async () => {
    renderView({ enabled: true });
    fireEvent.click(await screen.findByRole("button", { name: "关闭" }));
    expect(api.setEnabled).toHaveBeenCalledWith(false);
  });

  it("状态未知（status 还没到）只显示，不出按钮", () => {
    renderView({});
    expect(screen.getByText("状态未知")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
    expect(screen.queryByRole("button", { name: "开启" })).toBeNull();
  });
});
