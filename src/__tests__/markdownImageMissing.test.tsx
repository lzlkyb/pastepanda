/**
 * MarkdownRenderer 「图没跟过来」占位（md-imgmiss）测试。
 *
 * 盯的是一个静默失败：从外部库导入的笔记正文里带 `![](attachments/x.png)`，
 * 而附件没搬过来 —— 旧行为是渲染一个加不出来的 <img>（alt 常为空），
 * 屏幕上什么都没有，用户连原文里有图都不知道。
 *
 * 因此这里有两半断言，缺一不可：
 * 1. 解不出来的本地路径 → 出现占位（把静默变成可见）；
 * 2. 本来就能显示的图（http / data / 绝对路径 / 给了 baseDir）→ **不出现**占位。
 *    MarkdownRenderer 被记录卡片、全屏编辑器、快捷面板等多处共用，
 *    第 2 半是防回归的主力。
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";

// vitest alias 已把 @tauri-apps/api/core 指向 mock（仅 invoke），
// MarkdownRenderer 还引用 convertFileSrc，需补齐。
// 返回形式按 Tauri 2 在 Windows 上的真实产物（http://asset.localhost/…）——
// 写成 asset:// 的话 DOMPurify 会把 src 剔掉，测的就不是真实行为了
vi.mock("@tauri-apps/api/core", async () => {
  const actual = await vi.importActual<object>("@tauri-apps/api/core");
  return { ...actual, convertFileSrc: (p: string) => `http://asset.localhost/${encodeURI(p)}` };
});

/** 渲染一段 markdown，返回容器（不传 baseDir = 剪贴板/笔记预览那种没有目录的场景） */
function renderMd(text: string, baseDir?: string | null) {
  return render(<MarkdownRenderer text={text} baseDir={baseDir} />).container;
}

const miss = (c: HTMLElement) => c.querySelectorAll(".md-imgmiss");

describe("MarkdownRenderer 图没跟过来的占位", () => {
  it("没有 baseDir 时相对路径解不出来 → 出现占位，并写明原路径", () => {
    const c = renderMd("![](attachments/x.png)");
    expect(miss(c).length).toBe(1);
    // 路径要能看到，否则用户没法自己去找
    expect(c.querySelector(".md-imgmiss-p")?.textContent).toContain("attachments/x.png");
    // 不是错误提示，文案里不该出现这类词
    const t = c.querySelector(".md-imgmiss-t")?.textContent ?? "";
    expect(t).not.toMatch(/错误|失败/);
    expect(t.length).toBeGreaterThan(0);
    // 占位取代了那个加不出来的 <img>
    expect(c.querySelectorAll("img").length).toBe(0);
  });

  it("`./` 与 `../` 开头的相对路径同样出占位", () => {
    expect(miss(renderMd("![](./assets/a.png)")).length).toBe(1);
    expect(miss(renderMd("![](../img/b.jpg)")).length).toBe(1);
  });

  it("有 alt 文本时占位里显示它（常常是唯一能说明这张图是什么的信息）", () => {
    const c = renderMd("![架构图 v2](attachments/arch.png)");
    expect(c.querySelector(".md-imgmiss-alt")?.textContent).toBe("架构图 v2");
  });

  it("没有 alt 文本时不渲染空的 alt 行", () => {
    const c = renderMd("![](attachments/x.png)");
    expect(c.querySelector(".md-imgmiss-alt")).toBeNull();
  });

  it("http(s) 图片不出占位，仍是正常 <img>（防回归）", () => {
    const c = renderMd("![远程图](http://example.com/x.png)");
    expect(miss(c).length).toBe(0);
    const img = c.querySelector("img");
    expect(img?.getAttribute("src")).toBe("http://example.com/x.png");
    expect(img?.getAttribute("alt")).toBe("远程图");
  });

  it("https / data / asset 图片一律不出占位（防回归）", () => {
    expect(miss(renderMd("![](https://example.com/x.png)")).length).toBe(0);
    expect(miss(renderMd("![](data:image/png;base64,iVBORw0KGgo=)")).length).toBe(0);
    expect(miss(renderMd("![](asset://localhost/D%3A%2Fa.png)")).length).toBe(0);
  });

  it("给了 baseDir 时相对路径能解出来 → 不出占位，src 走 asset 协议（防回归）", () => {
    const c = renderMd("![](assets/x.png)", "D:\\notes\\vault");
    expect(miss(c).length).toBe(0);
    expect(c.querySelector("img")?.getAttribute("src")).toContain("asset.localhost");
  });

  it("绝对本地路径不依赖 baseDir → 不出占位（防回归）", () => {
    const c = renderMd("![](D:/notes/x.png)");
    expect(miss(c).length).toBe(0);
    expect(c.querySelector("img")?.getAttribute("src")).toContain("asset.localhost");
  });

  it("占位长在段落中间时不破坏段落结构（只用 span，不塞 div）", () => {
    const c = renderMd("前面 ![](a.png) 后面");
    const ps = c.querySelectorAll("p");
    expect(ps.length).toBe(1);
    expect(ps[0].querySelector(".md-imgmiss")).not.toBeNull();
    expect(ps[0].querySelector("div")).toBeNull();
    expect(ps[0].textContent).toContain("前面");
    expect(ps[0].textContent).toContain("后面");
  });

  it("activeBaseDir 不会串到下一次渲染（渲染完必须清掉）", () => {
    // 先渲染一个带 baseDir 的（能解），紧接着渲染一个不带的（解不出来）
    expect(miss(renderMd("![](assets/x.png)", "D:\\notes\\vault")).length).toBe(0);
    expect(miss(renderMd("![](assets/x.png)")).length).toBe(1);
  });

  it("没有图片的普通 markdown 完全不受影响", () => {
    const c = renderMd("# 标题\n\n正文一段\n\n- 甲\n- 乙");
    expect(miss(c).length).toBe(0);
    expect(c.querySelector("h1")?.textContent).toContain("标题");
  });
});
