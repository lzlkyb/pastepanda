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

  // ── 2026-09-10 审查时实测出来的坑，逐条钉住 ──

  it("单列带尾部 Tab（Excel 选区带了空列）不能把首行当表头吃掉", () => {
    // 🔴 最严重的一条：以前 D-001 被当表头，3 个工单号只拆出 2 条，
    //    而提示还说「已按行拆 2 条入栈」——静默丢数据。
    const result = splitTableToRows("D-001\t\nD-002\t\nD-003\t");
    expect(result!.rows).toEqual(["D-001", "D-002", "D-003"]);
    expect(result!.totalRows).toBe(3);
  });

  it("真多列表尾部有空单元格时仍按多列拆，不被「其实是一列」误判", () => {
    const result = splitTableToRows("单号\t重量\t备注\nD-001\t12\t\nD-002\t13\t");
    expect(result!.rows).toEqual(["D-001\t12\t", "D-002\t13\t"]);
  });

  it("首行是合并标题行时剔掉它再识别，标题不入栈", () => {
    const result = splitTableToRows("销售明细表\n单号\t重量\nD-001\t12\nD-002\t13");
    expect(result!.rows).toEqual(["D-001\t12", "D-002\t13"]);
  });

  it("Tab 表格里混进一行 +---+ 时仍能拆（parseTable 会锁定边框分支不回退）", () => {
    const result = splitTableToRows("单号\t重量\n+----+\nD-001\t12\nD-002\t13");
    expect(result!.rows).toEqual(["D-001\t12", "D-002\t13"]);
  });

  it("边框表格解析不成时返回 null，绝不掉进单列兜底产出边框线", () => {
    // 🔴 某个值含竖线 → 列数不一致 → 以前会把 "+----+------+" 也当成一行数据入栈
    const text = [
      "+----+------+",
      "| id | name |",
      "+----+------+",
      "|  1 | a|b  |",
      "|  2 | cd   |",
      "+----+------+",
    ].join("\n");
    expect(splitTableToRows(text)).toBeNull();
  });

  it("单列里有一行超长时整批保留，不因一行而全否", () => {
    // 以前「任一行超 80 字就整批否决」，复制一列 URL / 一列备注时整个功能失灵。
    // 判定成立就整批保留——把那一行踢掉是另一种静默丢数据。
    const long = "x".repeat(85);
    const result = splitTableToRows(`D-001\n${long}\nD-003`);
    expect(result!.rows).toEqual(["D-001", long, "D-003"]);
  });

  it("单列里某行含 Tab 时也整批保留", () => {
    const result = splitTableToRows("D-001\nD-002\tX\nD-003");
    expect(result!.rows).toEqual(["D-001", "D-002\tX", "D-003"]);
  });

  it("数据行少两个单元格时补齐再拆（以前容差只允许少一个）", () => {
    const result = splitTableToRows("a\tb\tc\n1\t2\t3\n4");
    expect(result!.rows).toEqual(["1\t2\t3", "4\t\t"]);
  });

  it("整段都是长行的段落不当单列，返回 null", () => {
    // 比例判定守的就是这个下限：一行也不像「一行一个短值」时不能当列表。
    const lines = Array.from({ length: 4 }, (_, i) => `第${i}段：` + "文字".repeat(50));
    expect(splitTableToRows(lines.join("\n"))).toBeNull();
  });
});
