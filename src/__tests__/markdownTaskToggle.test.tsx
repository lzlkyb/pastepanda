/**
 * 预览态直接勾选任务列表（写回源码）的交互守卫。
 *
 * 三件事必须钉住：
 * 1. **只读入口不许被打开** —— 卡片 hover、笔记预览、KB 问答都复用同一个渲染器，
 *    它们没有保存路径，一旦变成可点就是「勾了但存不下来」的假绿；
 * 2. **乐观更新 + 回滚** —— 预览有 300ms 防抖，不等反馈地翻 UI；写回失败必须翻回去；
 * 3. **序号要跟着源码走** —— 代码块里的 `- [ ]` 不算，否则勾第 2 项会改到别的行。
 */
import { describe, it, expect, vi } from "vitest";
import { render, renderHook, act, fireEvent } from "@testing-library/react";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { useTaskProgress } from "@/components/editors/fullscreen/useTaskProgress";

const MD = ["- [ ] 一", "- [ ] 二", "- [x] 三", "", "```md", "- [ ] 代码块不算", "```"].join("\n");

function boxes(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
}

describe("预览态勾选任务列表", () => {
  it("传 onToggleTask：摘掉 disabled，序号跟着源码（跳过代码块）", () => {
    const { container } = render(<MarkdownRenderer text={MD} onToggleTask={() => true} />);
    const list = boxes(container);
    expect(list).toHaveLength(3);
    expect(list.every((b) => !b.disabled)).toBe(true);
    expect(list.map((b) => b.dataset.taskI)).toEqual(["0", "1", "2"]);
    // 可点信号必须真挂上（styles.taskLive 写错名字只会得到 undefined，tsc 查不出）
    expect(container.firstElementChild!.className).toContain("taskLive");
  });

  it("点击第 2 项回调拿到下标 1（不是 DOM 里的第 2 个列表项之外的东西）", () => {
    const onToggleTask = vi.fn(() => true);
    const { container } = render(<MarkdownRenderer text={MD} onToggleTask={onToggleTask} />);
    fireEvent.click(boxes(container)[1]);
    expect(onToggleTask).toHaveBeenCalledTimes(1);
    expect(onToggleTask).toHaveBeenCalledWith(1);
  });

  it("乐观更新：点击后立即翻转，不等 300ms 防抖重渲染", () => {
    const { container } = render(<MarkdownRenderer text={MD} onToggleTask={() => true} />);
    const box = boxes(container)[0];
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(box.checked).toBe(true);
  });

  it("写回失败（返回 false）要回滚 —— 宁可看着没勾上，不可看着勾上了却没存", () => {
    const { container } = render(<MarkdownRenderer text={MD} onToggleTask={() => false} />);
    const box = boxes(container)[0];
    fireEvent.click(box);
    expect(box.checked).toBe(false);
  });

  it("不传回调 = 只读：disabled 保持原样（卡片 hover / 笔记预览 / KB 问答）", () => {
    const { container } = render(<MarkdownRenderer text={MD} />);
    const list = boxes(container);
    expect(list).toHaveLength(3);
    expect(list.every((b) => b.disabled)).toBe(true);
    expect(container.firstElementChild!.className).not.toContain("taskLive");
  });

  it("源码定位不可信的项（data-task-i=-1）保持 disabled", () => {
    const { container } = render(<MarkdownRenderer text={MD} onToggleTask={() => true} />);
    // 正常文档里不应出现 -1；这条是「一出现就必须只读」的口径钉死
    expect(boxes(container).some((b) => b.dataset.taskI === "-1")).toBe(false);
  });
});

describe("面板头任务进度", () => {
  it("200ms 后给出 done/total，改文后跟着走；没有任务项时返回 null（不占位）", () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(
        ({ text }) => useTaskProgress(text, true),
        { initialProps: { text: MD } },
      );
      expect(result.current).toBeNull(); // 首帧还没有数，宁可空着也不显示错数
      act(() => { vi.advanceTimersByTime(250); });
      expect(result.current).toEqual({ done: 1, total: 3 });

      rerender({ text: MD.replace("- [ ] 一", "- [x] 一") });
      act(() => { vi.advanceTimersByTime(250); });
      expect(result.current).toEqual({ done: 2, total: 3 });

      rerender({ text: "没有 checkbox" });
      act(() => { vi.advanceTimersByTime(250); });
      expect(result.current).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
