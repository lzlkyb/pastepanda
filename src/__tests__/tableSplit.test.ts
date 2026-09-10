/**
 * 表格拆分入栈（方案 A+B）：拆分纯函数测试。
 */
import { describe, it, expect } from "vitest";
import {
  splitTableToRows,
  MAX_TABLE_SPLIT_ROWS,
  looksLikeTableButUnsplit,
} from "@/lib/tableSplit";

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
    // 只有表头没数据行：边框分支拿不到 2 行，剔掉边框线后也只剩 1 行。
    // 🔴 关键是它**不能**掉进单列兜底——那会把两条 `+----+------+`
    //    和表头一共 3 条当数据入栈。
    const text = ["+----+------+", "| id | name |", "+----+------+"].join("\n");
    expect(splitTableToRows(text)).toBeNull();
  });

  it("边框表格里某个值含竖线时，改拿边框线定列位仍能拆", () => {
    // 以前简单按竖线切会多切出一列 → 整张表被否决 → 掉进单列兜底产出边框线。
    // 现在简单切法失败就改拿 `+----+------+` 的 `+` 位置按字符列切。
    const text = [
      "+----+------+",
      "| id | name |",
      "+----+------+",
      "|  1 | a|b  |",
      "|  2 | cd   |",
      "+----+------+",
    ].join("\n");
    const result = splitTableToRows(text);
    expect(result!.rows).toEqual(["1\ta|b", "2\tcd"]);
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

  it("单元格内含换行（Excel 多行单元格）不被劈成两条，引号也去掉", () => {
    // 🔴 以前实测拆出 3 条，第一条是 `D-001\t"第一行`——一个格子被劈成两条、
    //    引号还留着，数据静默破坏。现在引号内的换行先藏起来，出结果再还原。
    const text = '单号\t备注\nD-001\t"第一行\n第二行"\nD-002\tok';
    const result = splitTableToRows(text);
    expect(result!.rows).toEqual(["D-001\t第一行\n第二行", "D-002\tok"]);
    expect(result!.totalRows).toBe(2);
  });

  it("单元格里成对的双引号按 TSV 约定还原", () => {
    const text = '单号\t备注\nD-001\t"他说""你好""\n第二行"\nD-002\tok';
    const result = splitTableToRows(text);
    expect(result!.rows[0]).toBe('D-001\t他说"你好"\n第二行');
  });

  it("引号不成对时不动原文（那就不是 Excel 那套转义）", () => {
    // 宁可不处理，也不能拿一个孤零零的引号当依据去改用户内容。
    const text = '单号\t备注\nD-001\t他说"你好\nD-002\tok';
    const result = splitTableToRows(text);
    expect(result!.rows).toEqual(['D-001\t他说"你好', "D-002\tok"]);
  });

  it("字段中间的引号（英寸符）不是定界符，不能吞掉行分隔", () => {
    // 🔴 第一版把任何引号都当定界符，两个英寸符正好凑成一对 →
    //    中间那个换行被当成「引号内的换行」吞掉，「合适」那行整个丢了，
    //    两行数据拼成一条。TSV 约定：引号只在字段首字符位置才有转义含义。
    const result = splitTableToRows('尺寸\t备注\n24"\t偏大\n27"\t合适');
    expect(result!.rows).toEqual(['24"\t偏大', '27"\t合适']);
  });

  it("字段中间成对的引号也不算定界符（第一版会整表返 null）", () => {
    const result = splitTableToRows('a\tb"c\nd\te"f');
    expect(result!.rows).toEqual(['d\te"f']);
  });

  it("边框线与数据行不等长时不用位置切法（错位数据比不认更糟）", () => {
    // 位置切法的前提是定宽对齐。表被手工编辑过时宁可不认——
    // 切出来的错位内容用户看不出来。
    const text = ["+--+--+", "| id | name |", "+--+--+", "|  1 | a|b  |"].join("\n");
    expect(splitTableToRows(text)).toBeNull();
  });
});

describe("looksLikeTableButUnsplit", () => {
  it("多数行含 Tab → 算「像表格」", () => {
    expect(looksLikeTableButUnsplit("a\tb\nc\td")).toBe(true);
  });

  it("有边框线 → 算「像表格」", () => {
    expect(looksLikeTableButUnsplit("+----+\n| a |")).toBe(true);
  });

  it("普通多行文字 → 不算（否则每次复制都被念一遍）", () => {
    expect(looksLikeTableButUnsplit("第一行\n第二行\n第三行")).toBe(false);
  });

  it("单行 → 不算", () => {
    expect(looksLikeTableButUnsplit("a\tb")).toBe(false);
  });
});
