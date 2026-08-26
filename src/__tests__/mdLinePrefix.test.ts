/**
 * Markdown 行首前缀改写。
 *
 * 这里验的都是旧实现真实踩过的坑：多行选区只改第一行、重复点叠前缀、
 * 有序列表全是 1.。每条用例对应一个用户会真的做的动作。
 */

import { describe, it, expect } from "vitest";
import { matchLinePrefix, planLinePrefix } from "@/lib/mdLinePrefix";

/** 把 plan 应用到原文上，得到改写后的行——断言看结果比看 offset 直观得多。 */
function apply(lines: string[], prefix: string): string[] {
  const plan = planLinePrefix(lines, prefix);
  return lines.map((t, i) => {
    const p = plan[i];
    return p ? p.insert + t.slice(p.replaceLen) : t;
  });
}

describe("matchLinePrefix", () => {
  it("任务列表优先于无序列表", () => {
    // ❌ 顺序反了的话 `- [ ] x` 只会认出 `- `，点任务列表会叠成 `- [ ] [ ] x`
    expect(matchLinePrefix("- [ ] 写文档")).toEqual({ indent: "", token: "- [ ] " });
    expect(matchLinePrefix("- [x] 已完成")).toEqual({ indent: "", token: "- [x] " });
  });

  it("保留嵌套缩进", () => {
    expect(matchLinePrefix("    - 子项")).toEqual({ indent: "    ", token: "- " });
  });

  it("识别任意级别标题与任意序号", () => {
    expect(matchLinePrefix("### 三级")?.token).toBe("### ");
    expect(matchLinePrefix("12. 第十二项")?.token).toBe("12. ");
  });

  it("普通文本没有前缀", () => {
    expect(matchLinePrefix("普通一行")).toBeNull();
    // #hashtag 不是标题（# 后面必须有空格）
    expect(matchLinePrefix("#hashtag")).toBeNull();
  });
});

describe("planLinePrefix", () => {
  it("多行选区每一行都加上", () => {
    // 旧实现只改第一行 —— 本文件最主要的回归
    expect(apply(["第一", "第二", "第三"], "- ")).toEqual(["- 第一", "- 第二", "- 第三"]);
  });

  it("有序列表逐行递增", () => {
    expect(apply(["a", "b", "c"], "1. ")).toEqual(["1. a", "2. b", "3. c"]);
  });

  it("全部已是目标前缀时整体取消", () => {
    expect(apply(["- a", "- b"], "- ")).toEqual(["a", "b"]);
    expect(apply(["> 引用"], "> ")).toEqual(["引用"]);
  });

  it("重复点引用不会叠成 > > >", () => {
    const once = apply(["文字"], "> ");
    expect(once).toEqual(["> 文字"]);
    expect(apply(once, "> ")).toEqual(["文字"]); // 再点一下回去，而不是 "> > 文字"
  });

  it("同族不同级是替换而不是叠加", () => {
    // ❌ 旧实现会得到 "## # 一级标题"
    expect(apply(["# 一级标题"], "## ")).toEqual(["## 一级标题"]);
    expect(apply(["- 普通项"], "- [ ] ")).toEqual(["- [ ] 普通项"]);
    expect(apply(["- [ ] 任务"], "- ")).toEqual(["- 任务"]);
  });

  it("部分已有前缀时统一加上，而不是取消", () => {
    // 只有一行是列表 → 意图显然是“全部变列表”，不是“取消那一行”
    expect(apply(["- a", "b"], "- ")).toEqual(["- a", "- b"]);
  });

  it("跳过空行", () => {
    // 选一段带空行的文字转列表，不能多出空列表项
    expect(apply(["a", "", "b"], "- ")).toEqual(["- a", "", "- b"]);
  });

  it("空行不占有序序号", () => {
    expect(apply(["a", "", "b"], "1. ")).toEqual(["1. a", "", "2. b"]);
  });

  it("整块全空行时仍然加前缀（按钮不能点了没反应）", () => {
    expect(apply([""], "- ")).toEqual(["- "]);
  });

  it("缩进始终留在前缀**前面**", () => {
    // ❌ 不单独处理缩进的话会得到 "-   子项" —— 前缀跑到缩进前面了
    expect(apply(["  子项"], "- ")).toEqual(["  - 子项"]);
    expect(apply(["  - 子项"], "1. ")).toEqual(["  1. 子项"]);
  });
});
