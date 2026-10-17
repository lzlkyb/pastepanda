import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { McpTab } from "./McpTab";

vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/useMcpServer", () => ({
  useMcpServer: () => ({
    status: { running: false },
    busy: false,
    startError: "MCP_TEST_START_ERROR",
    auditError: "",
    setEnabled: vi.fn(),
    dismissError: vi.fn(),
  }),
}));
vi.mock("./ToggleRow", () => ({ ToggleRow: () => <div>服务开关</div> }));
vi.mock("./McpServerPanel", () => ({ McpServerPanel: () => <div>运行面板</div> }));

describe("MCP 启动失败反馈", () => {
  it("服务未运行时仍展示启动错误，不能随运行面板一起隐藏", () => {
    render(<McpTab />);
    expect(screen.getByRole("alert").textContent).toContain("MCP_TEST_START_ERROR");
    expect(screen.queryByText("运行面板")).toBeNull();
  });
});
