/**
 * MarkdownRenderer 裁切开关（md-clamp）回归测试。
 *
 * 真实翻车：`.compact` 把两件不相干的事捆在一个类里——「紧凑排版」（小字号、
 * 隐藏代码块头部）与「限高 120px + overflow:hidden」。笔记预览只想要前者，
 * 却被迫吃下后者，于是正文超过约 6 行的部分被直接裁掉；又因为是 hidden 不是 auto，
 * 连滚都滚不动，表现成「打开笔记右侧只显示一部分」。
 *
 * 拆开后：compact 只管排版，**看得见多少由调用方用 clamp 决定**。
 * 下面钉的就是「两个开关互不牵连」，以及笔记预览这个具体调用点不带裁切。
 */
import type { ReactElement } from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";

// 编辑器那半在 jsdom 里跑不起来也没必要跑：本文件只关心预览那半传了什么
vi.mock("@/components/editors/useCodeMirrorEditor", () => ({
  useCodeMirrorEditor: () => ({ editorRef: { current: null } }),
}));
// wikiLink 候选会去查库，这里不让它真发 IPC
vi.mock("@/lib/api", () => ({ noteList: async () => [] }));

import { NoteEditorPane } from "@/components/notes/NoteEditorPane";

/** 够长——长到会撞上原先那 120px 的裁切 */
const LONG = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行正文`).join("\n\n");

/** 取渲染出来的根节点的类名集合 */
function rootClasses(ui: ReactElement): DOMTokenList {
  const { container } = render(ui);
  return (container.firstElementChild as HTMLElement).classList;
}

describe("MarkdownRenderer 裁切开关", () => {
  it("默认不裁切", () => {
    expect(rootClasses(<MarkdownRenderer text={LONG} />).contains("md-clamp")).toBe(false);
  });

  it("compact 不再隐含裁切——正是它当初裁掉了笔记正文", () => {
    expect(rootClasses(<MarkdownRenderer text={LONG} compact />).contains("md-clamp")).toBe(false);
  });

  it("clamp 才裁切", () => {
    expect(rootClasses(<MarkdownRenderer text={LONG} clamp />).contains("md-clamp")).toBe(true);
  });

  it("两个开关可任意组合（hover 弹窗是既紧凑又裁切）", () => {
    const both = rootClasses(<MarkdownRenderer text={LONG} compact clamp />);
    expect(both.contains("md-clamp")).toBe(true);
  });
});

describe("笔记预览", () => {
  it("正文完整可见，不带裁切", () => {
    const { container } = render(
      <NoteEditorPane
        initialContent={LONG}
        content={LONG}
        isDark={false}
        /* 本用例管的是预览区不能被裁切，用 split 保持与改形态之前完全一致。
           （换成 preview 也能跑，但那就顺手改了用例的前提。） */
        viewMode="split"
        onChange={() => {}}
        onSave={() => {}}
      />,
    );

    // 先确认预览真的渲染了，否则下面那条断言会因为「什么都没有」而假通过
    const preview = container.querySelector("[class*='md']");
    expect(preview).not.toBeNull();
    expect(container.querySelector(".md-clamp")).toBeNull();
  });
});
