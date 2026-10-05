/**
 * isArticleCard 的守卫单测：菜单注入的判定口径（「抓取全文存知识库」
 * 只对纯 http(s) 链接的 text 卡片出现）。
 *
 * 以及 aiComposeArticleForCard 的「链接卡先抓再洗」守卫（2026-10-05 实测翻车：
 * 直接把 URL 字符串喂给 AI，模型产出 `# https://…`）。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { HistoryItem } from "@/stores/appStore";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  noteByHistory: vi.fn().mockResolvedValue(null),
  noteTouch: vi.fn(),
}));
vi.mock("@/lib/api/ai", () => ({ aiRun: vi.fn() }));
vi.mock("@/lib/api/url", () => ({ fetchUrlArticle: vi.fn() }));

import { isArticleCard, aiComposeArticleForCard } from "./article";
import { noteByHistory } from "@/lib/api";
import { aiRun } from "@/lib/api/ai";
import { fetchUrlArticle } from "@/lib/api/url";
import { useDialogStore } from "@/stores/dialogStore";

const item = (over: Partial<HistoryItem>): HistoryItem =>
  ({
    id: "h1",
    type: "text",
    text: "",
    content: "",
    time: "",
    item_type: "text",
    pinned: false,
    source: "",
    workspace: "",
    md5: "",
    tags: [],
    ...over,
  }) as HistoryItem;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(noteByHistory).mockResolvedValue(null);
});

describe("isArticleCard", () => {
  it("纯 http(s) 链接的 text 卡片命中（含首尾空白）", () => {
    expect(isArticleCard(item({ type: "text", text: "https://mp.weixin.qq.com/s/abc" }))).toBe(true);
    expect(isArticleCard(item({ type: "text", text: "  http://example.com/a?b=1\n" }))).toBe(true);
  });

  it("非 http(s) 协议不命中（后端抓取只放行 http/https）", () => {
    expect(isArticleCard(item({ type: "text", text: "ftp://example.com/x" }))).toBe(false);
    expect(isArticleCard(item({ type: "text", text: "file:///C:/a.txt" }))).toBe(false);
  });

  it("链接外还有别的文字不算纯链接卡", () => {
    expect(
      isArticleCard(item({ type: "text", text: "看看这篇 https://mp.weixin.qq.com/s/abc 好文" })),
    ).toBe(false);
  });

  it("只有 text 类型参与：rich 卡即使文本是链接也不命中", () => {
    expect(isArticleCard(item({ type: "rich", text: "https://mp.weixin.qq.com/s/abc" }))).toBe(false);
    expect(isArticleCard(item({ type: "image", text: "https://example.com/a" }))).toBe(false);
  });
});

describe("aiComposeArticleForCard · 链接卡先抓再洗（守卫）", () => {
  const linkItem = () => item({ type: "text", text: "https://mp.weixin.qq.com/s/abc" });
  const toast = vi.fn();

  beforeEach(() => {
    toast.mockClear();
    vi.mocked(fetchUrlArticle).mockResolvedValue({
      url: "https://mp.weixin.qq.com/s/abc",
      title: "好文章",
      author: "某公众号",
      html: "<h1>好文章</h1><p>正文内容足够长。</p>",
    });
    vi.mocked(aiRun).mockResolvedValue({
      status: "ok",
      content: "# 好文章\n\n洗好的正文。",
      model: "test",
      cached: false,
      promptTokens: 1,
      completionTokens: 1,
      truncated: false,
    });
  });

  it("喂给 AI 的是抓回来的文章，不是 URL 字符串", async () => {
    await aiComposeArticleForCard(linkItem(), toast);
    expect(fetchUrlArticle).toHaveBeenCalledWith("https://mp.weixin.qq.com/s/abc");
    const fed = vi.mocked(aiRun).mock.calls[0][1];
    expect(fed).toContain("来源：微信公众号「某公众号」");
    expect(fed).not.toBe("https://mp.weixin.qq.com/s/abc");
  });

  it("成功时弹窗用 og:title，正文是 AI 洗好的稿", async () => {
    const spy = vi.fn();
    useDialogStore.setState({ openNote: spy });
    await aiComposeArticleForCard(linkItem(), toast);
    expect(spy).toHaveBeenCalledTimes(1);
    const draft = spy.mock.calls[0][0];
    expect(draft.title).toBe("好文章");
    expect(draft.content).toContain("洗好的正文");
  });

  it("AI 失败时交付抓到的本地全文（抓取不能白费）", async () => {
    vi.mocked(aiRun).mockRejectedValue("模型超时");
    const spy = vi.fn();
    useDialogStore.setState({ openNote: spy });
    await aiComposeArticleForCard(linkItem(), toast);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].content).toContain("正文内容足够长");
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("已放入未经清洗的全文"), "info");
  });

  it("AI 截断同样退回本地全文，不交付半截稿", async () => {
    vi.mocked(aiRun).mockResolvedValue({
      status: "ok",
      content: "# 半篇",
      model: "test",
      cached: false,
      promptTokens: 1,
      completionTokens: 1,
      truncated: true,
    });
    const spy = vi.fn();
    useDialogStore.setState({ openNote: spy });
    await aiComposeArticleForCard(linkItem(), toast);
    expect(spy.mock.calls[0][0].content).toContain("正文内容足够长");
  });

  it("已转过笔记 → 打开已有那条，不抓不洗（幂等）", async () => {
    vi.mocked(noteByHistory).mockResolvedValue({
      id: "n0",
      title: "已有的",
      content: "旧文",
    } as never);
    const spy = vi.fn();
    useDialogStore.setState({ openNote: spy });
    await aiComposeArticleForCard(linkItem(), toast);
    expect(fetchUrlArticle).not.toHaveBeenCalled();
    expect(aiRun).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].noteId).toBe("n0");
  });
});
