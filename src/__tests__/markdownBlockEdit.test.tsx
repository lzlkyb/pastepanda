/**
 * 块级就地编辑（预览浮层）组件守卫。
 *
 * 关键口径：
 * - 只有传了 onEditBlock 的调用点才可编辑；不传 = 无 data-blk-i（只读入口零变化）。
 * - 双击已有单击行为的元素（链接/图片/按钮/勾选框/块号）不劫持。
 * - 保存返回 false（写回侧 expectRaw 校验不过）→ 浮层不关、提示 stale，内容不丢。
 *
 * 防假绿核对见文末「变异记录」。
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";

const MD = ["第一段", "", "## 标题", "", "| a | b |", "|---|---|", "| 1 | 2 |"].join("\n");

function mount(onEditBlock?: (i: number, raw: string, expectRaw: string) => boolean) {
  return render(<MarkdownRenderer text={MD} onEditBlock={onEditBlock} />);
}

describe("块级就地编辑", () => {
  it("双击段落 → 浮层打开，textarea 预填该块源码", () => {
    mount(vi.fn(() => true));
    fireEvent.doubleClick(screen.getByText("第一段"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByDisplayValue("第一段")).toBeTruthy();
  });

  it("保存：回调收到 (index, newRaw, expectRaw=打开时的源码)，成功后浮层关闭", () => {
    const onEditBlock = vi.fn(() => true);
    mount(onEditBlock);
    fireEvent.doubleClick(screen.getByText("第一段"));
    fireEvent.change(screen.getByDisplayValue("第一段"), { target: { value: "改过的段落" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(onEditBlock).toHaveBeenCalledWith(0, "改过的段落", "第一段");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("内容没改就点保存：直接关浮层，不空写一次回调", () => {
    const onEditBlock = vi.fn(() => true);
    mount(onEditBlock);
    fireEvent.doubleClick(screen.getByText("第一段"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(onEditBlock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("保存被拒绝（返回 false）→ 浮层不关、编辑内容保留、显示 stale 提示", () => {
    mount(vi.fn(() => false));
    fireEvent.doubleClick(screen.getByText("第一段"));
    fireEvent.change(screen.getByDisplayValue("第一段"), { target: { value: "没存进去的" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByDisplayValue("没存进去的")).toBeTruthy();
    expect(screen.getByText(/保存被拒绝/)).toBeTruthy();
  });

  it("取消：不触发回调直接关", () => {
    const onEditBlock = vi.fn(() => true);
    mount(onEditBlock);
    fireEvent.doubleClick(screen.getByText("第一段"));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onEditBlock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("表格块也能编辑：双击单元格定位到整张表的源码（含管道行）", () => {
    mount(vi.fn(() => true));
    fireEvent.doubleClick(screen.getByText("a"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByDisplayValue(/\| a \| b \|/)).toBeTruthy();
  });

  it("双击链接不开浮层（已有单击行为的元素不劫持）", () => {
    render(<MarkdownRenderer text={"[外链](https://e.com)\n\n段落"} onEditBlock={vi.fn(() => true)} />);
    fireEvent.doubleClick(screen.getByText("外链"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("不传 onEditBlock = 完全只读：不挂 data-blk-i，双击无反应", () => {
    const { container } = mount(undefined);
    expect(container.querySelectorAll("[data-blk-i]").length).toBe(0);
    fireEvent.doubleClick(screen.getByText("第一段"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

/* ─── 变异记录（防假绿，2026-10-19 实测，均精确变红后还原）───
 * 1. 挂载 effect 无条件写 data-blk-i（去掉 interactiveBlocks 分支）→
 *    「不传 = 只读」变红。
 * 2. dblclick 处理器的 `closest("a, button, ...")` 过滤短路 →
 *    「双击链接不开浮层」变红。
 */
