/**
 * TagEditor 保存失败 —— 守「失败不关窗」（U3.5 / 规则 15）。
 *
 * 背景：`setItemTags` 失败时返回 false 并在 api 层 toastActionFailed，
 * 但 handleSave 曾无条件 `onClose()`，用户以为存上了、列表标签其实没变。
 * 这里钉住：ok=false → 弹窗保持打开，不调 onClose。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { TagEditor } from "@/components/TagEditor";
import { useAppStore } from "@/stores/appStore";

// jsdom 没有 matchMedia，弹窗动画链 usePrefersReducedMotion 要用
beforeEach(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

const h = vi.hoisted(() => ({
  setItemTags: vi.fn(),
  createTag: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  setItemTags: h.setItemTags,
  createTag: h.createTag,
  // TagEditor 只用到这两个；其余 api 由别处导入
}));

const item = {
  id: "h1",
  text: "hello",
  type: "text" as const,
  time: "2026-01-01 12:00:00",
  content: "",
  pinned: false,
  source: "",
  workspace: "默认",
};

describe("TagEditor 保存失败不关窗", () => {
  beforeEach(() => {
    h.setItemTags.mockReset();
    h.createTag.mockReset();
    useAppStore.setState({
      tags: [{ id: "t1", name: "工作", color: "#3B82F6", source: "manual", created_at: "2026-01-01 00:00:00" }],
    });
  });
  afterEach(() => cleanup());

  it("setItemTags 返回 false 时不调 onClose", async () => {
    h.setItemTags.mockResolvedValueOnce(false);
    const onClose = vi.fn();
    render(<TagEditor open item={item} onClose={onClose} />);

    // 勾一个已有标签再点保存
    fireEvent.click(screen.getByText("工作"));
    fireEvent.click(screen.getByRole("button", { name: "确定" }));

    await waitFor(() => expect(h.setItemTags).toHaveBeenCalledWith("h1", ["t1"]));
    // 失败：弹窗必须留着（规则 15.1——按钮与反馈同一可见性域）
    expect(onClose).not.toHaveBeenCalled();
  });

  it("setItemTags 返回 true 时才关窗", async () => {
    h.setItemTags.mockResolvedValueOnce(true);
    const onClose = vi.fn();
    render(<TagEditor open item={item} onClose={onClose} />);

    fireEvent.click(screen.getByText("工作"));
    fireEvent.click(screen.getByRole("button", { name: "确定" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
