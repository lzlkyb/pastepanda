import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SegmentedTabs, CircleTabs } from "./HistoryTypeTabs";
import styles from "../TopBar.module.css";
afterEach(cleanup);
it("重复点击当前分类不会清选中、重播或再发起筛选", () => {
  const setFilterType = vi.fn(); render(<SegmentedTabs filterType="all" setFilterType={setFilterType} counts={{ all: 12, text: 6 }} />);
  fireEvent.click(screen.getByText("全部").closest("button")!); expect(setFilterType).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("文本").closest("button")!); expect(setFilterType).toHaveBeenCalledWith("text");
});
it("零条计数仍可见，并提供键盘可达的明确选中态", () => {
  const setFilterType = vi.fn(); render(<SegmentedTabs filterType="text" setFilterType={setFilterType} counts={{ all: 0, text: 0, image: 0 }} />);
  expect(screen.queryByRole("tablist")).not.toBeNull();
  const text = screen.getByRole("tab", { name: /文本/ }); expect(text.getAttribute("aria-selected")).toBe("true");
  expect(text.textContent).toContain("0"); fireEvent.keyDown(text, { key: "ArrowRight" });
  expect(setFilterType).toHaveBeenCalledWith("image");
  expect(document.activeElement?.textContent).toContain("图片");
});
it("圆形样式也遵循重复点击不触发的同一规则", () => {
  const setFilterType = vi.fn(); render(<CircleTabs filterType="all" setFilterType={setFilterType} counts={null} />);
  fireEvent.click(screen.getByText("全部").closest("button")!); expect(setFilterType).not.toHaveBeenCalled();
});

it("滑块始终是同一节点，快速切换不会重建或叠加底板", () => {
  const props = { setFilterType: vi.fn(), counts: null };
  const { container, rerender } = render(<SegmentedTabs {...props} filterType="all" />);
  const indicator = container.querySelector(`.${styles.segActiveIndicator}`);
  rerender(<SegmentedTabs {...props} filterType="text" />);
  rerender(<SegmentedTabs {...props} filterType="file" />);
  expect(container.querySelectorAll(`.${styles.segActiveIndicator}`)).toHaveLength(1);
  expect(container.querySelector(`.${styles.segActiveIndicator}`)).toBe(indicator);
});

it("页签的 Enter 和空格不冒泡为全局粘贴或预览快捷键", () => {
  const globalKey = vi.fn(); window.addEventListener("keydown", globalKey);
  try {
    render(<SegmentedTabs filterType="all" setFilterType={vi.fn()} counts={null} />);
    const tab = screen.getByRole("tab", { name: /全部/ });
    fireEvent.keyDown(tab, { key: "Enter" }); fireEvent.keyDown(tab, { key: " " });
    expect(globalKey).not.toHaveBeenCalled();
  } finally { window.removeEventListener("keydown", globalKey); }
});
