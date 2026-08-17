/**
 * OCR 行坐标 → 表格（几何聚类）。
 *
 * 重点不是“能不能识别表格”，而是把它的**边界与已知局限**钉住：
 * 列切分靠的是「间隙中位数 × 3」，而每行只取 words[0] 定列、文本用整行——
 * 这意味着只有 OCR 把每个单元格识别成独立 line 时才能正确分列。
 */

import { describe, it, expect } from "vitest";
import { csvEscape, ocrToTable } from "@/lib/screenshot/ocrTable";
import type { OcrLine } from "@/lib/api/images";

/** 造一个单词就是整个单元格的 OCR 行 */
function cell(text: string, x: number, y: number, w = 40, h = 16): OcrLine {
  return { text, words: [{ text, x, y, width: w, height: h }] } as OcrLine;
}

describe("ocrToTable", () => {
  it("两行两列：按 y 聚行、按 x 间隙切列", () => {
    // 同列 x 刻意留小拖动（2px）——真实 OCR 输出就是这样，而列切分靠的是
    // 「间隙中位数 × 3」，需要这些小间隙把中位数拉低。完全对齐的退化情况见最后一个用例。
    const table = ocrToTable([
      cell("姓名", 10, 10),
      cell("年龄", 300, 10),
      cell("张三", 12, 60),
      cell("28", 303, 60),
    ]);
    expect(table).toEqual([
      ["姓名", "年龄"],
      ["张三", "28"],
    ]);
  });

  it("同一行的轻微 y 偏差仍归为一行（容差取行高）", () => {
    const table = ocrToTable([
      cell("A", 10, 10),
      cell("B", 300, 14), // y 差 4 < 容差
      cell("C", 12, 90),
      cell("D", 303, 90),
    ]);
    expect(table).toHaveLength(2);
    expect(table?.[0]).toEqual(["A", "B"]);
  });

  it("行会按 y 从小到大排序，与输入顺序无关", () => {
    const table = ocrToTable([
      cell("下左", 12, 200),
      cell("下右", 303, 200),
      cell("上左", 10, 10),
      cell("上右", 300, 10),
    ]);
    expect(table?.[0]).toEqual(["上左", "上右"]);
    expect(table?.[1]).toEqual(["下左", "下右"]);
  });

  it("单列不算表格 → null", () => {
    expect(ocrToTable([cell("第一行", 10, 10), cell("第二行", 10, 60)])).toBeNull();
  });

  it("不足两行 → null", () => {
    expect(ocrToTable([])).toBeNull();
    expect(ocrToTable([cell("孤行", 10, 10)])).toBeNull();
    // 两个 cell 在同一行 → 聚完只剩一行
    expect(ocrToTable([cell("A", 10, 10), cell("B", 300, 10)])).toBeNull();
  });

  it("没有 words 的行被跳过，不崩", () => {
    const empty = { text: "空行", words: [] } as OcrLine;
    const table = ocrToTable([
      empty,
      cell("A", 10, 10),
      cell("B", 300, 10),
      cell("C", 12, 90),
      cell("D", 303, 90),
    ]);
    expect(table).toHaveLength(2);
  });

  it("已知脆弱点：每列 x 完全对齐时，两列表格反而切不出来", () => {
    // 机制：gaps 只收集到唯一的列间隙 → 中位数就是它自己 →
    // 阈值 = 3 × 它 > 它本身 → 永远切不出列 → 返回 null。
    // 真实 OCR 的 x 总有拖动所以很少触发，但等宽字体/极规整的表格有可能。
    // 写成测试是为了让它是「已知」而不是以后被当成新 bug 重新发现；
    // 若以后要修，方向是「列数 <= 2 时改用绝对阈值」而不是中位数倍数。
    expect(
      ocrToTable([
        cell("姓名", 10, 10),
        cell("年龄", 300, 10),
        cell("张三", 10, 60),
        cell("28", 300, 60),
      ]),
    ).toBeNull();
  });
});

describe("csvEscape", () => {
  it("普通文本不加引号", () => {
    expect(csvEscape("张三")).toBe("张三");
    expect(csvEscape("")).toBe("");
  });

  it("含逗号 / 换行 → 加引号", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape("a\nb")).toBe('"a\nb"');
  });

  it("含引号 → 加引号且内部引号双写", () => {
    expect(csvEscape('他说"你好"')).toBe('"他说""你好"""');
  });
});
