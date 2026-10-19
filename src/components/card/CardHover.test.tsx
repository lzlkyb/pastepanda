import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Card } from "@/components/Card";
import { useAppStore, type HistoryItem } from "@/stores/appStore";
import styles from "../CardList.module.css";

vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/card/CardActionBar", () => ({ CardActionBar: () => null }));
const { copy } = vi.hoisted(() => ({ copy: vi.fn() }));
vi.mock("@/lib/api", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/api")>(), copyItemToClipboard: copy }));
const item = { id: "hover-a", type: "text", text: "卡片悬浮测试", time: Date.now(), pinned: false, tags: [] } as unknown as HistoryItem;
const props = { item, selected: true, index: 0, onClick: vi.fn(), onDoubleClick: vi.fn(), onEdit: vi.fn() };
const config = useAppStore.getState().config;
beforeEach(() => { vi.useFakeTimers(); copy.mockResolvedValue("已复制"); });
afterEach(() => { cleanup(); vi.useRealTimers(); copy.mockReset(); useAppStore.setState({ config }); });
const mode = (hover_mode: "off" | "inline" | "popover") => useAppStore.setState({ config: { ...config, hover_mode } });
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

it("关闭模式不渲染复制入口，悬停后也不会出现", () => {
  mode("off");
  const { container } = render(<Card {...props} />);
  expect(screen.queryByRole("button", { name: "复制" })).toBeNull();
  fireEvent.mouseEnter(container.firstElementChild!);
  advance(300);
  expect(screen.queryByRole("button", { name: "复制" })).toBeNull();
});

it("操作按钮模式移入即显示唯一复制入口，移出缓冲后退出键盘导航", () => {
  mode("inline");
  const { container } = render(<Card {...props} />);
  expect(screen.getByRole("button", { name: "复制", hidden: true }).tabIndex).toBe(-1);
  fireEvent.mouseEnter(container.firstElementChild!);
  expect(screen.getAllByRole("button", { name: "复制", hidden: true })).toHaveLength(1);
  expect(screen.getByRole("button", { name: "复制", hidden: true }).tabIndex).toBe(0);
  fireEvent.mouseLeave(container.firstElementChild!);
  advance(100);
  expect(screen.getByRole("button", { name: "复制", hidden: true }).tabIndex).toBe(0);
  advance(50);
  expect(screen.getByRole("button", { name: "复制", hidden: true }).tabIndex).toBe(-1);
});

it("聚焦选中卡片后展开操作，焦点在按钮间移动或鼠标移出时保持展开", () => {
  mode("inline");
  const { container } = render(<Card {...props} />);
  const card = screen.getByRole("option");
  expect(card.tabIndex).toBe(0);
  fireEvent.focus(card);
  const copy = screen.getByRole("button", { name: "复制", hidden: true });
  expect(copy.tabIndex).toBe(0);
  fireEvent.blur(card, { relatedTarget: copy });
  fireEvent.focus(copy);
  fireEvent.mouseLeave(container.firstElementChild!);
  advance(300);
  expect(copy.tabIndex).toBe(0);
  fireEvent.blur(copy, { relatedTarget: document.body });
  advance(150);
  expect(copy.tabIndex).toBe(-1);
});

it("鼠标点击留下的按钮焦点不会让操作栏在鼠标移出后常驻", () => {
  mode("inline");
  const { container } = render(<Card {...props} />);
  const wrap = container.firstElementChild!;
  fireEvent.mouseEnter(wrap);
  const copy = screen.getByRole("button", { name: "复制" });
  fireEvent.mouseDown(copy);
  fireEvent.focus(copy);
  fireEvent.mouseLeave(wrap);
  advance(150);
  expect(copy.tabIndex).toBe(-1);
});

it("气泡保留意图延迟，离开卡片进入气泡不会消失或重复复制按钮", () => {
  mode("popover");
  const { container } = render(<Card {...props} />);
  expect(screen.queryByRole("button", { name: "复制" })).toBeNull();
  fireEvent.mouseEnter(container.firstElementChild!);
  advance(179);
  expect(screen.queryByRole("button", { name: "复制" })).toBeNull();
  advance(1);
  const copy = screen.getByRole("button", { name: "复制" });
  expect(copy).toBeTruthy();
  fireEvent.mouseLeave(container.firstElementChild!);
  advance(100);
  fireEvent.mouseEnter(copy.closest(`.${styles.cardPopover}`)!);
  advance(100);
  expect(screen.getAllByRole("button", { name: "复制" })).toHaveLength(1);
});

it("快速掠过和切换记录不会残留上一次的悬浮气泡", () => {
  mode("popover");
  const { container, rerender } = render(<Card {...props} />);
  fireEvent.mouseEnter(container.firstElementChild!);
  advance(100);
  fireEvent.mouseLeave(container.firstElementChild!);
  advance(300);
  expect(screen.queryByRole("button", { name: "复制" })).toBeNull();
  fireEvent.mouseEnter(container.firstElementChild!);
  advance(180);
  expect(screen.getByRole("button", { name: "复制" })).toBeTruthy();
  rerender(<Card {...props} item={{ ...item, id: "hover-b" }} />);
  advance(300);
  expect(screen.queryByRole("button", { name: "复制" })).toBeNull();
});

it("从按钮模式切到关闭模式会清掉活动操作及未触发的打开任务", () => {
  mode("inline");
  const { container } = render(<Card {...props} />);
  fireEvent.mouseEnter(container.firstElementChild!);
  act(() => mode("off"));
  advance(300);
  expect(within(container).queryByRole("button", { name: "复制" })).toBeNull();
});

it.each(["inline", "popover"] as const)("%s 模式中复制等待及成功确认期间不收起，确认结束后正常收起", async hoverMode => {
  mode(hoverMode);
  let resolve!: (value: string) => void;
  copy.mockReturnValue(new Promise(done => { resolve = done; }));
  const { container } = render(<Card {...props} />);
  const wrap = container.firstElementChild!;
  fireEvent.mouseEnter(wrap);
  advance(180);
  fireEvent.click(screen.getByRole("button", { name: "复制" }));
  fireEvent.mouseLeave(wrap);
  advance(500);
  expect(screen.getByRole("button", { name: "复制中" })).toBeTruthy();
  await act(async () => resolve("已复制"));
  expect(screen.getByRole("button", { name: "已复制" })).toBeTruthy();
  advance(1499);
  expect(screen.getByRole("button", { name: "已复制" })).toBeTruthy();
  advance(1);
  advance(150);
  if (hoverMode === "inline") expect(screen.getByRole("button", { name: "复制", hidden: true }).tabIndex).toBe(-1);
  else {
    const popup = wrap.querySelector(`.${styles.cardPopover}`);
    expect(popup === null || popup.hasAttribute("inert")).toBe(true);
  }
});

it("复制操作不会触发卡片选中或双击预览", () => {
  mode("inline");
  const onClick = vi.fn(), onDoubleClick = vi.fn();
  const { container } = render(<Card {...props} onClick={onClick} onDoubleClick={onDoubleClick} />);
  fireEvent.mouseEnter(container.firstElementChild!);
  const button = screen.getByRole("button", { name: "复制" });
  fireEvent.mouseDown(button);
  fireEvent.doubleClick(button);
  expect(onClick).not.toHaveBeenCalled();
  expect(onDoubleClick).not.toHaveBeenCalled();
});

it("关闭模式不创建悬浮定时器，卸载时取消尚未打开的气泡", () => {
  mode("off");
  const { container, unmount } = render(<Card {...props} />);
  fireEvent.mouseEnter(container.firstElementChild!);
  fireEvent.mouseLeave(container.firstElementChild!);
  expect(vi.getTimerCount()).toBe(0);
  act(() => mode("popover"));
  fireEvent.mouseEnter(container.firstElementChild!);
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("预览被禁用时不会创建意图延迟或气泡", () => {
  mode("popover");
  const { container } = render(<Card {...props} disablePreview />);
  fireEvent.mouseEnter(container.firstElementChild!);
  expect(vi.getTimerCount()).toBe(0);
  advance(300);
  expect(screen.queryByRole("button", { name: "复制" })).toBeNull();
});

it("复制中卸载卡片不残留悬浮关闭定时器", () => {
  mode("inline");
  copy.mockReturnValue(new Promise(() => {}));
  const { container, unmount } = render(<Card {...props} />);
  fireEvent.mouseEnter(container.firstElementChild!);
  fireEvent.click(screen.getByRole("button", { name: "复制" }));
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
