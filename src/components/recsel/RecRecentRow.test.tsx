/**
 * RecRecentRow 守卫（设计稿 §06：一行两枚动作）。
 *
 * 钉住四件这次重做的事：① 动作收口（一行只有一枚带文字主按钮 + ⋯，长尾关着时不在读屏树）；
 * ② 删除行内二次确认（上膛 → 确认才真删）；③ 提示写在它所属的行；④ 空态只留一句。
 * GIF 各态的行为守卫在 recOfficeClearFlow.test.tsx（打开菜单后点），这里不重复。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecRecentList } from "@/components/recsel/RecRecentList";

const api = vi.hoisted(() => ({
  recListFiles: vi.fn(),
  recDeleteFile: vi.fn(),
  recOpenFile: vi.fn(),
  recOpenPreview: vi.fn(),
  recReveal: vi.fn(),
  recTrimStatus: vi.fn(),
  recTrimCancel: vi.fn(),
  recGifStart: vi.fn(),
  recGifStatus: vi.fn(),
  recGifCancel: vi.fn(),
}));
vi.mock("@/lib/api/rec", () => api);
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ close: vi.fn() }) }));
vi.mock("@/stores/appStore", () => ({ useAppStore: (fn: (s: unknown) => unknown) => fn({ config: { rec_hotkey: "Ctrl+Alt+R" } }) }));

const file = {
  path: "/a.mp4",
  name: "屏幕录制_2026-10-16_204825.mp4",
  bytes: 1024 * 1024 * 22.7,
  durationMs: 164000,
  note: "未检测到系统声音",
};

beforeEach(() => {
  vi.clearAllMocks();
  api.recListFiles.mockResolvedValue([file]);
  api.recDeleteFile.mockResolvedValue(undefined);
  api.recOpenFile.mockResolvedValue(undefined);
  api.recOpenPreview.mockResolvedValue(undefined);
  api.recReveal.mockResolvedValue(undefined);
  api.recTrimStatus.mockResolvedValue({ running: false, percent: 0, donePath: null, error: null });
  api.recGifStatus.mockResolvedValue({ running: false, percent: 0, donePath: null, error: null });
});
afterEach(() => cleanup());

describe("最近录制：一行两枚动作（设计稿 §06）", () => {
  it("默认行只有一枚带文字的主按钮 + ⋯；长尾动作关着时不在读屏树里", async () => {
    render(<RecRecentList />);
    const row = await screen.findByRole("listitem");
    const names = within(row)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent);
    // 改前是 4–6 枚 11px 文字 chip 和文件名抢眼；现在一行就这三枚
    expect(names).toEqual([file.name, "预览与裁剪", "更多操作"]);
    expect(screen.queryByRole("button", { name: "打开文件夹" })).toBeNull();
    expect(screen.queryByRole("button", { name: "导出 GIF" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
  });

  it("⋯ 菜单里是打开文件夹 / 导出 GIF / 删除，点别处收起", async () => {
    render(<RecRecentList />);
    fireEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("button", { name: "打开文件夹" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "导出 GIF" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除" })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("button", { name: "打开文件夹" })).toBeNull();
  });

  it("删除走行内二次确认：菜单里点删除先上膛，确认才真删", async () => {
    render(<RecRecentList />);
    fireEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    // 上膛：整行换成确认态，且**没有**真的删（改前是两枚并排红 chip，点一下就没）
    expect(api.recDeleteFile).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "确认删除？" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "保留" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "打开文件夹" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "确认删除？" }));
    await waitFor(() => expect(api.recDeleteFile).toHaveBeenCalledWith("/a.mp4"));
  });

  it("上膛后点保留：收起来，文件还在", async () => {
    render(<RecRecentList />);
    fireEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "保留" }));
    expect(screen.queryByRole("button", { name: "确认删除？" })).toBeNull();
    expect(api.recDeleteFile).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "预览与裁剪" })).toBeTruthy();
  });

  it("提示写在它所属的行：note 跟着那段录像，不在列表底部放全局条", async () => {
    render(<RecRecentList />);
    const row = await screen.findByRole("listitem");
    expect(within(row).getByText("未检测到系统声音")).toBeTruthy();
    // 全局通道（actErr）此刻必须空着
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("空态只留一句：不包含指向上方按钮的后半句", async () => {
    api.recListFiles.mockResolvedValue([]);
    render(<RecRecentList />);
    const empty = await screen.findByText(/还没有录制/);
    expect(empty.textContent).not.toMatch(/点击上方|开始第一段|最多 5 个|当前录屏目录/);
    expect(empty.textContent).toContain("Ctrl+Alt+R");
  });

  it("GIF 完成后主按钮变成「打开 GIF」，菜单里能定位产物", async () => {
    api.recGifStatus.mockResolvedValue({ running: false, percent: 100, donePath: "/a.gif", error: null });
    render(<RecRecentList />);
    fireEvent.click(await screen.findByRole("button", { name: "打开 GIF" }));
    await waitFor(() => expect(api.recOpenFile).toHaveBeenCalledWith("/a.gif"));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("button", { name: "定位 GIF 文件" }));
    await waitFor(() => expect(api.recReveal).toHaveBeenCalledWith("/a.gif"));
  });
});
