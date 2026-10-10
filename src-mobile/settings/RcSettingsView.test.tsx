/**
 * 手机端设置页的守卫测试 —— 历史列表是**只读**的（手机端不做筛选/详情，
 * 那是桌面工作台的事），但清空必须两步确认：一键误触会把两端共用的
 * 会话历史全删掉，后悔药不存在。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UseRc } from "@/hooks/useRc";
import { RcSettingsView } from "./RcSettingsView";
// This suite exercises settings/history. The update section has an app-owned provider.
vi.mock("./MobileUpdateSection", () => ({ MobileUpdateSection: () => null }));

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
  localStorage.clear();
  api.clear.mockResolvedValue(true);
  api.setEnabled.mockResolvedValue(true);
});

it("设置页的四种操作习惯写入与会话共用的偏好，结果留在面板内", async () => {
  renderView({ enabled: true });
  fireEvent.click(screen.getByRole("button", { name: /操作习惯/ }));
  expect(screen.getAllByRole("radio")).toHaveLength(4);
  fireEvent.click(screen.getByRole("radio", { name: /直接点击/ }));
  expect(localStorage.getItem("pastepanda-mobile-pointer-mode")).toBe("direct");
  expect(screen.getByRole("radio", { name: /直接点击/ }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText("默认使用直接点击，已保存").closest('[role="dialog"]')).toBeTruthy();
});

it("偏好存储失败不假装选中或保存，面板内保留恢复说明", () => {
  renderView({ enabled: true });
  fireEvent.click(screen.getByRole("button", { name: /操作习惯/ }));
  const stored = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
  fireEvent.click(screen.getByRole("radio", { name: /浮动鼠标/ }));
  expect(screen.getByRole("alert").textContent).toContain("未能保存");
  expect(screen.getByRole("radio", { name: /^触控板/ }).getAttribute("aria-checked")).toBe("true");
  stored.mockRestore();
});

it("手势指南覆盖四种操作方式并使用现有入口名称", () => {
  renderView({ enabled: true });
  fireEvent.click(screen.getByRole("button", { name: /手势使用指南/ }));
  expect(screen.getByText(/^触控板模式/)).toBeTruthy();
  expect(screen.getByText(/^直接点击模式/)).toBeTruthy();
  expect(screen.getByText(/^独立触控板模式/)).toBeTruthy();
  expect(screen.getByText(/^浮动鼠标模式/)).toBeTruthy();
  expect(screen.queryByText(/触控板／直接点击/)).toBeNull();
});

describe("会话历史", () => {
  it("渲染对端 / 方向 / 时长", async () => {
    api.history.mockResolvedValueOnce(HISTORY);
    renderView({});
    fireEvent.click(screen.getByRole("button", { name: /会话历史/ }));
    expect(await screen.findByText(/连到 台式机/)).toBeTruthy();
    expect(screen.getByText(/被连 笔记本/)).toBeTruthy();
    // formatDuration 口径：分:秒（补零）
    expect(screen.getByText("01:40")).toBeTruthy();
  });

  it("空列表说人话", async () => {
    api.history.mockResolvedValueOnce([]);
    renderView({});
    fireEvent.click(screen.getByRole("button", { name: /会话历史/ }));
    expect(await screen.findByText("还没有会话记录")).toBeTruthy();
  });

  it("拉取失败给出错误 + 重试", async () => {
    api.history.mockRejectedValueOnce("boom");
    renderView({});
    fireEvent.click(screen.getByRole("button", { name: /会话历史/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/操作未能完成/);
    expect(screen.queryByText(/boom/)).toBeNull();
    // 🔴 先排队成功值再点重试：点击同步触发 reload，队列空了就会落到
    // 无默认实现的 mock 上（返回 undefined），list 变 undefined 直接崩渲染。
    api.history.mockResolvedValueOnce(HISTORY);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText(/连到 台式机/)).toBeTruthy();
  });

  it("清空两步确认：第一下只亮确认，第二下才调命令并刷新", async () => {
    api.history.mockResolvedValue(HISTORY);
    renderView({});
    fireEvent.click(screen.getByRole("button", { name: /会话历史/ }));
    await screen.findByText(/连到 台式机/);

    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(api.clear).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认清空" }));
    await waitFor(() => expect(api.clear).toHaveBeenCalledTimes(1));
  });
});

describe("远程通道开关", () => {
  it("开 → 点关闭 → setEnabled(false)", async () => {
    renderView({ enabled: true });
    fireEvent.click(await screen.findByRole("switch", { name: "远程通道" }));
    expect(api.setEnabled).toHaveBeenCalledWith(false);
  });

  it("状态未知（status 还没到）只显示，不出按钮", () => {
    renderView({});
    expect(screen.getByText("状态未知")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
    expect(screen.queryByRole("button", { name: "开启" })).toBeNull();
  });
});
