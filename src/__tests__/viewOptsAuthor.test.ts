/**
 * 写入者筛选（§7.2）的两个收口点。
 *
 * 🔴 为何钉这两个而不是钉面板：`viewOpts.ts` 里那段注释已经记了
 * 这个坑**应验过两次**（加标签筛选与修改时间时都只改了工具栏那份）。
 * 漏了不报错，而是筛着条件提问时回答卡声称范围是整个文件夹——
 * 用户会把「没命中」读成「这个文件夹里真没有」。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTE_VIEW,
  NOTE_AUTHORS,
  isNoteViewFiltered,
  noteViewChips,
  type NoteAuthor,
  type NoteViewOpts,
} from "@/lib/notes/viewOpts";

const withAuthor = (author: NoteAuthor): NoteViewOpts => ({ ...DEFAULT_NOTE_VIEW, author });

describe("写入者筛选", () => {
  it("默认不筛，且默认态不算「已筛选」", () => {
    expect(DEFAULT_NOTE_VIEW.author).toBe("");
    expect(isNoteViewFiltered(DEFAULT_NOTE_VIEW)).toBe(false);
    expect(noteViewChips(DEFAULT_NOTE_VIEW, () => {})).toEqual([]);
  });

  it("🔴 三个非空值都要让 isNoteViewFiltered 为真", () => {
    // 逐个跑而不是只试一个：少写一个值的后果是那一个选项静默不算筛选。
    for (const a of ["ai", "ai_edited", "human"] as const) {
      expect(isNoteViewFiltered(withAuthor(a))).toBe(true);
    }
  });

  it("每个非空值都得出一个可清除的 chip", () => {
    for (const a of ["ai", "ai_edited", "human"] as const) {
      const chips = noteViewChips(withAuthor(a), () => {});
      expect(chips).toHaveLength(1);
      expect(chips[0].label.length).toBeGreaterThan(0);
    }
  });

  it("🔴 chip 上要把 AI 补回去（单看“改过我的”不知道是谁改的）", () => {
    // chips 行里各种条件混在一起，同 B4 那条「7 天内**改过**」的取舍。
    expect(noteViewChips(withAuthor("ai_edited"), () => {})[0].label).toBe("AI 改过我的");
  });

  it("chip 的 onClear 只清 author，不碰其它维度", () => {
    let patch: Partial<NoteViewOpts> | null = null;
    const chips = noteViewChips(withAuthor("ai"), (p) => {
      patch = p;
    });
    chips[0].onClear();
    expect(patch).toEqual({ author: "" });
  });

  it("🔴 选项表与后端哨兵值一一对应", () => {
    // 后端 `push_author_filter` 认的就是这四个值。两边漂了不会报错，
    // 只是那个选项点下去一点反应都没有（后端当成 `agent:xxx` 去匹配）。
    expect(NOTE_AUTHORS.map((o) => o.value)).toEqual(["", "ai", "ai_edited", "human"]);
  });

  it("🔴 标签不得与「来源」行的「手工新建」撞名", () => {
    // 「手工新建」指的是**不是从剪贴板来的**，跟「是不是人写的」是两回事：
    // 一篇 AI 建的笔记也是「手工新建」。两个维度撞名会让用户以为它们是同一个筛选。
    const labels = NOTE_AUTHORS.map((o) => o.label);
    expect(labels).not.toContain("手工新建");
    expect(labels).not.toContain("手工写的");
  });
});
