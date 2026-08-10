import { describe, it, expect } from "vitest";
import { parseReplyCandidates } from "@/lib/replyCandidates";

describe("parseReplyCandidates", () => {
  it("解析 3 个标题分隔的候选", () => {
    const out = [
      "---正式版---",
      "您好，明天下午三点可以开会。",
      "---简洁版---",
      "明天三点可以。",
      "---轻松版---",
      "好呀，明天下午三点见！",
    ].join("\n");
    const c = parseReplyCandidates(out);
    expect(c).toHaveLength(3);
    expect(c[0]).toEqual({ title: "正式版", text: "您好，明天下午三点可以开会。" });
    expect(c[1]).toEqual({ title: "简洁版", text: "明天三点可以。" });
    expect(c[2]).toEqual({ title: "轻松版", text: "好呀，明天下午三点见！" });
  });

  it("无标题标记时回退为单候选（原文）", () => {
    const plain = "这是一段普通回复，没有分隔标记。";
    const c = parseReplyCandidates(plain);
    expect(c).toHaveLength(1);
    expect(c[0]).toEqual({ title: "", text: plain });
  });

  it("标题后内容为空时跳过该候选", () => {
    const out = "---正式版---\n有内容的候选\n---简洁版---";
    const c = parseReplyCandidates(out);
    expect(c).toHaveLength(1);
    expect(c[0].title).toBe("正式版");
  });

  it("空输入返回空数组", () => {
    expect(parseReplyCandidates("")).toEqual([]);
    expect(parseReplyCandidates("   \n  ")).toEqual([]);
  });

  it("内容中间出现 --- 行不会被误切（只有段首标题行算）", () => {
    // 第二段内容里有一行 ---- 装饰线，lookahead 只认 \n---xxx--- 行首格式
    const out = [
      "---正式版---",
      "第一段正文。",
      "---简洁版---",
      "正文里的一行装饰：",
      "----",
      "结束。",
    ].join("\n");
    const c = parseReplyCandidates(out);
    expect(c).toHaveLength(2);
    expect(c[1].text).toContain("结束。");
  });

  it("前后空白与标题多余空格被清理", () => {
    const out = "  \n---  正式版  ---\n  候选文本  \n";
    const c = parseReplyCandidates(out);
    expect(c).toHaveLength(1);
    expect(c[0].title).toBe("正式版");
    expect(c[0].text).toBe("候选文本");
  });
});
