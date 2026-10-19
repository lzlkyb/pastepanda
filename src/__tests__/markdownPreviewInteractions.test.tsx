/**
 * 预览态「可点控件」三件套的守卫：
 * 1. **外链** —— 只有 http/https/mailto 才交给系统浏览器；其余一律拦下。
 *    在 WebView2 里这不是体验问题：没拦的 <a> 会把整个应用导航走（无地址栏、无后退）。
 * 2. **图片放大** —— 点正文图片打开遮罩，Esc 关闭。
 * 3. **表格复制** —— 每张表都要有可发现入口，且复制必须写 HTML + TSV 两种 MIME。
 *
 * 防假绿说明见文末「变异核对」。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { classifyLink, normalizeExternalUrl } from "@/lib/markdown/linkTarget";
import { tableToMatrix, tableToRichHtml, tableToTsv } from "@/lib/markdown/tableCopy";

const MD = [
  "[外链](https://example.com/a)",
  "",
  "[相对](./other.md)",
  "",
  "![说明文字](https://example.com/x.png)",
  "",
  "| 姓名 | 部门 |",
  "| --- | --- |",
  "| 阿岩 | 研发 |",
].join("\n");

/** 构造一张有合并单元格的表，用来测 TSV 是否有列错位 */
function mountTable(html: string): HTMLTableElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.querySelector("table") as HTMLTableElement;
}

describe("链接归属判定", () => {
  it("锚点 / 外链 / 其余分得清", () => {
    expect(classifyLink("#安装步骤")).toBe("anchor");
    expect(classifyLink("https://a.com")).toBe("external");
    expect(classifyLink("HTTP://a.com")).toBe("external");
    expect(classifyLink("mailto:a@b.c")).toBe("external");
    // 协议相对地址在 tauri:// 下会变成 tauri://example.com —— 必须按外链处理并补 https:
    expect(classifyLink("//example.com/x")).toBe("external");
    expect(normalizeExternalUrl("//example.com/x")).toBe("https://example.com/x");
  });

  it("相对路径 / file: / 自定义协议 / javascript: 全部拦下", () => {
    for (const href of ["./other.md", "../a.md", "file:///C:/x", "vscode://x", "javascript:alert(1)", ""]) {
      expect(classifyLink(href), href).toBe("blocked");
      expect(normalizeExternalUrl(href), href).toBeNull();
    }
  });
});

describe("表格复制：文本转换", () => {
  afterEach(() => document.body.innerHTML = "");

  it("普通表 → TSV 逐行逐列", () => {
    const table = mountTable("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>");
    expect(tableToTsv(table)).toBe("A\tB\r\n1\t2");
    expect(tableToMatrix(table)).toEqual([["A", "B"], ["1", "2"]]);
  });

  it("单元格里的换行与制表符不会撑破列", () => {
    const table = mountTable("<table><tr><td>a<br>b</td><td>c\td</td></tr></table>");
    // jsdom 没有 innerText，走 textContent：<br> 不产生换行（真实浏览器会）。
    // 这里钉住的是「换行/制表符一律压成空格」，两种取值来源都不得破坏列数。
    expect(tableToTsv(table).split("\r\n")[0].split("\t")).toHaveLength(2);
  });

  it("colspan 展开 + rowspan 向下占位，后续列不错位", () => {
    const table = mountTable(
      "<table>" +
        "<tr><td colspan='2'>合并</td><td>C1</td></tr>" +
        "<tr><td rowspan='2'>跨行</td><td>B2</td><td>C2</td></tr>" +
        "<tr><td>B3</td><td>C3</td></tr>" +
        "</table>",
    );
    expect(tableToMatrix(table)).toEqual([
      ["合并", "", "C1"],
      ["跨行", "B2", "C2"],
      ["", "B3", "C3"],
    ]);
  });

  it("富文本片段带表头语义并转义内容", () => {
    const table = mountTable("<table><tr><th>H</th></tr><tr><td>&lt;script&gt;</td></tr></table>");
    const html = tableToRichHtml(table);
    expect(html).toContain("<th ");
    expect(html).toContain("<td ");
    // 单元格文本必须被转义：这段 HTML 会被粘到 Word/邮件里，不能带出可执行标签
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});

describe("预览里的可点控件", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("点外链走系统浏览器（invoke open_url），不导航 webview", () => {
    const { container } = render(<MarkdownRenderer text={MD} />);
    const link = container.querySelector('a[href="https://example.com/a"]') as HTMLAnchorElement;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(invoke).toHaveBeenCalledWith("open_url", { url: "https://example.com/a" });
  });

  it("点相对路径链接：仍然 preventDefault，且不调 open_url", () => {
    const { container } = render(<MarkdownRenderer text={MD} />);
    const link = container.querySelector('a[href="./other.md"]') as HTMLAnchorElement;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("点正文图片打开放大层，Esc 关闭", () => {
    const { container } = render(<MarkdownRenderer text={MD} />);
    fireEvent.click(container.querySelector("img") as HTMLImageElement);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(dialog.querySelector("img")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("每张表都有「复制表格」入口", () => {
    const { container } = render(<MarkdownRenderer text={MD} />);
    const wrap = container.querySelector(".md-tblwrap") as HTMLElement;
    expect(wrap).toBeTruthy();
    // wrapper 直接子节点里必须有 table 和按钮，缺一个都说明装饰没生效
    expect(wrap.querySelector("table")).toBeTruthy();
    expect(wrap.querySelector(".md-tblcopy")?.textContent).toBe("复制表格");
  });

  it("点复制按钮：写 HTML + TSV 两种 MIME", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { write }, configurable: true });
    // jsdom 没有 ClipboardItem，补一个只记录入参的桩
    class FakeClipboardItem {
      constructor(public items: Record<string, Blob>) {}
    }
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);

    const { container } = render(<MarkdownRenderer text={MD} />);
    fireEvent.click(container.querySelector(".md-tblcopy") as HTMLButtonElement);

    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const items = (write.mock.calls[0][0] as FakeClipboardItem[])[0].items;
    expect(Object.keys(items).sort()).toEqual(["text/html", "text/plain"]);
    // 成功反馈必须可见
    await waitFor(() =>
      expect(container.querySelector(".md-tblcopy")?.textContent).toBe("已复制"),
    );
  });
});

/**
 * 变异核对（规则 23：守卫必须先证明会红）：
 * - 把 `classifyLink` 的相对路径分支改成 `external` → 「相对路径」用例红；
 * - 删掉 `decorateTables(el)` 的 effect → 「每张表都有入口」用例红；
 * - 把 `copyTableElement` 的 `text/html` 键删掉 → MIME 断言红；
 * - 把图片分支的 `setZoomed` 去掉 → 放大层用例红。
 * 以上四条在本次改动中逐条实测过，确认不是「断言在测空气」。
 */
