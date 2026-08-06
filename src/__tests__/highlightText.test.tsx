import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { HighlightText } from "@/components/Card";

/**
 * 盯的是 hooks 调用顺序：原实现把 useMemo 写在两处 early return 之后，而调用处传的
 * highlight 就是 searchKeyword，会随搜索框在空/非空之间来回变——同一个实例 hooks
 * 数量 0↔1。当时形状下 React 恰好容忍，但再加一个 hook 就会报 "Rendered
 * fewer/more hooks than expected"。两个方向都要测：清空搜索框（非空→空）正是
 * React 那条 "This may be caused by an accidental early return" 报错的场景。
 */
describe("HighlightText", () => {
  it("空关键词时原文输出，不加 mark", () => {
    const { container } = render(<HighlightText text="hello world" highlight="" />);
    expect(container.textContent).toBe("hello world");
    expect(container.querySelectorAll("mark").length).toBe(0);
  });

  it("关键词从空变非空（开始搜索）", () => {
    const { rerender, container } = render(<HighlightText text="hello world" highlight="" />);
    rerender(<HighlightText text="hello world" highlight="wor" />);
    expect(container.querySelectorAll("mark").length).toBe(1);
    expect(container.querySelector("mark")?.textContent).toBe("wor");
    expect(container.textContent).toBe("hello world");
  });

  it("关键词从非空变空（清空搜索框）", () => {
    const { rerender, container } = render(<HighlightText text="hello world" highlight="wor" />);
    expect(container.querySelectorAll("mark").length).toBe(1);
    rerender(<HighlightText text="hello world" highlight="" />);
    expect(container.querySelectorAll("mark").length).toBe(0);
    expect(container.textContent).toBe("hello world");
  });

  it("全空白关键词当作空处理", () => {
    const { container } = render(<HighlightText text="hello world" highlight="   " />);
    expect(container.querySelectorAll("mark").length).toBe(0);
    expect(container.textContent).toBe("hello world");
  });

  it("关键词里的正则元字符被转义，不会把整个正则弄坑", () => {
    const { container } = render(<HighlightText text="cost is a+b (see note)" highlight="a+b" />);
    expect(container.querySelector("mark")?.textContent).toBe("a+b");
  });
});
