/**
 * 图文混排内容的存储格式 ⇄ 显示格式互转测试。
 *
 * 重点盯住一件事：存储格式是采集（Rust 侧）、粘贴回写（Rust 侧）、
 * 删除时图片清理（Rust 侧）三方共用的契约，前端编辑一轮后必须原样还原——
 * 这里一旦退化，表现是“编辑保存后图片丢了 / 粘贴出来没图”，很难归因。
 */
import { describe, it, expect, vi } from "vitest";

// convertFileSrc 不在默认 mock 里，手动补上（与 api-images.test.ts 同口径）
vi.mock("@tauri-apps/api/core", async () => {
  const actual = await vi.importActual<object>("@tauri-apps/api/core");
  return {
    ...actual,
    convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
  };
});

const {
  toDisplayHtml,
  toStoredHtml,
  firstLocalImagePath,
  thumbnailSourcePath,
  countImages,
  richToPlainText,
  pathToFileUrl,
} = await import("@/lib/richContent");

describe("toDisplayHtml / toStoredHtml 往返", () => {
  it("本地 file:// 图片：转显示格式再转回存储格式，路径原样不变", () => {
    const stored = '<p>前文</p><img src="file:///C:/img/a1b2.png"><p>后文</p>';
    const display = toDisplayHtml(stored);
    // 显示格式应该换成 asset 地址，并把原路径存在 data-src
    expect(display).toContain("asset://localhost/");
    expect(display).toContain('data-src="file:///C:/img/a1b2.png"');
    // 转回去必须与原始存储路径逐字一致（这是图片能不能被找到的关键）
    const back = toStoredHtml(display);
    expect(back).toContain('src="file:///C:/img/a1b2.png"');
    expect(back).not.toContain("data-src");
    expect(back).not.toContain("asset://");
  });

  it("中文路径也能无损往返（百分号编码不能把路径弄丢）", () => {
    const stored = '<img src="file:///C:/图片/截图%201.png">';
    const back = toStoredHtml(toDisplayHtml(stored));
    expect(back).toContain('src="file:///C:/图片/截图%201.png"');
  });

  it("多图交错：图片与文字的顺序与数量全部保留", () => {
    const stored =
      '<p>a</p><img src="file:///C:/1.png"><img src="file:///C:/2.png"><p>b</p><img src="file:///C:/3.png">';
    const back = toStoredHtml(toDisplayHtml(stored));
    expect(countImages(back)).toBe(3);
    expect(back.indexOf("1.png")).toBeLessThan(back.indexOf("2.png"));
    expect(back.indexOf("2.png")).toBeLessThan(back.indexOf("3.png"));
    expect(back).toContain("a");
    expect(back).toContain("b");
  });

  it("远程 http 图片原样保留，不转 asset 也不丢", () => {
    const stored = '<img src="https://example.com/pic.png">';
    expect(toDisplayHtml(stored)).toContain("https://example.com/pic.png");
    expect(toStoredHtml(toDisplayHtml(stored))).toContain("https://example.com/pic.png");
  });

  it("消毒：剥掉 script 与事件属性（内容来自外部应用剪贴板，不可信）", () => {
    const evil = '<p>ok</p><script>alert(1)</script><img src="file:///C:/a.png" onerror="alert(2)">';
    const display = toDisplayHtml(evil);
    expect(display).not.toContain("script");
    expect(display).not.toContain("onerror");
    expect(display).toContain("ok");
    // 写回数据库的方向也得消毒，不能只依赖展示侧把关
    expect(toStoredHtml(evil)).not.toContain("onerror");
  });

  it("空内容不报错", () => {
    expect(toDisplayHtml("")).toBe("");
    expect(toStoredHtml("")).toBe("");
  });
});

describe("firstLocalImagePath / thumbnailSourcePath", () => {
  it("取第一张本地图的文件系统路径", () => {
    const stored = '<p>x</p><img src="file:///C:/img/first.png"><img src="file:///C:/img/second.png">';
    expect(firstLocalImagePath(stored)).toBe("C:/img/first.png");
  });

  it("只有远程图时返回 null（调用方应回退到图标）", () => {
    expect(firstLocalImagePath('<img src="https://e.com/a.png">')).toBeNull();
  });

  it("image 类型直接用 content，rich 类型取片段第一张图", () => {
    expect(thumbnailSourcePath({ type: "image", content: "C:/a.png" })).toBe("C:/a.png");
    expect(
      thumbnailSourcePath({ type: "rich", content: '<img src="file:///C:/b.png">' })
    ).toBe("C:/b.png");
  });

  it("文本/文件类型无缩略图", () => {
    expect(thumbnailSourcePath({ type: "text", content: "" })).toBeNull();
    expect(thumbnailSourcePath({ type: "file", content: "C:/a.txt" })).toBeNull();
  });

  it("rich 但图全被删了（编辑后）→ null，不能让卡片永久转圈", () => {
    expect(thumbnailSourcePath({ type: "rich", content: "<p>只剩文字了</p>" })).toBeNull();
  });
});

describe("richToPlainText", () => {
  it("块级标签转换行，图片不输出占位文字", () => {
    const html = '<p>第一行</p><img src="file:///C:/a.png"><p>第二行</p>';
    expect(richToPlainText(html)).toBe("第一行\n第二行");
  });

  it("列表逐项成行", () => {
    expect(richToPlainText("<ul><li>a</li><li>b</li></ul>")).toBe("a\nb");
  });

  it("解基础 HTML 实体", () => {
    expect(richToPlainText("<p>a&amp;b&nbsp;c</p>")).toBe("a&b c");
  });

  it("纯图片内容 → 空字符串（不会产生垃圾标题）", () => {
    expect(richToPlainText('<img src="file:///C:/a.png">')).toBe("");
  });
});

describe("pathToFileUrl", () => {
  it("反斜杠统一成正斜杠（与采集侧写入格式一致）", () => {
    expect(pathToFileUrl("C:\\img\\a.png")).toBe("file:///C:/img/a.png");
  });
});
