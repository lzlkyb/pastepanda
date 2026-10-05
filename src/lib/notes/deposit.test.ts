/**
 * deposit.ts 的守卫单测。
 *
 * 🔴 核心不变量：全项目星标动作只有 togglePinAndDeposit 一条路（规则 #11.1），
 * 它必须保证——开关关时零写入、幂等（已有笔记不再建第二份）、链接卡抓全文、
 * 每次星标只发**一条** toast（双 toast 连发是审查修掉的回归点）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAppStore } from "@/stores/appStore";
import { depositCardOnStar, togglePinAndDeposit } from "./deposit";
import type { HistoryItem } from "@/stores/appStore";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  togglePin: vi.fn(),
  noteByHistory: vi.fn(),
}));
vi.mock("@/lib/api/notes", () => ({ noteCreateAuto: vi.fn() }));
vi.mock("@/lib/api/url", () => ({ fetchUrlArticle: vi.fn() }));

import { togglePin, noteByHistory } from "@/lib/api";
import { noteCreateAuto } from "@/lib/api/notes";
import { fetchUrlArticle } from "@/lib/api/url";

const mockedTogglePin = vi.mocked(togglePin);
const mockedExisting = vi.mocked(noteByHistory);
const mockedCreate = vi.mocked(noteCreateAuto);
const mockedFetch = vi.mocked(fetchUrlArticle);

const baseItem = {
  id: "h1",
  time: "",
  item_type: "text",
  content: "",
  pinned: false,
  source: "",
  workspace: "",
  md5: "",
  tags: [],
  source_icon: "",
  content_type: null,
  ocr_text: null,
  barcodes: [],
};

const item = (over: Partial<HistoryItem>): HistoryItem =>
  ({ ...baseItem, ...over }) as HistoryItem;

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({
    config: { ...useAppStore.getState().config, kb_auto_deposit: false },
    autoDepositCount: 0,
  });
  mockedExisting.mockResolvedValue(null);
});

const richItem = () =>
  item({
    type: "rich",
    text: "文章标题 正文",
    content: "<h1>文章标题</h1><p>正文段落，足够长。</p>",
  });

describe("depositCardOnStar", () => {
  it("开关关 → skipped，零写入零 IPC 抓取", async () => {
    const r = await depositCardOnStar(richItem());
    expect(r.status).toBe("skipped");
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("开关开 + rich 卡 → 走 HTML 管线建草稿，计数 +1", async () => {
    useAppStore.setState({
      config: { ...useAppStore.getState().config, kb_auto_deposit: true },
    });
    mockedCreate.mockResolvedValue({ id: "n1" } as never);
    const r = await depositCardOnStar(richItem());
    expect(r.status).toBe("deposited");
    expect(mockedCreate).toHaveBeenCalledWith("h1", expect.stringContaining("文章标题"), expect.stringContaining("# 文章标题"));
    expect(useAppStore.getState().autoDepositCount).toBe(1);
  });

  it("已有笔记 → existing，不再建第二份（幂等）", async () => {
    useAppStore.setState({
      config: { ...useAppStore.getState().config, kb_auto_deposit: true },
    });
    mockedExisting.mockResolvedValue({ id: "n0" } as never);
    const r = await depositCardOnStar(richItem());
    expect(r.status).toBe("existing");
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(useAppStore.getState().autoDepositCount).toBe(0);
  });

  it("开关开但内容不可转（file 卡）→ skipped_content", async () => {
    useAppStore.setState({
      config: { ...useAppStore.getState().config, kb_auto_deposit: true },
    });
    const r = await depositCardOnStar(item({ type: "file", text: "C:/a.txt" }));
    expect(r.status).toBe("skipped_content");
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("链接卡 → 抓全文建草稿，正文带来源行，而不是裸链接", async () => {
    useAppStore.setState({
      config: { ...useAppStore.getState().config, kb_auto_deposit: true },
    });
    mockedFetch.mockResolvedValue({
      url: "https://mp.weixin.qq.com/s/x",
      title: "好文章",
      author: "某公众号",
      html: "<h1>好文章</h1><p>正文内容。</p>",
    });
    mockedCreate.mockResolvedValue({ id: "n2" } as never);
    const r = await depositCardOnStar(
      item({ type: "text", text: "https://mp.weixin.qq.com/s/x" }),
    );
    expect(r.status).toBe("deposited");
    expect(mockedFetch).toHaveBeenCalledWith("https://mp.weixin.qq.com/s/x");
    const content = mockedCreate.mock.calls[0][2];
    expect(content).toContain("> 来源：微信公众号「某公众号」");
    expect(content).toContain("# 好文章");
  });

  it("链接卡已转过 → existing，不发起抓取（省十几秒）", async () => {
    useAppStore.setState({
      config: { ...useAppStore.getState().config, kb_auto_deposit: true },
    });
    mockedExisting.mockResolvedValue({ id: "n0" } as never);
    const r = await depositCardOnStar(
      item({ type: "text", text: "https://mp.weixin.qq.com/s/x" }),
    );
    expect(r.status).toBe("existing");
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});

describe("togglePinAndDeposit 的 toast 编排（一次星标一条 toast）", () => {
  it("置顶失败 → 只有一条错误提示", async () => {
    const toast = vi.fn();
    mockedTogglePin.mockResolvedValue(null);
    await togglePinAndDeposit(richItem(), undefined, toast);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith("置顶操作失败", "error");
  });

  it("取消置顶 → 不碰沉淀，单条反馈", async () => {
    const toast = vi.fn();
    mockedTogglePin.mockResolvedValue(false);
    await togglePinAndDeposit(richItem(), undefined, toast);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith("已取消置顶", "success");
  });

  it("开关关 → 单条「已置顶」（不发两条连发）", async () => {
    const toast = vi.fn();
    mockedTogglePin.mockResolvedValue(true);
    await togglePinAndDeposit(richItem(), undefined, toast);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith("已置顶", "success");
  });

  it("沉淀成功 → 单条合并文案", async () => {
    const toast = vi.fn();
    mockedTogglePin.mockResolvedValue(true);
    useAppStore.setState({
      config: { ...useAppStore.getState().config, kb_auto_deposit: true },
    });
    mockedCreate.mockResolvedValue({ id: "n1" } as never);
    await togglePinAndDeposit(richItem(), undefined, toast);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith("已置顶，并自动沉淀为草稿", "success");
  });

  it("沉淀失败 → 单条错误带原因，但置顶事实不丢", async () => {
    const toast = vi.fn();
    mockedTogglePin.mockResolvedValue(true);
    useAppStore.setState({
      config: { ...useAppStore.getState().config, kb_auto_deposit: true },
    });
    // api 层口径：写库失败不抛错、返回 null（错误已在 api 层弹过）
    mockedCreate.mockResolvedValue(null);
    await togglePinAndDeposit(richItem(), undefined, toast);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining("已置顶，但自动沉淀失败"),
      "error",
    );
  });
});
