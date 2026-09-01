/**
 * 关闭笔记弹窗不能报错（回归）。
 *
 * 真实翻车：`NoteDialogInner` 曾经自己去 store 里读 `noteDraft` 并加了 `!`。
 * 关窗时 `noteDraft` 先变 null，而 AnimatePresence 为了退场动画会把组件多留一拍，
 * 那一拍里就是 `Cannot read properties of null (reading 'title')`。
 *
 * 钉的是行为而不是写法：不管 draft 怎么传，**把 noteDraft 置 null 后不能抛错**。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { NoteDialog } from "@/components/notes/NoteDialog";
import { useDialogStore } from "@/stores/dialogStore";

// CodeMirror 在 jsdom 里不需要真的跑起来：本用例只关心挂载/卸载时会不会炸
vi.mock("@/components/notes/NoteEditorPane", () => ({
  NoteEditorPane: () => null,
}));

// jsdom 没有 matchMedia，而弹窗动画要读 prefers-reduced-motion
beforeAll(() => {
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

describe("NoteDialog 关闭", () => {
  beforeEach(() => {
    useDialogStore.setState({ noteDraft: null });
  });

  it("noteDraft 置 null 后不报错（退场动画那一拍）", () => {
    const { unmount } = render(<NoteDialog />);

    act(() => {
      useDialogStore.getState().openNote({
        noteId: "n1",
        historyId: null,
        title: "标题",
        content: "正文",
      });
    });

    // 关窗：以前就是在这一步报 Cannot read properties of null
    expect(() =>
      act(() => {
        useDialogStore.getState().closeNote();
      }),
    ).not.toThrow();

    unmount();
  });

  it("连续开关两次也不报错", () => {
    render(<NoteDialog />);
    for (const id of ["a", "b"]) {
      act(() => {
        useDialogStore.getState().openNote({ noteId: id, title: id, content: "" });
      });
      act(() => {
        useDialogStore.getState().closeNote();
      });
    }
    expect(useDialogStore.getState().noteDraft).toBeNull();
  });
});
