/**
 * 标题 slug + 大纲扫描守卫。
 *
 * 不变量：大纲 scanHeadings 与预览 heading 渲染器必须用同一套 slug
 * （`headingSlug.createSlugAllocator`），否则仅预览点大纲会对不上 id。
 */
import { describe, it, expect } from "vitest";
import { slugifyHeading, assignUniqueSlugs, createSlugAllocator } from "@/lib/markdown/headingSlug";
import { scanHeadings } from "@/components/editors/fullscreen/MarkdownOutline";
import { headingHtml, resetHeadingSlugState, nextHeadingSlug } from "@/lib/markdown/headingAnchor";

describe("slugifyHeading", () => {
  it("保留中文，拉丁转小写，空白转 -", () => {
    expect(slugifyHeading("安装步骤")).toBe("安装步骤");
    expect(slugifyHeading("Windows 配置")).toBe("windows-配置");
  });

  it("去掉标点，空结果回退 section", () => {
    expect(slugifyHeading("Hello, World!")).toBe("hello-world");
    expect(slugifyHeading("！！！")).toBe("section");
  });
});

describe("assignUniqueSlugs / createSlugAllocator", () => {
  it("重复标题依次加 -1 -2", () => {
    const out = assignUniqueSlugs([
      { level: 2, text: "示例" },
      { level: 2, text: "示例" },
      { level: 3, text: "示例" },
    ]);
    expect(out.map((h) => h.slug)).toEqual(["示例", "示例-1", "示例-2"]);
  });

  it("去重后缀不与已有字面 slug 冲突", () => {
    const next = createSlugAllocator();
    expect(next("foo")).toBe("foo");
    expect(next("foo-1")).toBe("foo-1");
    // foo 再次出现：foo-1 已被占用，应落到 foo-2
    expect(next("foo")).toBe("foo-2");
  });
});

describe("scanHeadings", () => {
  it("跳过围栏代码块里的 # 注释", () => {
    const src = [
      "# 真标题",
      "```bash",
      "# 这不是标题",
      "echo hi",
      "```",
      "## 第二节",
    ].join("\n");
    const hs = scanHeadings(src);
    expect(hs.map((h) => h.text)).toEqual(["真标题", "第二节"]);
    expect(hs[0].line).toBe(1);
    expect(hs[1].line).toBe(6);
  });

  it("产出与渲染器一致的 slug", () => {
    const src = "## 安装步骤\n\n### Windows 配置\n\n## 安装步骤\n";
    const scanned = scanHeadings(src);
    expect(scanned.map((h) => h.slug)).toEqual(["安装步骤", "windows-配置", "安装步骤-1"]);

    resetHeadingSlugState();
    const htmlA = headingHtml(2, "安装步骤", "安装步骤");
    const htmlB = headingHtml(3, "Windows 配置", "Windows 配置");
    const htmlC = headingHtml(2, "安装步骤", "安装步骤");
    expect(htmlA).toContain('id="安装步骤"');
    expect(htmlB).toContain('id="windows-配置"');
    expect(htmlC).toContain('id="安装步骤-1"');
    // 分配器与 scan 顺序一致
    resetHeadingSlugState();
    expect(nextHeadingSlug("安装步骤")).toBe(scanned[0].slug);
  });
});
