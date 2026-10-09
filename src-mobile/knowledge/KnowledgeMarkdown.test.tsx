import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "@/lib/utils";
import { mobileKnowledgeImage } from "@/lib/api/mobileKnowledge";
import { KnowledgeMarkdown } from "./KnowledgeMarkdown";
vi.mock("@/lib/utils", () => ({ copyToClipboard: vi.fn() }));
vi.mock("@/lib/api/mobileKnowledge", () => ({ mobileKnowledgeImage: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("手机阅读安全与原位反馈", () => {
  it("HTML和危险链接不能发请求、创建按钮或执行脚本", () => {
    const onLink = vi.fn();
    const { container } = render(<KnowledgeMarkdown content={'<img src="https://tracking.test/a" onerror="alert(1)">\n<script>alert(1)</script>\n\n[x](javascript:alert%281%29)\n\n[file](file:///private/data)'} onLink={onLink} />);
    expect(container.querySelector("img,script,iframe")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelector('a[href^="file:"]')).toBeNull();
    fireEvent.click(screen.getByText("x"));
    expect(onLink).toHaveBeenCalledWith("", false);
  });
  it("双链不污染代码片段；正文双链传递精确标题", () => {
    const onLink = vi.fn();
    render(<KnowledgeMarkdown content={'[[会议笔记]]\n\n`[[代码文字]]`\n\n```text\n[[代码块]]\n```'} onLink={onLink} />);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    fireEvent.click(screen.getByRole("link", { name: "会议笔记" }));
    expect(onLink).toHaveBeenCalledWith("会议笔记", true);
  });
  it("复制真实代码保留换行，失败反馈在代码块里", async () => {
    vi.mocked(copyToClipboard).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<KnowledgeMarkdown content={'```text\nline one\nline two\n```'} onLink={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
    await screen.findByText("未能复制，请重试或长按选择文字");
    expect(copyToClipboard).toHaveBeenCalledWith("line one\nline two");
    fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
    await screen.findByText("已复制代码");
  });
  it("外部图片不在正文请求网络，用户点击交给网页确认流程", () => {
    const onLink = vi.fn();
    const { container } = render(<KnowledgeMarkdown content="![外部图](https://example.test/a.png)" onLink={onLink} />);
    expect(container.querySelector("img")).toBeNull();
    expect(mobileKnowledgeImage).not.toHaveBeenCalled();
    expect(onLink).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "打开外部图片" }));
    expect(onLink).toHaveBeenCalledWith("https://example.test/a.png", false);
    expect(container.querySelector("img")).toBeNull();
  });
  it("本机图片经安全后端读取，缺图后真实重试；不转换任意file地址", async () => {
    vi.mocked(mobileKnowledgeImage).mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValueOnce("data:image/png;base64,aGVsbG8=");
    const { container } = render(<KnowledgeMarkdown content="![本机图](images/abcdef.png)" onLink={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "加载本机图片" }));
    await screen.findByText("图片尚未在手机上可用。正文仍可阅读。");
    expect(mobileKnowledgeImage).toHaveBeenCalledWith("images/abcdef.png");
    fireEvent.click(screen.getByRole("button", { name: "重试图片" }));
    await waitFor(() => expect(mobileKnowledgeImage).toHaveBeenCalledTimes(2));
    expect(container.querySelector('img[src^="file:"]')).toBeNull();
  });
  it("大文图片同时最多4个请求、保留8张，页面隐藏停止排队和观察", async () => {
    let intersect: IntersectionObserverCallback;
    const disconnect = vi.fn();
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { intersect = callback; }
      observe = vi.fn(); disconnect = disconnect;
    });
    const pending: Array<(data: string) => void> = [];
    vi.mocked(mobileKnowledgeImage).mockImplementation(() => new Promise(resolve => pending.push(resolve)));
    const created: HTMLImageElement[] = [];
    const original = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((name, options) => {
      const element = original(name, options); if (name === "img") created.push(element as HTMLImageElement); return element;
    });
    const content = Array.from({ length: 20 }, (_, index) => `![图${index}](images/${index}.png)`).join("\n\n");
    const view = render(<KnowledgeMarkdown content={content} active onLink={vi.fn()} />);
    const targets = Array.from(view.container.querySelectorAll(".kb-image"));
    act(() => intersect(targets.map(target => ({ target, isIntersecting: true } as IntersectionObserverEntry)), {} as IntersectionObserver));
    expect(mobileKnowledgeImage).toHaveBeenCalledTimes(4);
    for (let group = 0; group < 3; group++) {
      await act(async () => { pending.splice(0, 4).forEach(resolve => resolve("data:image/png;base64,aA==")); });
      await act(async () => created.splice(0, 4).forEach(image => image.dispatchEvent(new Event("load"))));
    }
    expect(view.container.querySelectorAll("img").length).toBe(8);
    expect(mobileKnowledgeImage).toHaveBeenCalledTimes(16);
    view.rerender(<KnowledgeMarkdown content={content} active={false} onLink={vi.fn()} />);
    expect(disconnect).toHaveBeenCalled();
    expect(view.container.querySelectorAll("img").length).toBe(0);
    await act(async () => { pending.splice(0).forEach(resolve => resolve("data:image/png;base64,aA==")); });
    expect(mobileKnowledgeImage).toHaveBeenCalledTimes(16);
  });
  it("已有图片重读失败时保留可查看的画面，并准确说明失败状态", async () => {
    vi.mocked(mobileKnowledgeImage).mockResolvedValueOnce("data:image/png;base64,aA==").mockRejectedValueOnce(new Error("missing"));
    let created: HTMLImageElement;
    const original = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((name, options) => {
      const element = original(name, options); if (name === "img") created = element as HTMLImageElement; return element;
    });
    const view = render(<KnowledgeMarkdown content="![已有图片](images/abcdef.png)" onLink={vi.fn()} onImage={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "加载本机图片" }));
    await waitFor(() => expect(created!).toBeTruthy());
    await act(async () => created!.dispatchEvent(new Event("load")));
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    await screen.findByText("重新读取未能完成，当前图片仍可查看。");
    expect(view.container.querySelectorAll("img")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /^查看图片/ })).toBeTruthy();
  });
  it("图片缓存同时受总24MP预算限制，不只是限制张数", async () => {
    vi.mocked(mobileKnowledgeImage).mockResolvedValue("data:image/png;base64,aA==");
    const created: HTMLImageElement[] = [];
    const original = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((name, options) => {
      const element = original(name, options);
      if (name === "img") {
        Object.defineProperties(element, { naturalWidth: { value: 3000 }, naturalHeight: { value: 2000 } });
        created.push(element as HTMLImageElement);
      }
      return element;
    });
    const content = Array.from({ length: 6 }, (_, index) => `![图${index}](images/${index}.png)`).join("\n\n");
    const view = render(<KnowledgeMarkdown content={content} onLink={vi.fn()} />);
    await act(async () => screen.getAllByRole("button", { name: "加载本机图片" }).forEach(button => fireEvent.click(button)));
    await act(async () => created.splice(0).forEach(image => image.dispatchEvent(new Event("load"))));
    await act(async () => created.splice(0).forEach(image => image.dispatchEvent(new Event("load"))));
    expect(view.container.querySelectorAll("img")).toHaveLength(4);
  });
});
