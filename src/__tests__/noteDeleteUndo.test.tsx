/**
 * 删笔记的「不弹确认 + 可撤销」（UI 规则 U4.1 / U4.3）。
 *
 * 🔴 为何要用例守着：这条改的是**删除**这个最高频动作的手感，
 * 而它最容易在后续维护里被「顺手加个确认框更安全」改回去。
 * 那句直觉是错的：确认框拦住的是**每一次正确的删除**，
 * 而撤销只在出错那一次付出成本——后端 `note_delete` 本来就是软删。
 *
 * 四条分别盯四件事：不该弹的不弹、该弹的（未保存改动）要弹、
 * 撤销真能捞回来、批量时失败的那几条不能混进撤销集。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const h = vi.hoisted(() => ({
  toast: vi.fn(),
  confirmDialog: vi.fn(),
  noteDelete: vi.fn(),
  noteRestoreDeleted: vi.fn(),
  /**
   * 敲定的不是「6000」而是「用的是撤销窗口那个常量」。
   * 写死 6000 的话，哪天把真实窗口调成 8 秒，这条会在行为没错的情况下红。
   */
  UNDO_MS: 6000,
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: h.toast }),
  UNDO_WINDOW_MS: h.UNDO_MS,
}));
vi.mock("@/lib/confirm", () => ({ confirmDialog: h.confirmDialog }));
vi.mock("@/lib/api", () => ({
  noteDelete: h.noteDelete,
  noteRestoreDeleted: h.noteRestoreDeleted,
  noteSetFolder: vi.fn(async () => true),
  noteTogglePin: vi.fn(async () => true),
}));

import { useNoteActions, type NoteActionsOpts } from "@/components/notes/useNoteActions";
import type { Note } from "@/lib/api";

function note(id: string, over: Partial<Note> = {}): Note {
  return {
    id,
    history_id: null,
    title: `笔记 ${id}`,
    content: "正文",
    created_at: "2026-09-09T00:00:00Z",
    updated_at: "2026-09-09T00:00:00Z",
    source_agent: "",
    folder_id: null,
    summary: null,
    daily_date: null,
    tags: [],
    ...over,
  } as Note;
}

const n1 = note("n1");
const n2 = note("n2");

function setup(over: Partial<NoteActionsOpts> = {}) {
  // opts 在 renderHook 外面建一次：每次渲染新建一个的话，
  // hook 里每个 useCallback 的依赖都会变，测的就不是真实行为了。
  const opts: NoteActionsOpts = {
    notes: [n1, n2],
    activeNote: null,
    isActiveDirty: () => false,
    clearActive: vi.fn(),
    removeLocally: vi.fn(),
    refreshAll: vi.fn(),
    ...over,
  };
  return renderHook(() => useNoteActions(opts));
}

/** 把微任务队列排干净。撤销回调是 `() => void undoDelete(...)`，拿不到它的 promise。 */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  h.toast.mockReset();
  h.confirmDialog.mockReset().mockResolvedValue(true);
  h.noteDelete.mockReset().mockResolvedValue(true);
  h.noteRestoreDeleted.mockReset().mockResolvedValue(true);
});

describe("删笔记：不弹确认，给撤销", () => {
  it("删一条**不**弹确认框——它可撤销（U4.1）", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.handleDelete(n1);
    });
    expect(h.confirmDialog).not.toHaveBeenCalled();
    expect(h.noteDelete).toHaveBeenCalledWith("n1", null);
  });

  it("回执带「撤销」，点了就把它从回收站捞回来", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.handleDelete(n1);
    });

    const [, , duration, onUndo, label] = h.toast.mock.calls[0];
    expect(label).toBe("撤销");
    // 时长要是撤销窗口而不是 success 默认的 4 秒：
    // 一条带撤销的 toast 比普通回执多一件事要做，得给够时间（U4.2）。
    expect(duration).toBe(h.UNDO_MS);

    (onUndo as () => void)();
    await flush();
    expect(h.noteRestoreDeleted).toHaveBeenCalledWith("n1", null);
  });

  it("只有**未保存的修改**才弹确认——那一段撤销真的救不回（U4.3）", async () => {
    h.confirmDialog.mockResolvedValue(false);
    const { result } = setup({ activeNote: n1, isActiveDirty: () => true });
    await act(async () => {
      await result.current.handleDelete(n1);
    });
    expect(h.confirmDialog).toHaveBeenCalledTimes(1);
    // 用户点了取消，就不能删
    expect(h.noteDelete).not.toHaveBeenCalled();
  });

  it("批量删除：失败的那条**不进撤销集**", async () => {
    // n2 删不掉。若把它也算进撤销集，点撤销就会去恢复一条压根没删成的笔记，
    // 然后报一个用户看不懂的失败。
    h.noteDelete.mockImplementation(async (id: string) => id !== "n2");
    const { result } = setup();

    act(() => result.current.handleRowSelect(0, "toggle"));
    act(() => result.current.handleRowSelect(1, "toggle"));
    await act(async () => {
      await result.current.handleBatchDelete();
    });

    const [msg, type, , onUndo] = h.toast.mock.calls[0];
    expect(type).toBe("error");
    expect(msg).toContain("1 条失败");

    (onUndo as () => void)();
    await flush();
    expect(h.noteRestoreDeleted).toHaveBeenCalledTimes(1);
    expect(h.noteRestoreDeleted).toHaveBeenCalledWith("n1", null);
  });
});
