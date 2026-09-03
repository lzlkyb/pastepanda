/**
 * MCP 写权限面板（M5）。
 *
 * 只钉三件光看代码很容易说“当然对”、出错了又不报错的事：
 *
 * 1. 收起时标题上得能看到「已关 N 项」——否则关了也不知道关了。
 * 2. 保存失败时**不得把开关画成已关**：那会让用户以为关掉了写权限，
 *    而模型实际还能写——权限界面上最不能出的一类错。
 * 3. 分组小标题要在（七个开关平铺时用户分不出哪个危险）。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { McpWritePanel } from "@/components/settings/McpWritePanel";

// 与后端 `WriteKind::tool_names()` 同形：**一档可能管多个工具**。
const ROWS = [
  { key: "mcp_write_create", tools: ["kb_create"], label: "新建笔记", enabled: true },
  { key: "mcp_write_append", tools: ["kb_append", "kb_prepend"], label: "追加内容", enabled: true },
  {
    key: "mcp_write_update",
    tools: ["kb_update", "kb_update_section", "kb_insert_at_section", "kb_replace_in_note"],
    label: "修改笔记",
    enabled: true,
  },
  { key: "mcp_write_move", tools: ["kb_move"], label: "移动文件夹", enabled: true },
  { key: "mcp_write_tag", tools: ["kb_tag"], label: "改标签", enabled: true },
  { key: "mcp_write_delete", tools: ["kb_delete"], label: "删除到回收站", enabled: true },
  { key: "mcp_write_restore", tools: ["kb_restore"], label: "从回收站恢复", enabled: true },
];

const setSwitch = vi.fn();

vi.mock("@/lib/api/mcp", () => ({
  mcpGetWriteSwitches: async () => ROWS,
  mcpSetWriteSwitch: (...a: unknown[]) => setSwitch(...(a as [])),
}));

describe("MCP 写权限面板", () => {
  beforeEach(() => {
    setSwitch.mockReset();
  });

  it("收起时标题就报出开关总数", async () => {
    render(<McpWritePanel toast={() => {}} />);
    await waitFor(() => expect(screen.getByText(/7 项全开/)).toBeTruthy());
  });

  it("展开后三个分组小标题与七个开关都在", async () => {
    render(<McpWritePanel toast={() => {}} />);
    fireEvent.click(await screen.findByText(/写权限/));

    expect(screen.getByText(/新增——/)).toBeTruthy();
    expect(screen.getByText(/修改——/)).toBeTruthy();
    expect(screen.getByText(/删除与恢复——/)).toBeTruthy();
    expect(screen.getAllByRole("switch")).toHaveLength(7);
    // 工具名必须显示：它是用户在调用记录里看到的名字
    expect(screen.getByText("kb_delete")).toBeTruthy();
    // 🔴 一档管多个工具时必须**全列出**：否则用户在调用记录里看到
    // kb_update_section，却在面板上找不到该关哪一行。
    for (const t of ["kb_update_section", "kb_insert_at_section", "kb_replace_in_note", "kb_prepend"]) {
      expect(screen.getByText(t)).toBeTruthy();
    }
  });

  it("关掉一项后标题改报「已关 1 项」", async () => {
    setSwitch.mockResolvedValueOnce(
      ROWS.map((r) => (r.key === "mcp_write_delete" ? { ...r, enabled: false } : r)),
    );
    render(<McpWritePanel toast={() => {}} />);
    fireEvent.click(await screen.findByText(/写权限/));
    fireEvent.click(screen.getByRole("switch", { name: "删除到回收站" }));

    await waitFor(() => expect(setSwitch).toHaveBeenCalledWith("mcp_write_delete", false));
    await waitFor(() => expect(screen.getByText(/已关 1 项/)).toBeTruthy());
  });

  it("保存失败时开关不得变成已关", async () => {
    // 🔴 显示在关、实际没关，是权限界面上最不能出的一类错。
    setSwitch.mockResolvedValueOnce(null);
    render(<McpWritePanel toast={() => {}} />);
    fireEvent.click(await screen.findByText(/写权限/));
    const sw = screen.getByRole("switch", { name: "删除到回收站" });
    fireEvent.click(sw);

    await waitFor(() => expect(setSwitch).toHaveBeenCalled());
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/7 项全开/)).toBeTruthy();
  });
});
