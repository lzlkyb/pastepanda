/**
 * 冲突对照视图的界面行为（W4a）。
 *
 * 解析逻辑由 `kbConflict.test.ts` 盯；这里只盯三件光看代码很容易说
 * “当然对”、出错了又没任何报错的事：
 *
 * 1. 🔴「用副本那一份」必须先过确认框，取消就不能碰后端；
 * 2. 🔴 顺序必须是「先写原笔记、再删副本」——写失败时**绝不能**删副本，
 *    否则那一份内容就只剩回收站里那一个副本了；
 * 3. 解不出关联时如实降级（只给返回），而不是给一个点了没反应的按钮。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { NoteConflictView } from "@/components/notes/NoteConflictView";
import { CONFLICT_MARK } from "@/lib/kbConflict";

const ORIGIN = "3f2b9c7a-1111-4222-8333-444455556666";

const origin = {
  id: ORIGIN,
  history_id: null,
  title: "周会纪要",
  content: "# 周会纪要\n\n- 验收人：张三",
  created_at: "2026-09-01 09:00:00",
  updated_at: "2026-09-07 14:02:00",
  source_agent: "",
  folder_id: null,
  summary: null,
  daily_date: null,
  tags: [],
};

function copyBody(embeddedContent: string): string {
  return `${CONFLICT_MARK} 这是一份**冲突副本**，来自**对端**那一份（时间戳 1757000000000）。

原笔记 id：\`${ORIGIN}\`

---

---
title: 周会纪要
created: 2026-09-01 09:00:00
updated: 2026-09-07 13:47:00
---

${embeddedContent}
`;
}

const noteGet = vi.fn(async () => origin as unknown);
const noteUpdate = vi.fn(async () => ({ relinked: 0 }) as unknown);
const noteDelete = vi.fn(async () => true);
const confirmDialog = vi.fn(async () => true);

vi.mock("@/lib/api", () => ({
  noteGet: (...a: unknown[]) => noteGet(...(a as [])),
  noteUpdate: (...a: unknown[]) => noteUpdate(...(a as [])),
  noteDelete: (...a: unknown[]) => noteDelete(...(a as [])),
}));

vi.mock("@/lib/confirm", () => ({
  confirmDialog: (...a: unknown[]) => confirmDialog(...(a as [])),
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: () => {} }),
}));

function renderView(content: string, onResolved = () => {}) {
  return render(
    <NoteConflictView
      copyId="copy-1"
      copyContent={content}
      onBack={() => {}}
      onResolved={onResolved}
    />,
  );
}

describe("冲突对照", () => {
  beforeEach(() => {
    noteGet.mockClear();
    noteUpdate.mockClear();
    noteDelete.mockClear();
    confirmDialog.mockClear();
    noteGet.mockImplementation(async () => origin as unknown);
    noteUpdate.mockImplementation(async () => ({ relinked: 0 }) as unknown);
    noteDelete.mockImplementation(async () => true);
    confirmDialog.mockImplementation(async () => true);
  });

  it("两侧列头用在两台机器上都成立的说法，不写「本机/对端」", async () => {
    renderView(copyBody("- 验收人：张三、李四"));
    // 副本正文里那句「来自本机/对端」是建副本那台写的，同步到另一台就反了
    await waitFor(() => expect(screen.getAllByText(/当前保留的/).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/副本里那一份/).length).toBeGreaterThan(0);
  });

  it("🔴 取消确认框就不能碰后端", async () => {
    confirmDialog.mockImplementation(async () => false);
    renderView(copyBody("- 验收人：张三、李四"));
    const btn = await screen.findByText("用副本那一份");
    fireEvent.click(btn);
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(noteUpdate).not.toHaveBeenCalled();
    expect(noteDelete).not.toHaveBeenCalled();
  });

  it("采用时把副本的正文写回原笔记，标题不动", async () => {
    renderView(copyBody("- 验收人：张三、李四"));
    fireEvent.click(await screen.findByText("用副本那一份"));
    await waitFor(() => expect(noteUpdate).toHaveBeenCalled());
    expect(noteUpdate).toHaveBeenCalledWith(ORIGIN, "周会纪要", "- 验收人：张三、李四");
    await waitFor(() => expect(noteDelete).toHaveBeenCalledWith("copy-1"));
  });

  it("🔴 写原笔记失败时绝不删副本", async () => {
    noteUpdate.mockImplementation(async () => null as unknown);
    renderView(copyBody("- 验收人：张三、李四"));
    fireEvent.click(await screen.findByText("用副本那一份"));
    await waitFor(() => expect(noteUpdate).toHaveBeenCalled());
    // 反过来的顺序下，这里副本已经没了、而内容没写进原笔记
    expect(noteDelete).not.toHaveBeenCalled();
  });

  it("「保留当前版」不弹确认、只删副本、不写原笔记", async () => {
    renderView(copyBody("- 验收人：张三、李四"));
    fireEvent.click(await screen.findByText("保留当前版"));
    await waitFor(() => expect(noteDelete).toHaveBeenCalledWith("copy-1"));
    expect(noteUpdate).not.toHaveBeenCalled();
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it("解不出原笔记 id 时如实降级，不给采用按钮", async () => {
    renderView(`${CONFLICT_MARK} 说明被用户改没了\n\n---\n\n正文`);
    await waitFor(() => expect(screen.getByText(/无法自动对照/)).toBeTruthy());
    expect(screen.queryByText("用副本那一份")).toBeNull();
    expect(noteGet).not.toHaveBeenCalled();
  });

  it("原笔记不在了也如实说，而不是空白", async () => {
    noteGet.mockImplementation(async () => null as unknown);
    renderView(copyBody("正文"));
    await waitFor(() => expect(screen.getByText(/不在了/)).toBeTruthy());
    expect(screen.queryByText("用副本那一份")).toBeNull();
  });
});
