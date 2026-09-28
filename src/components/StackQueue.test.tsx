import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { StackQueue } from "./StackQueue";
import type { HistoryItem } from "@/stores/appStore";

/**
 * StackQueue 的渲染契约。
 *
 * ❗ jsdom 没有 `ResizeObserver`（`test-setup.ts` 也没补），虚拟器拿不到滚动容器
 * 宽度 → `scrollRect` 一直是 null → 组件走**兜底窗口**那条分支。
 * 所以这里能钉住「DOM 数量有界」和「chip 行为没丢」，钉不住真实窗口宽度；
 * 那条要真机看（见 `docs/dev-运行手册.md` 的 dev 启动方式）。
 */

function item(i: number, text = `文本${i}`): HistoryItem {
  return {
    id: `i-${i}`,
    text,
    time: "2026-01-01 12:00:00",
    type: "text",
    content: "",
    pinned: false,
    source: "clipboard",
    workspace: "默认",
  };
}

const noHover = () => ({
  onMouseEnter: () => {},
  onMouseLeave: () => {},
});

function renderQueue(
  pending: HistoryItem[],
  done: HistoryItem[] = [],
  extra: Partial<Parameters<typeof StackQueue>[0]> = {}
) {
  const onReorder = vi.fn();
  const onRemove = vi.fn();
  const utils = render(
    <StackQueue
      pendingItems={pending}
      doneItems={done}
      locked={false}
      onReorder={onReorder}
      onRemove={onRemove}
      hoverHandlers={noHover}
      {...extra}
    />
  );
  return { ...utils, onReorder, onRemove };
}

/** 待贴 chip 都带这颗移除键，已贴项没有 → 用它数待贴项 */
const removeKeys = (c: HTMLElement) =>
  c.querySelectorAll('button[title="从队列移除（不粘贴）"]').length;

describe("StackQueue", () => {
  it("空队列给引导文案", () => {
    renderQueue([]);
    expect(screen.getByText("暂无收集 · 按 Ctrl+C 开始")).toBeTruthy();
  });

  it("长队列的 DOM 数量有界（不会按数组长度摆满 chip）", () => {
    const pending = Array.from({ length: 500 }, (_, i) => item(i));
    const { container } = renderQueue(pending);
    // 兜底窗口 40 颗：500 条时若逐个 map，这里就是 500 颗带四个拖拽处理器的 chip
    expect(removeKeys(container)).toBeLessThanOrEqual(40);
    expect(removeKeys(container)).toBeGreaterThan(0);
  });

  it("已贴项排在队尾、不带移除键与拖拽手柄", () => {
    const { container } = renderQueue([item(0)], [item(1, "已贴的")]);
    expect(removeKeys(container)).toBe(1);
    expect(screen.getByText("已贴的")).toBeTruthy();
    expect(container.querySelectorAll('[class*="grip"]').length).toBe(1);
  });

  it("第一条挂「下一个粘贴」标签", () => {
    renderQueue([item(0, "头一条"), item(1, "第二条")]);
    expect(screen.getByText("下一个粘贴")).toBeTruthy();
  });

  it("队列短的时候不摆跳转键，长了才摆（并报出栈底是什么）", () => {
    const short = renderQueue(Array.from({ length: 5 }, (_, i) => item(i)));
    expect(screen.queryByText("栈顶")).toBeNull();
    short.unmount();

    renderQueue(Array.from({ length: 30 }, (_, i) => item(i)));
    expect(screen.getByText("栈顶")).toBeTruthy();
    const tailBtn = screen.getByText("栈底 30");
    expect(tailBtn.getAttribute("title")).toContain("文本29");
  });

  it("拖到别的 chip 上 → 按 id 重排（不是按下标）", () => {
    const pending = [item(0, "a"), item(1, "b"), item(2, "c")];
    const { getByText, onReorder } = renderQueue(pending);
    const source = getByText("a").parentElement as HTMLElement;
    const target = getByText("c").parentElement as HTMLElement;
    fireEvent.dragStart(source);
    fireEvent.dragOver(target);
    fireEvent.drop(target);
    expect(onReorder).toHaveBeenCalledWith("i-0", "i-2");
  });

  it("「全部粘贴」进行中禁用拖拽重排", () => {
    const pending = [item(0, "a"), item(1, "b")];
    const { getByText } = renderQueue(pending, [], { locked: true });
    expect((getByText("a").parentElement as HTMLElement).draggable).toBe(false);
  });

  it("移除键回调同时给出 id 与显示文本", () => {
    const { getByText, onRemove } = renderQueue([item(7, "要删的")]);
    fireEvent.click(getByText("✕"));
    expect(onRemove).toHaveBeenCalledWith("i-7", "要删的");
  });
});
