/**
 * `useNoteMenu` —— 菜单从 `NoteList` 搬到公共 hook 后行为不变（2026-09-07 批 4）。
 *
 * 为何要这些用例：搬家后菜单多了一个消费者（第三栏头部的 `⋯`），
 * 而菜单的形状全是条件分支（置顶/取消置顶、没文件夹时不出移动项、
 * 已在未分类时不给「移回未分类」）。这些分支之前只靠人看。
 */
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useNoteMenu } from "@/components/notes/useNoteMenu";
import type { Note, NoteFolder } from "@/lib/api";

function note(over: Partial<Note> = {}): Note {
  return {
    id: "n1",
    history_id: null,
    title: "测试笔记",
    content: "正文",
    created_at: "2026-09-07T00:00:00Z",
    updated_at: "2026-09-07T00:00:00Z",
    source_agent: "",
    folder_id: null,
    summary: null,
    daily_date: null,
    tags: [],
    ...over,
  } as Note;
}

function folder(id: string, name: string): NoteFolder {
  return {
    id,
    name,
    parent_id: null,
    sort_order: 0,
    created_at: "2026-09-07T00:00:00Z",
    note_count: 0,
    depth: 0,
  };
}

function setup(folders: NoteFolder[] = []) {
  const onSetFolder = vi.fn();
  const onDelete = vi.fn();
  const onTogglePin = vi.fn();
  const { result } = renderHook(() =>
    useNoteMenu({ folders, onSetFolder, onDelete, onTogglePin }),
  );
  return { result, onSetFolder, onDelete, onTogglePin };
}

describe("useNoteMenu · buildMenu", () => {
  it("置顶在最上、删除在最下且带 danger（风险梯度从上到下递增）", () => {
    const { result } = setup([folder("f1", "工作")]);
    const items = result.current.buildMenu(note());
    expect(items[0].label).toBe("置顶");
    expect(items[items.length - 1].label).toBe("删除笔记");
    expect(items[items.length - 1].danger).toBe(true);
  });

  it("已置顶的笔记第一项变成「取消置顶」", () => {
    const { result } = setup();
    expect(result.current.buildMenu(note({ pinned: true }))[0].label).toBe("取消置顶");
    expect(result.current.buildMenu(note({ pinned: false }))[0].label).toBe("置顶");
  });

  it("一个文件夹都没建时不出「移动到文件夹」（不弹空子菜单）", () => {
    const { result } = setup([]);
    const labels = result.current.buildMenu(note()).map((i) => i.label);
    expect(labels).not.toContain("移动到文件夹");
    expect(labels).toEqual(["置顶", "删除笔记"]);
  });

  it("点菜单项调到对应回调", () => {
    const { result, onDelete, onTogglePin } = setup();
    const n = note();
    const items = result.current.buildMenu(n);
    items[0].onClick?.();
    items[items.length - 1].onClick?.();
    expect(onTogglePin).toHaveBeenCalledWith(n);
    expect(onDelete).toHaveBeenCalledWith(n);
  });
});

describe("useNoteMenu · folderMenu", () => {
  it("已在未分类时不给「未分类」这一项", () => {
    const { result } = setup([folder("f1", "工作")]);
    const labels = result.current.folderMenu(note({ folder_id: null })).map((i) => i.label);
    expect(labels).toEqual(["工作"]);
  });

  it("在某个文件夹里时，首项是「未分类」且不列当前所在的那个", () => {
    const { result } = setup([folder("f1", "工作"), folder("f2", "生活")]);
    const labels = result.current.folderMenu(note({ folder_id: "f1" })).map((i) => i.label);
    expect(labels).toEqual(["未分类", "生活"]);
  });

  it("「未分类」与真文件夹之间有分隔线", () => {
    const { result } = setup([folder("f1", "工作"), folder("f2", "生活")]);
    const items = result.current.folderMenu(note({ folder_id: "f1" }));
    // 首项是「未分类」，紧接的第一个真文件夹带 separator
    expect(items[0].separator).toBeFalsy();
    expect(items[1].separator).toBe(true);
  });

  it("没「未分类」首项时不凭空加分隔线", () => {
    const { result } = setup([folder("f1", "工作"), folder("f2", "生活")]);
    const items = result.current.folderMenu(note({ folder_id: null }));
    expect(items.every((i) => !i.separator)).toBe(true);
  });

  it("点文件夹项传对的 folderId（未分类 = null）", () => {
    const { result, onSetFolder } = setup([folder("f1", "工作")]);
    const n = note({ folder_id: "f1" });
    const items = result.current.folderMenu(n);
    items[0].onClick?.(); // 未分类
    expect(onSetFolder).toHaveBeenCalledWith(n, null);
  });
});
