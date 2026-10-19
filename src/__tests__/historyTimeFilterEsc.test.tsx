/**
 * HistoryTimeFilter Esc 面板守卫。
 *
 * 🔴 面板打开时按 Esc 必须就地关闭面板，事件不许冒泡出去：App 的全局 Esc 冒泡链
 * 会一路落到 hide_window——关个时间筛选面板把整个主窗口藏掉。
 *
 * 防假绿：containKeys 旧实现（Escape 放行）下 document 冒泡监听必然收到事件，
 * 用例 ①红；本用例同时用「未打开时放行」做机制对照（用例 ②），证明拦的是 open 态
 * 而不是所有 Escape。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { HistoryTimeFilter } from "@/components/history-time/HistoryTimeFilter";

vi.mock("@/stores/appStore", () => ({
  useAppStore: (sel: (s: unknown) => unknown) => sel(mockStore),
}));
vi.mock("@/hooks/useHistoryTimeDistribution", () => ({
  useHistoryTimeDistribution: () => ({ data: null, loading: false, error: null, selectionCount: null }),
}));

const mockStore = {
  timeFilter: "all",
  setTimeFilter: vi.fn(),
  searchKeyword: "",
  filterType: "all",
  sourceFilter: null,
  config: { theme: "light" },
};

describe("HistoryTimeFilter Esc 层级", () => {
  let docSpy: (e: KeyboardEvent) => void;
  let calls = 0;

  beforeEach(() => {
    calls = 0;
    docSpy = () => { calls += 1; };
    document.addEventListener("keydown", docSpy);
  });
  afterEach(() => {
    document.removeEventListener("keydown", docSpy);
    cleanup();
  });

  it("面板打开时按 Esc：面板关闭，事件不冒泡到 document（App 藏窗链收不到）", async () => {
    const { container } = render(<HistoryTimeFilter />);
    fireEvent.click(screen.getByTitle("按日期或时段查找记录"));
    const panel = await screen.findByRole("dialog");
    fireEvent.keyDown(panel, { key: "Escape", bubbles: true });
    // 面板走自己的 onOpenChange(false) 关闭
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // 关键断言：事件被 stopPropagation，document 上的全局监听收不到
    expect(calls).toBe(0);
    void container;
  });

  it("机制对照：面板未打开时 Escape 正常冒泡（拦的是 open 态，不是所有 Esc）", () => {
    render(<HistoryTimeFilter />);
    fireEvent.keyDown(screen.getByTitle("按日期或时段查找记录"), { key: "Escape", bubbles: true });
    expect(calls).toBeGreaterThan(0);
  });
});
