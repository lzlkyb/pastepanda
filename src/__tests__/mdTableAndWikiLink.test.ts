/**
 * B1 #12 的两块纯逻辑：表格单元格定位、`[[` 候选匹配。
 *
 * 键位绑定本身不测（那需要真的 CodeMirror 实例），
 * 但判断“该不该接管、接管后去哪”的全部逻辑都在这里。
 */
import { describe, it, expect } from "vitest";
import { isTableRow, cellRanges, cellIndexAt, nextCellCol, separatorRow } from "@/lib/mdTable";
import { matchWikiPrefix, filterTitles } from "@/components/notes/wikiLinkComplete";

describe("mdTable", () => {
  it("只认行首是 | 的行", () => {
    expect(isTableRow("| a | b |")).toBe(true);
    expect(isTableRow("   | a |")).toBe(true);
    // 宁可漏接管，不能把普通行的 Tab 抢走
    expect(isTableRow("a | b")).toBe(false);
    expect(isTableRow("")).toBe(false);
  });

  it("转义过的 \\| 不算分隔符", () => {
    // 一共两格，不是三格
    const line = "| a \\| b | c |";
    expect(cellRanges(line)).toHaveLength(2);
  });

  it("光标落在分隔符上算左边那格", () => {
    const line = "| a | b |";
    //            0123456789
    expect(cellIndexAt(line, 2)).toBe(0); // 在 a 上
    expect(cellIndexAt(line, 4)).toBe(0); // 恰好在中间的 |
    expect(cellIndexAt(line, 6)).toBe(1); // 在 b 上
  });

  it("Tab 跳下一格，落在内容开头而不是空格上", () => {
    const line = "| a | b |";
    const col = nextCellCol(line, 2, 1);
    expect(col).not.toBeNull();
    expect(line[col!]).toBe("b");
  });

  it("已在末格/首格时返回 null（放行给默认缩进）", () => {
    const line = "| a | b |";
    expect(nextCellCol(line, 6, 1)).toBeNull(); // 末格再往后
    expect(nextCellCol(line, 2, -1)).toBeNull(); // 首格再往前
    // 不是表格行一律不接管
    expect(nextCellCol("普通一行字", 2, 1)).toBeNull();
  });

  it("按表头生成分隔行，保留缩进", () => {
    expect(separatorRow("| 姓名 | 备注 |")).toBe("| --- | --- |");
    expect(separatorRow("  | a | b | c |")).toBe("  | --- | --- | --- |");
    expect(separatorRow("不是表格")).toBe("");
  });
});

describe("wikiLink 候选", () => {
  it("认出 `[[` 后的关键词", () => {
    // 前(0)面(1)的(2)字(3) 空格(4) [(5) [(6) ⇒ 关键词从 7 开始
    expect(matchWikiPrefix("前面的字 [[会议")).toEqual({ from: 7, keyword: "会议" });
    expect(matchWikiPrefix("[[")).toEqual({ from: 2, keyword: "" });
  });

  it("已闭合的链接不再提示", () => {
    expect(matchWikiPrefix("[[会议纪要]] 后面又写了字")).toBeNull();
  });

  it("没有 [[ 、或跨行时不提示", () => {
    expect(matchWikiPrefix("普通文本")).toBeNull();
    expect(matchWikiPrefix("[[写一半\n换行了")).toBeNull();
  });

  it("前缀命中排在包含命中前面", () => {
    const titles = ["项目会议纪要", "会议纪要", "会议待办"];
    expect(filterTitles(titles, "会议")).toEqual(["会议纪要", "会议待办", "项目会议纪要"]);
  });

  it("大小写不敏感，空关键词给全部", () => {
    expect(filterTitles(["README", "api.md"], "re")).toEqual(["README"]);
    expect(filterTitles(["a", "b"], "  ")).toEqual(["a", "b"]);
  });
});
