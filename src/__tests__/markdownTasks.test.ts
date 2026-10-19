/**
 * 任务列表源码定位（`lib/markdown/tasks`）—— 预览态勾选写回的底座。
 *
 * 这里钉的是「改哪一行」这件事本身：索引错一位，用户勾第 7 项就改到了第 8 项，
 * 而界面上看不出任何异常（勾选反馈是乐观更新给的）。所以代码块、嵌套、有序、
 * 引用块这几个会把索引带偏的结构必须逐条钉住。
 */
import { describe, it, expect } from "vitest";
import { countTaskProgress, scanTaskItems, toggleTaskAt } from "@/lib/markdown/tasks";

const md = [
  "Q1 客户:", //                                     1
  "", //                                             2
  "- [ ] A. 不对齐规则，客户 8888（建议）", //        3
  "- [x] B. 保持 10-16 的解法", //                    4
  "- [ ] C. 其他：", //                              5
  "", //                                             6
  "```md", //                                        7
  "- [ ] 代码块里的不算", //                          8
  "```", //                                          9
  "", //                                             10
  "1. [ ] 有序列表任务", //                           11
  "   - [X] 嵌套任务", //                            12
  "", //                                             13
  "> - [ ] 引用块里的任务", //                        14
].join("\n");

describe("scanTaskItems", () => {
  it("只认真正的任务项：代码块被排除，顺序与渲染一致", () => {
    const { items, complete } = scanTaskItems(md);
    expect(complete).toBe(true);
    expect(items.map((i) => i.line)).toEqual([3, 4, 5, 11, 12, 14]);
    expect(items.map((i) => i.checked)).toEqual([false, true, false, false, true, false]);
  });

  it("charPos 精确指向 [ ] 中间那个字符", () => {
    const { items } = scanTaskItems(md);
    for (const item of items) {
      expect(md[item.charPos]).toMatch(/[ xX]/);
      expect(md[item.charPos - 1]).toBe("[");
      expect(md[item.charPos + 1]).toBe("]");
    }
  });

  it("空文档 / 无任务项时返回空集且 complete", () => {
    expect(scanTaskItems("普通段落，没有勾选框")).toEqual({ items: [], complete: true });
    expect(scanTaskItems("")).toEqual({ items: [], complete: true });
  });

  it("行内代码里的 - [ ] 不会变成任务项", () => {
    const { items } = scanTaskItems("示例：`- [ ] 不是任务`\n\n- [ ] 这才是任务");
    expect(items).toHaveLength(1);
    expect(items[0].checked).toBe(false);
  });
});

describe("toggleTaskAt", () => {
  it("只改目标那一个字符，其余字节不变", () => {
    const before = scanTaskItems(md).items[0];
    const res = toggleTaskAt(md, 0);
    expect(res).not.toBeNull();
    expect(res!.charPos).toBe(before.charPos);
    expect(res!.insert).toBe("x");
    expect(res!.next).toBe(md.slice(0, before.charPos) + "x" + md.slice(before.charPos + 1));
    expect(res!.next.length).toBe(md.length);
  });

  it("取消勾选写回空格（含大写 [X]）", () => {
    const res = toggleTaskAt(md, 4);
    expect(res!.insert).toBe(" ");
    expect(scanTaskItems(res!.next).items[4].checked).toBe(false);
  });

  it("来回勾两次回到原文", () => {
    const once = toggleTaskAt(md, 1)!;
    const twice = toggleTaskAt(once.next, 1)!;
    expect(twice.next).toBe(md);
  });

  it("下标越界返回 null（不猜、不乱写）", () => {
    expect(toggleTaskAt(md, 99)).toBeNull();
    expect(toggleTaskAt(md, -1)).toBeNull();
  });

  it("结构异常导致定位不可信时拒绝写回", () => {
    // 人为制造「渲染数 ≠ 定位数」：checkboxes 由 lexer 给出，但源码里找不到对应 raw 时
    // 这里用一个极端输入验证兜底路径不会返回一个错误位置
    const weird = "- [ ] a\r\n- [ ] b";
    const res = toggleTaskAt(weird, 1);
    expect(res === null || weird[res.charPos] === " ").toBe(true);
  });
});

describe("countTaskProgress", () => {
  it("统计与 scan 一致，且不因定位失败丢项", () => {
    expect(countTaskProgress(md)).toEqual({ done: 2, total: 6 });
  });

  it("无任务项时为 0/0（面板头据此隐藏）", () => {
    expect(countTaskProgress("没有 checkbox")).toEqual({ done: 0, total: 0 });
  });
});
