/**
 * 表格拆分入栈（方案 A+B）：拆分纯函数测试。
 */
import { describe, it, expect } from "vitest";
import { splitTableToRows, MAX_TABLE_SPLIT_ROWS } from "@/lib/tableSplit";

describe("splitTableToRows", () => {
  it("Tab 分隔表格：按行拆分，默认排除表头、原始行格式", () => {
    const text = "姓名\t邮箱\n张三\tzhang@qq.com\n李四\tli@qq.com";
    const result = splitTableToRows(text);
    expect(result).not.toBeNull();
    expect(result!.rows).toEqual(["张三\tzhang@qq.com", "李四\tli@qq.com"]);
    expect(result!.totalRows).toBe(2);
  });

  it("MySQL 边框表格：同样能识别并拆分", () => {
    const text = [
      "+------+-----+",
      "| name | age |",
      "+------+-----+",
      "| 张三 | 20  |",
      "| 李四 | 21  |",
      "+------+-----+",
    ].join("\n");
    const result = splitTableToRows(text);
    expect(result!.rows).toEqual(["张三\t20", "李四\t21"]);
  });

  it("单行数据（表头+1行）也能拆出 1 条", () => {
    const text = "姓名\t邮箱\n张三\tzhang@qq.com";
    const result = splitTableToRows(text);
    expect(result!.rows).toEqual(["张三\tzhang@qq.com"]);
  });

  it("非表格文本 → 返回 null", () => {
    expect(splitTableToRows("这只是一段普通文本，没有表格结构")).toBeNull();
  });

  it("超过上限行数只保留前 N 条，totalRows 记录真实总数", () => {
    const header = "姓名\t编号";
    const dataRows = Array.from({ length: 62 }, (_, i) => `用户${i}\t${i}`);
    const text = [header, ...dataRows].join("\n");
    const result = splitTableToRows(text);
    expect(result!.rows).toHaveLength(MAX_TABLE_SPLIT_ROWS);
    expect(result!.totalRows).toBe(62);
  });

  it("format: field-value → 每列格式化为「列名: 值」", () => {
    const text = "姓名\t邮箱\n张三\tzhang@qq.com";
    const result = splitTableToRows(text, { format: "field-value" });
    expect(result!.rows).toEqual(["姓名: 张三; 邮箱: zhang@qq.com"]);
  });

  it("includeHeader: true → 首条是表头行", () => {
    const text = "姓名\t邮箱\n张三\tzhang@qq.com";
    const result = splitTableToRows(text, { includeHeader: true });
    expect(result!.rows).toEqual(["姓名\t邮箱", "张三\tzhang@qq.com"]);
  });

  it("竖着复制的单列（无 Tab，多行短值）也能拆分，每行当一条，没有表头概念不丢首行", () => {
    const text = "D-HC6239772\nD-HC6239773\nD-HC6239774\nD-HC6239775";
    const result = splitTableToRows(text);
    expect(result).not.toBeNull();
    expect(result!.rows).toEqual(["D-HC6239772", "D-HC6239773", "D-HC6239774", "D-HC6239775"]);
    expect(result!.totalRows).toBe(4);
  });

  it("单行文本（只有一行）不算单列表格，返回 null", () => {
    expect(splitTableToRows("D-HC6239772")).toBeNull();
  });

  it("单列候选里有一行过长（更像段落文本）时不当单列处理，返回 null", () => {
    const longLine = "a".repeat(90);
    const text = `短一行\n${longLine}`;
    expect(splitTableToRows(text)).toBeNull();
  });

  it("单列也遵守 50 条上限，totalRows 记录真实总数", () => {
    const lines = Array.from({ length: 62 }, (_, i) => `ID-${i}`);
    const result = splitTableToRows(lines.join("\n"));
    expect(result!.rows).toHaveLength(MAX_TABLE_SPLIT_ROWS);
    expect(result!.totalRows).toBe(62);
  });
});
