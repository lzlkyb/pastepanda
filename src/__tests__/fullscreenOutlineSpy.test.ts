/**
 * 大纲默认展示 + 滚动跟随（scrollspy）的纯逻辑守卫。
 *
 * jsdom 环境约定（同 fullscreenShell）：
 * - CSS Modules 类名是 `_xxx_00f1f4` 哈希形态，选择器用 `[class*="xxx"]` 子串匹配；
 * - 数类必须 hasCls 精确匹配（子串会多算：fmtBtnText 含 fmtBtn 的教训）。
 */
import { describe, it, expect } from "vitest";
import {
  scanHeadings,
  readOutlinePref,
  writeOutlinePref,
  type OutlineHeading,
} from "@/components/editors/fullscreen/MarkdownOutline";
import { headingAtOrAbove } from "@/components/editors/useOutlineSpy";

describe("大纲开关偏好（记住上次状态，首次默认开）", () => {
  it("无记录默认展示；写读往返；脏值按 false 容错", () => {
    localStorage.removeItem("md_outline_open");
    expect(readOutlinePref()).toBe(true); // 首次使用：默认开

    writeOutlinePref(false);
    expect(readOutlinePref()).toBe(false); // 用户关过 → 记住关

    writeOutlinePref(true);
    expect(readOutlinePref()).toBe(true); // 用户开过 → 记住开

    localStorage.setItem("md_outline_open", "yes");
    expect(readOutlinePref()).toBe(false); // 非法值不当初开（false 容错）

    localStorage.removeItem("md_outline_open");
  });
});

describe("headingAtOrAbove（scrollspy 的行号→当前节）", () => {
  const hs: OutlineHeading[] = [
    { level: 1, text: "A", line: 1, slug: "a" },
    { level: 2, text: "A1", line: 5, slug: "a1" },
    { level: 1, text: "B", line: 20, slug: "b" },
  ];

  it("首个标题之前（如文档前言）→ null，不高亮任何项", () => {
    expect(headingAtOrAbove([], 3)).toBeNull();
    expect(headingAtOrAbove(hs, 0)).toBeNull();
  });

  it("标题行本身命中自己；正文行命中其上最近标题", () => {
    expect(headingAtOrAbove(hs, 1)?.slug).toBe("a");
    expect(headingAtOrAbove(hs, 4)?.slug).toBe("a");
    expect(headingAtOrAbove(hs, 5)?.slug).toBe("a1");
    expect(headingAtOrAbove(hs, 19)?.slug).toBe("a1");
    expect(headingAtOrAbove(hs, 99)?.slug).toBe("b");
  });

  it("headings 必须按行号升序（scanHeadings 的输出顺序即此）", () => {
    // 防御未来有人改扫描顺序导致二分/线性中断语义失效
    const scanned = scanHeadings("# x\n\n## y\n\n# z");
    const lines = scanned.map((h) => h.line);
    expect([...lines].sort((a, b) => a - b)).toEqual(lines);
  });
});
