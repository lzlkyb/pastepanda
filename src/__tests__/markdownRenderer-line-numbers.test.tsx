/**
 * MarkdownRenderer 行号模式测试（方案 C）：
 * 块级行号注入 / 代码块按行包裹 / 复制排除行号 / 点击闪烁 / 开关关闭还原 / compact 强制关闭。
 * hljs 为真实动态加载（jsdom 下可用），断言前 waitFor 等待异步包裹完成。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";

// vitest alias 已把 @tauri-apps/api/core 指向 mock（仅 invoke），
// MarkdownRenderer 还引用 convertFileSrc，需补齐（本测试不触发本地图片路径）
vi.mock("@tauri-apps/api/core", async () => {
  const actual = await vi.importActual<object>("@tauri-apps/api/core");
  return { ...actual, convertFileSrc: (p: string) => `asset://localhost/${p}` };
});

// 真包 mermaid 在 jsdom 里动态 import 极慢（实测 19s+ 超时）；本用例只关心
// 行号包裹不碰 .md-mermaid-raw，把 render 钉成失败（raw 保持原样）即可
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockRejectedValue(new Error("no render in test")),
  },
}));

const writeText = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(navigator, "clipboard", {
  value: { writeText },
  configurable: true,
});

const SAMPLE = [
  "# 标题",
  "",
  "正文段落",
  "",
  "## 二级标题",
  "",
  "- 甲",
  "- 乙",
  "",
  "```ts",
  "const a = 1;",
  "const b = 2;",
  "```",
  "",
  "---",
  "",
  "> 引用",
].join("\n");

/** 块级行号模式下代码块会被 hljs 异步包裹，等待完成 */
async function waitForCodeWrap(container: HTMLElement) {
  await waitFor(() => {
    expect(container.querySelectorAll(".md-cl").length).toBeGreaterThan(0);
  });
}

describe("MarkdownRenderer 行号模式", () => {
  beforeEach(() => {
    writeText.mockClear();
  });

  it("顶层块注入递增编号，hr 跳过，容器挂 md-ln", async () => {
    const { container } = render(<MarkdownRenderer text={SAMPLE} lineNumbers />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.classList.contains("md-ln")).toBe(true);

    const nums = Array.from(container.querySelectorAll(".md-blknum")).map((n) => n.textContent);
    // h1 / p / h2 / ul / codeblock / blockquote 共 6 块，hr 不编号
    expect(nums).toEqual(["1", "2", "3", "4", "5", "6"]);
    // 编号位于块内首位
    const first = container.querySelector(".md-blknum");
    expect(first?.parentElement?.firstChild).toBe(first);
  });

  it("代码块按行包裹行号，复制不含行号列", async () => {
    const { container } = render(<MarkdownRenderer text={SAMPLE} lineNumbers />);
    await waitForCodeWrap(container);

    const rows = container.querySelectorAll(".md-cl");
    expect(rows.length).toBe(2);
    expect(Array.from(container.querySelectorAll(".md-cln")).map((n) => n.textContent)).toEqual(["1", "2"]);
    expect(Array.from(container.querySelectorAll(".md-clc")).map((c) => c.textContent)).toEqual([
      "const a = 1;",
      "const b = 2;",
    ]);

    const copyBtn = container.querySelector(".md-copybtn") as HTMLElement;
    fireEvent.click(copyBtn);
    expect(writeText).toHaveBeenCalledWith("const a = 1;\nconst b = 2;");
  });

  it("点击块编号：整块闪烁高亮并在 900ms 后移除", async () => {
    const { container } = render(<MarkdownRenderer text={SAMPLE} lineNumbers />);
    const blknum = container.querySelector(".md-blknum") as HTMLElement;
    const block = blknum.parentElement as HTMLElement;

    fireEvent.click(blknum);
    expect(block.classList.contains("md-flash")).toBe(true);

    await new Promise((r) => setTimeout(r, 1000));
    expect(block.classList.contains("md-flash")).toBe(false);
  });

  it("关闭行号（html 未变）：编号移除、代码还原为纯文本", async () => {
    const { container, rerender } = render(<MarkdownRenderer text={SAMPLE} lineNumbers />);
    await waitForCodeWrap(container);
    expect(container.querySelectorAll(".md-blknum").length).toBe(6);

    rerender(<MarkdownRenderer text={SAMPLE} lineNumbers={false} />);

    // 解包与重高亮在 effect 中异步执行，等待代码行结构清除
    await waitFor(() => {
      expect(container.querySelectorAll(".md-cl").length).toBe(0);
    });
    expect((container.firstElementChild as HTMLElement).classList.contains("md-ln")).toBe(false);
    expect(container.querySelectorAll(".md-blknum").length).toBe(0);
    const code = container.querySelector("pre code") as HTMLElement;
    expect(code.textContent).toBe("const a = 1;\nconst b = 2;");
  });

  it("compact 模式强制关闭行号", () => {
    const { container } = render(<MarkdownRenderer text={SAMPLE} compact lineNumbers />);
    expect((container.firstElementChild as HTMLElement).classList.contains("md-ln")).toBe(false);
    expect(container.querySelectorAll(".md-blknum").length).toBe(0);
  });

  it("默认（不传 lineNumbers）无行号结构", () => {
    const { container } = render(<MarkdownRenderer text={SAMPLE} />);
    expect((container.firstElementChild as HTMLElement).classList.contains("md-ln")).toBe(false);
    expect(container.querySelectorAll(".md-blknum").length).toBe(0);
  });

  // 🔴 行号包裹必须与高亮同口径排除 mermaid 源码块：.md-mermaid-raw code 被拆行后
  // textContent 混入行号数字，mermaid 渲染读到污染源码直接挂，「编辑」按钮也会把
  // 带行号的垃圾派发给 mermaid 编辑器。
  it("行号模式下 mermaid 源码块不打行号（textContent 保持原始源码）", async () => {
    const md = [SAMPLE, "", "```mermaid", "graph TD", "A-->B", "```"].join("\n");
    const { container } = render(<MarkdownRenderer text={md} lineNumbers />);
    await waitForCodeWrap(container);
    const raw = container.querySelector(".md-mermaid-raw code") as HTMLElement;
    expect(raw.textContent).toBe("graph TD\nA-->B");
  });
});
