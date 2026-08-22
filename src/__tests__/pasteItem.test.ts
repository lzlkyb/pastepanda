/**
 * 「按类型分派粘贴」的收口测试。
 *
 * 这段分派逻辑此前在 5 处各写一份（Card 右键 / 主窗 Enter / 栈粘贴 / 托盘弹窗 /
 * 快捷面板），而且已经互相漂移——正是两次同类 bug 的成因：
 * v6.15「image/rich/file 三个分支全漏了粘贴信号」、以及卡片右键至今没有
 * image/file 分支（图片粘出 "[图片] 1860x915" 占位文本、文件粘出裸文件名）。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, HistoryItem } from "@/stores/appStore";
import { pasteHistoryItem } from "@/lib/pasteItem";

function makeItem(o: Partial<HistoryItem> & { id: string; text: string }): HistoryItem {
  return {
    type: "text" as const,
    time: "2026-01-01 12:00:00",
    content: "",
    pinned: false,
    source: "clipboard",
    workspace: "默认",
    ...o,
  };
}

/** 某个 invoke 命令被调用时的参数 */
function callArgs(cmd: string): Record<string, unknown> | undefined {
  const c = vi.mocked(invoke).mock.calls.find((x) => x[0] === cmd);
  return c?.[1] as Record<string, unknown> | undefined;
}
function called(cmd: string): boolean {
  return vi.mocked(invoke).mock.calls.some((c) => c[0] === cmd);
}
function pasteEvents(): Array<Record<string, unknown>> {
  return vi
    .mocked(invoke)
    .mock.calls.filter((c) => c[0] === "action_event_log")
    .map((c) => (c[1] as { event: Record<string, unknown> }).event)
    .filter((e) => e.actionId === "paste");
}

function setPlainDefault(plain: boolean) {
  useAppStore.setState({
    config: { ...useAppStore.getState().config, paste_format_default: plain ? "plain" : "auto" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue({ success: true });
  setPlainDefault(false);
});

describe("pasteHistoryItem 按类型分派", () => {
  it("图片走 paste_image，绝不粘占位文本", async () => {
    const item = makeItem({ id: "i1", text: "[图片] 1860x915", type: "image", content: "C:\\img\\a.png" });
    const r = await pasteHistoryItem(item);

    expect(r.ok).toBe(true);
    expect(r.kind).toBe("image");
    expect(callArgs("paste_image")).toEqual({ imagePath: "C:\\img\\a.png" });
    // 这条是卡片右键此前的真 bug：图片走到了纯文本分支，把 "[图片] 1860x915" 打进文档
    expect(called("paste_text")).toBe(false);
  });

  it("文件粘完整路径（content），不是裸文件名（text）", async () => {
    const item = makeItem({ id: "f1", text: "report.xlsx", type: "file", content: "D:\\docs\\report.xlsx" });
    const r = await pasteHistoryItem(item);

    expect(r.kind).toBe("file");
    expect(callArgs("paste_text")).toEqual({ text: "D:\\docs\\report.xlsx" });
  });

  it("rich 条目走富文本", async () => {
    const item = makeItem({ id: "r1", text: "纯文本版", type: "rich", content: "<b>富文本</b>" });
    const r = await pasteHistoryItem(item);

    expect(r.kind).toBe("rich");
    expect(callArgs("paste_rich")).toMatchObject({ plainText: "纯文本版" });
  });

  it("doc 条目粘贴前清洗 CF_HTML（mso 噪声不打进目标应用）", async () => {
    const dirty = '<p class="MsoNormal"><o:p>脏</o:p>正文</p>';
    const item = makeItem({ id: "d1", text: "正文", type: "doc", content: dirty });
    const r = await pasteHistoryItem(item);

    expect(r.kind).toBe("rich");
    const html = String(callArgs("paste_rich")?.htmlFragment ?? "");
    expect(html).not.toContain("o:p");
    expect(html).not.toContain("MsoNormal");
  });

  it("paste_format_default=plain 时 doc/rich 全退纯文本", async () => {
    setPlainDefault(true);
    const item = makeItem({ id: "r2", text: "纯文本版", type: "rich", content: "<b>富</b>" });
    const r = await pasteHistoryItem(item);

    expect(r.kind).toBe("text");
    expect(called("paste_rich")).toBe(false);
    expect(callArgs("paste_text")).toEqual({ text: "纯文本版" });
  });

  it("普通文本走纯文本", async () => {
    const r = await pasteHistoryItem(makeItem({ id: "t1", text: "hello" }));
    expect(r.kind).toBe("text");
    expect(callArgs("paste_text")).toEqual({ text: "hello" });
  });

  it("成功后回写粘贴信号，带 historyId 与列表下标", async () => {
    await pasteHistoryItem(makeItem({ id: "t2", text: "hello", content_type: "json" }), 4);
    await vi.waitFor(() => expect(pasteEvents().length).toBe(1));

    const ev = pasteEvents()[0];
    expect(ev.historyId).toBe("t2");
    expect(ev.contentType).toBe("json");
    expect(ev.pasteIndex).toBe(4);
  });

  it("粘贴失败时不回写（否则把没粘上的内容标成已用过）", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "paste_text") return Promise.reject(new Error("失败"));
      return Promise.resolve({ success: true });
    });
    const r = await pasteHistoryItem(makeItem({ id: "t3", text: "hello" }));

    expect(r.ok).toBe(false);
    await new Promise((res) => setTimeout(res, 20));
    expect(pasteEvents()).toHaveLength(0);
  });
});
