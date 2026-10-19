/**
 * blockLocate 纯函数守卫：顶层块收集与整块替换。
 *
 * 防假绿核对（见文末「变异记录」）：collectTopBlocks 的偏移漂移、
 * replaceBlockAt 漏掉 expectRaw 校验，都会让这里的用例精确变红。
 */
import { describe, it, expect } from "vitest";
import { collectTopBlocks, replaceBlockAt } from "@/lib/markdown/blockLocate";

const MIXED = [
  "开头段",
  "",
  "## 标题",
  "",
  "- [ ] 任务",
  "- 普通项",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "```js",
  "code()",
  "```",
  "",
  "> 引用",
  "",
  "---",
  "",
  "结尾段",
].join("\n");

describe("collectTopBlocks", () => {
  it("跳过 hr 与空行，顺序与预览顶层元素一致，偏移落在真实源码上", () => {
    const { blocks, complete } = collectTopBlocks(MIXED);
    expect(complete).toBe(true);
    // hr 与空行不产出块：段落/标题/列表/表格/代码/引用/结尾段
    expect(blocks.map((b) => b.raw.split("\n")[0])).toEqual([
      "开头段", "## 标题", "- [ ] 任务", "| a | b |", "```js", "> 引用", "结尾段",
    ]);
    // 每个块的 [from,to) 切出来必须逐字等于 raw
    for (const b of blocks) expect(MIXED.slice(b.from, b.to)).toBe(b.raw);
  });

  it("代码块里的分隔线/列表符号不会骗过定位（raw 原样整体取出）", () => {
    const md = "前段\n\n```\n---\n- [x] 假任务\n```\n\n后段";
    const { blocks } = collectTopBlocks(md);
    expect(blocks).toHaveLength(3);
    expect(blocks[1].raw).toBe("```\n---\n- [x] 假任务\n```");
  });

  it("index 连续且行号递增", () => {
    const { blocks } = collectTopBlocks(MIXED);
    expect(blocks.map((b) => b.index)).toEqual(blocks.map((_, i) => i));
    for (let i = 1; i < blocks.length; i += 1) expect(blocks[i].line).toBeGreaterThan(blocks[i - 1].line);
  });
});

describe("replaceBlockAt", () => {
  it("整块替换：只动那一段源码，前后块逐字保留", () => {
    const { blocks } = collectTopBlocks(MIXED);
    const list = blocks[2]; // - [ ] 任务 / - 普通项
    const r = replaceBlockAt(MIXED, 2, "- 新一\n- 新二", list.raw);
    expect(r).not.toBeNull();
    expect(r!.next).toContain("- 新一\n- 新二");
    expect(r!.next).toContain("## 标题");
    expect(r!.next).toContain("| a | b |");
    expect(r!.next).not.toContain("- [ ] 任务");
  });

  it("expectRaw 不一致（浮层开着期间文档被改过）→ 拒绝写入", () => {
    const { blocks } = collectTopBlocks(MIXED);
    expect(replaceBlockAt(MIXED, 2, "x", "不是原来的 raw")).toBeNull();
    // index 存在但 expectRaw 是别的块的内容也不行
    expect(replaceBlockAt(MIXED, 2, "x", blocks[0].raw)).toBeNull();
  });

  it("index 越界 → null", () => {
    const { blocks } = collectTopBlocks(MIXED);
    expect(replaceBlockAt(MIXED, blocks.length, "x", "whatever")).toBeNull();
    expect(replaceBlockAt(MIXED, -1, "x", "whatever")).toBeNull();
  });

  it("结尾换行保护：紧贴列表的段落 raw 自带 \\n，替换后不许粘连", () => {
    const md = "A\n- x\n- y";
    const { blocks } = collectTopBlocks(md);
    expect(blocks[0].raw).toBe("A\n"); // 紧贴下一块时 raw 含换行
    const r = replaceBlockAt(md, 0, "A2", "A\n");
    expect(r!.next).toBe("A2\n- x\n- y"); // 补回换行，不会变成 "A2- x"
  });

  it("替换内容以换行结尾时不再追加", () => {
    const md = "A\n- x";
    const r = replaceBlockAt(md, 0, "A2\n", "A\n");
    expect(r!.insert).toBe("A2\n");
    expect(r!.next).toBe("A2\n- x");
  });

  it("newRaw 为空 = 删除该块（空串不加换行）", () => {
    const md = "甲\n\n乙";
    const { blocks } = collectTopBlocks(md);
    const r = replaceBlockAt(md, 0, "", blocks[0].raw);
    // 「甲」没了，但块间空行属于 space token，原样留下（解析无碍，只是块前多一空行）
    expect(r!.next).toBe("\n\n乙");
  });
});

/* ─── 变异记录（防假绿，2026-10-19 实测，均精确变红后还原）───
 * 1. replaceBlockAt 删掉 `b.raw !== expectRaw` 比对 → 「expectRaw 不一致」变红。
 * 2. 结尾换行保护改成 if(false) → 「不许粘连」变红（next 变 "A2- x\n- y"）。
 * 3. `to = from + raw.length - 1`（偏移漂移）→ 偏移断言与 3 条替换用例同时变红。
 */
