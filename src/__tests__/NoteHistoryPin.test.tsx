/**
 * 版本锚定的界面行为（W2）。
 *
 * 后端的核心保证（连改 21 次也挤不掉锚定份）由 Rust 用例盯；这里只盯三件
 * 光看代码很容易说“当然对”、出错了又没任何报错的事：
 *
 * 1. 锚定与来源得真的显示出来（字段接错了只会安静地什么都不显）；
 * 2. 解除锚定**必须**先过确认框，取消就不能碰后端；
 * 3. 选中「当前版本」时不能出现锚定按钮（当前版不在快照表里，无物可锚）。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { NoteHistoryView } from "@/components/notes/NoteHistoryView";

const revs = [
  { id: 2, title: "标题", created_at: "2026-09-02 10:00:00", char_count: 412,
    pinned: false, source_agent: "agent:claude-code" },
  { id: 1, title: "标题", created_at: "2026-09-02 09:00:00", char_count: 380,
    pinned: true, source_agent: "" },
];

const noteRevisionPin = vi.fn(async () => true);
const confirmDialog = vi.fn(async () => true);

vi.mock("@/lib/api", () => ({
  noteRevisionList: async () => revs,
  noteRevisionGet: async () => ({ id: 1, note_id: "n1", title: "标题",
    content: "旧正文", created_at: "2026-09-02 09:00:00", pinned: true, source_agent: "" }),
  noteRevisionPin: (...a: unknown[]) => noteRevisionPin(...(a as [])),
  noteRestore: async () => null,
}));

vi.mock("@/lib/confirm", () => ({
  confirmDialog: (...a: unknown[]) => confirmDialog(...(a as [])),
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: () => {} }),
}));

function renderView() {
  return render(
    <NoteHistoryView
      noteId="n1"
      currentContent="当前正文"
      isDirty={false}
      onBack={() => {}}
      onRestored={() => {}}
    />,
  );
}

describe("版本锚定", () => {
  beforeEach(() => {
    noteRevisionPin.mockClear();
    confirmDialog.mockClear();
  });

  it("锚定徽标与客户端名都要显示，且去掉 agent: 前缀", async () => {
    renderView();
    await waitFor(() => expect(screen.getByText("锚定")).toBeTruthy());

    // 显示具体客户端名而不是统一的「模型改」，且不能把 `agent:` 前缀报给用户
    expect(screen.getByText("claude-code 改")).toBeTruthy();
    expect(screen.queryByText(/agent:/)).toBeNull();

    // 顶部计数要把锚定份单独报出来（它不占 20 份配额）
    expect(screen.getByText("2 份历史 · 1 份锚定")).toBeTruthy();
  });

  it("选中当前版时不出现锚定按钮（当前版不在快照表里）", async () => {
    renderView();
    await waitFor(() => expect(screen.getByText("锚定")).toBeTruthy());

    // 初始选中就是「当前版本」。此时只应有列表里那个徽标，没有按钮。
    expect(screen.queryByRole("button", { name: /^锚定$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /解除锚定/ })).toBeNull();
  });

  it("解除锚定必须先过确认框，取消就不碰后端", async () => {
    confirmDialog.mockResolvedValueOnce(false as never);
    renderView();
    await waitFor(() => expect(screen.getByText("锚定")).toBeTruthy());

    // 选中已锚定的那一行（380 字）
    fireEvent.click(screen.getByText("380 字"));
    const btn = await screen.findByRole("button", { name: /解除锚定/ });
    fireEvent.click(btn);

    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(noteRevisionPin).not.toHaveBeenCalled();
  });

  it("确认后才真的解除，传的是 pinned=false", async () => {
    renderView();
    await waitFor(() => expect(screen.getByText("锚定")).toBeTruthy());

    fireEvent.click(screen.getByText("380 字"));
    fireEvent.click(await screen.findByRole("button", { name: /解除锚定/ }));

    await waitFor(() => expect(noteRevisionPin).toHaveBeenCalledWith(1, false));
  });

  it("未锚定的历史：加锚不弹确认（只会多保留一份，没有可后悔的后果）", async () => {
    renderView();
    await waitFor(() => expect(screen.getByText("锚定")).toBeTruthy());

    fireEvent.click(screen.getByText("412 字"));
    fireEvent.click(await screen.findByRole("button", { name: /^锚定$/ }));

    await waitFor(() => expect(noteRevisionPin).toHaveBeenCalledWith(2, true));
    expect(confirmDialog).not.toHaveBeenCalled();
  });
});
