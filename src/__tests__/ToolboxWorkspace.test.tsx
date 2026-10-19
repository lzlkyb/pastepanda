import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ToolboxView } from "@/components/ToolboxView";

vi.mock("@/stores/appStore", () => ({ useAppStore: (selector: (s: unknown) => unknown) => selector({ config: {} }) }));
vi.mock("@/components/recsel/RecRecentList", () => ({ RecRecentList: () => <div>录制列表已读取</div> }));
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("toolbox workspace", () => {
  it("edits a separate draft, cancels it and saves an intentionally empty list", () => {
    const { unmount } = render(<ToolboxView handlers={{ sequential: vi.fn() }} />);
    fireEvent.click(screen.getByRole("button", { name: "编辑常用" }));
    while (screen.queryAllByRole("button", { name: /^移除/ }).length) fireEvent.click(screen.getAllByRole("button", { name: /^移除/ })[0]);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(within(screen.getByRole("tabpanel", { name: "我的常用" })).getAllByRole("button")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "编辑常用" }));
    while (screen.queryAllByRole("button", { name: /^移除/ }).length) fireEvent.click(screen.getAllByRole("button", { name: /^移除/ })[0]);
    fireEvent.click(screen.getByRole("button", { name: "保存常用" }));
    unmount(); render(<ToolboxView handlers={{}} />);
    expect(screen.getByText("把常用工具放到这里")).toBeTruthy();
  });

  it("keeps fullscreen comparison as an explicit action and records the exact tool", () => {
    const normal = vi.fn(), full = vi.fn();
    render(<ToolboxView handlers={{ diffedit: normal, difffull: full }} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "全屏" } });
    fireEvent.click(screen.getByRole("button", { name: "全屏文本对比" }));
    expect(full).toHaveBeenCalledOnce(); expect(normal).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("tab", { name: "最近使用" }));
    expect(within(screen.getByRole("tabpanel", { name: "最近使用" })).getByRole("button", { name: /全屏文本对比/ })).toBeTruthy();
  });

  it("contains button activation before global paste and gives dialogs Escape priority", () => {
    const behind = vi.fn(); window.addEventListener("keydown", behind);
    try {
      render(<ToolboxView handlers={{ screenrec: vi.fn() }} />);
      fireEvent.keyDown(screen.getAllByRole("button", { name: /屏幕录制/ })[0], { key: "Enter" });
      expect(behind).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "编辑常用" }));
      const dialog = document.createElement("div"); dialog.className = "dialog-backdrop"; document.body.append(dialog);
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.getByRole("button", { name: "保存常用" })).toBeTruthy();
      dialog.remove(); fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("button", { name: "保存常用" })).toBeNull();
    } finally { window.removeEventListener("keydown", behind); }
  });

  it("does not report a successful save when local storage refuses the write", () => {
    render(<ToolboxView handlers={{}} />);
    fireEvent.click(screen.getByRole("button", { name: "编辑常用" }));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    fireEvent.click(screen.getByRole("button", { name: "保存常用" }));
    expect(screen.getByRole("alert").textContent).toContain("未保存");
    expect(screen.getByRole("button", { name: "保存常用" })).toBeTruthy();
  });

  it("only reads recordings after expansion, and opens them in the recording category", async () => {
    render(<ToolboxView handlers={{}} />);
    expect(screen.queryByText("录制列表已读取")).toBeNull();
    fireEvent.click(screen.getByText("最近录制"));
    expect(await screen.findByText("录制列表已读取")).toBeTruthy();
  });

  it("preserves reordered pins on save and does not exceed the six-item limit", () => {
    const { unmount } = render(<ToolboxView handlers={{}} />);
    fireEvent.click(screen.getByRole("button", { name: "编辑常用" }));
    fireEvent.click(screen.getByRole("button", { name: "后移依次粘贴" }));
    for (const name of ["固定SQL 工具", "固定JSON 工具", "固定日志分析"]) fireEvent.click(screen.getByRole("button", { name }));
    expect(screen.getByRole("alert").textContent).toContain("最多固定 6 个");
    fireEvent.click(screen.getByRole("button", { name: "保存常用" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "编辑常用" }));
    unmount(); render(<ToolboxView handlers={{}} />);
    const pinned = within(screen.getByRole("tabpanel", { name: "我的常用" })).getAllByRole("button");
    expect(pinned).toHaveLength(6); expect(pinned[0].textContent).toContain("屏幕录制");
    expect(pinned[5].textContent).toContain("JSON 工具");
  });

  it("clears an edit search before Escape cancels the draft", () => {
    render(<ToolboxView handlers={{}} />);
    fireEvent.click(screen.getByRole("button", { name: "编辑常用" }));
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "json" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "保存常用" })).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "保存常用" })).toBeNull();
  });

  it.each(["取消", "保存常用"])("returns focus to search after %s when filtering hides the edit trigger", action => {
    render(<ToolboxView handlers={{}} />);
    fireEvent.click(screen.getByRole("button", { name: "编辑常用" }));
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "json" } });
    const button = screen.getByRole("button", { name: action });
    button.focus(); fireEvent.click(button);
    expect(document.activeElement).toBe(input);
    expect((input as HTMLInputElement).value).toBe("json");
  });

  it("supports keyboard category changes and opens recordings only for their category", () => {
    render(<ToolboxView handlers={{}} />);
    fireEvent.keyDown(screen.getByRole("tab", { name: /^全部\s*16$/ }), { key: "End" });
    const device = screen.getByRole("tab", { name: /^设备连接\s*1$/ });
    expect(device.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(device);
    expect(screen.queryByText("最近录制")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /^图形与录屏\s*3$/ }));
    expect(screen.getByText("录制列表已读取")).toBeTruthy();
  });
});
