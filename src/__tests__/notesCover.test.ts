/**
 * `lib/notes/cover.ts` 的单测。
 *
 * 这里是批 0 的正确性所在：正则错一点，要么缩略图集体不出（不痛但无效），
 * 要么把 title / base64 当成路径拿去加载（每行一张碎图）。
 */
import { describe, it, expect, vi } from "vitest";
import { coverSrcOf, coverUrlOf } from "@/lib/notes/cover";

// `cover.ts` 间接依赖 `convertFileSrc`（经 `lib/markdown/imageSrc`）。
// vitest.config 的 alias 把整个模块换成了 mock，但里面没有 convertFileSrc，
// 跟现有测试（markdownImageMissing.test.tsx）同一个写法补上。
vi.mock("@tauri-apps/api/core", async () => {
  const actual = await vi.importActual<object>("@tauri-apps/api/core");
  return { ...actual, convertFileSrc: (p: string) => `asset://localhost/${p}` };
});

describe("coverSrcOf", () => {
  it("取出最普通的一张图", () => {
    expect(coverSrcOf("![](C:/pp/images/abc.png)")).toBe("C:/pp/images/abc.png");
  });

  it("alt 里有中文也不影响", () => {
    expect(coverSrcOf("前言\n\n![配色截图](C:/pp/images/a.png)\n\n后文")).toBe(
      "C:/pp/images/a.png",
    );
  });

  it("🔴 不能把 title 当成路径的一部分", () => {
    expect(coverSrcOf('![a](C:/pp/images/a.png "这是标题")')).toBe("C:/pp/images/a.png");
  });

  it("尖括号形式允许路径带空格", () => {
    expect(coverSrcOf("![a](<C:/my dir/images/a.png>)")).toBe("C:/my dir/images/a.png");
  });

  it("多张图时取第一张", () => {
    const md = "![one](C:/a/1.png)\n\n中间一段\n\n![two](C:/a/2.png)";
    expect(coverSrcOf(md)).toBe("C:/a/1.png");
  });

  it("没图 / 空串 → null", () => {
    expect(coverSrcOf("纯文字，一张图也没有")).toBeNull();
    expect(coverSrcOf("")).toBeNull();
  });

  it("普通链接（不带前面那个叹号）不算图", () => {
    expect(coverSrcOf("[这是链接](C:/pp/images/a.png)")).toBeNull();
  });

  it("🔴 几百 KB 的 base64 不能被截前 512 字符匹配成功", () => {
    const huge = "![](data:image/png;base64," + "A".repeat(200_000) + ")";
    // 不是「返回了一段垃圾」而是干脆不匹配
    expect(coverSrcOf(huge)).toBeNull();
  });

  it("短的 data URI 能匹配到（过滤交给 coverUrlOf）", () => {
    const small = "![](data:image/png;base64,iVBORw0KGgo=)";
    expect(coverSrcOf(small)).toBe("data:image/png;base64,iVBORw0KGgo=");
  });
});

describe("coverUrlOf", () => {
  it("绝对路径 → 给出 asset 地址", () => {
    expect(coverUrlOf("![](C:/pp/images/a.png)")).toBe("asset://localhost/C:/pp/images/a.png");
  });

  it("🔴 data URI → null（否则会把 base64 塞进 img src）", () => {
    expect(coverUrlOf("![](data:image/png;base64,iVBORw0KGgo=)")).toBeNull();
  });

  it("🔴 http(s) 远程图 → null（列表不发外网请求）", () => {
    expect(coverUrlOf("![](https://example.com/a.png)")).toBeNull();
    expect(coverUrlOf("![](http://example.com/a.png)")).toBeNull();
  });

  it("相对路径 → null（笔记没有文档目录，解不出来，降级成图标）", () => {
    expect(coverUrlOf("![](attachments/a.png)")).toBeNull();
    expect(coverUrlOf("![](./images/a.png)")).toBeNull();
  });

  it("没图 → null", () => {
    expect(coverUrlOf("纯文字")).toBeNull();
  });

  it("反斜杠的 Windows 绝对路径也认", () => {
    // W1 的附件机制存的就可能是这种
    expect(coverUrlOf("![](<C:\\pp\\images\\a.png>)")).toBe(
      "asset://localhost/C:\\pp\\images\\a.png",
    );
  });
});
