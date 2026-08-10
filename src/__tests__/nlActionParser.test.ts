/**
 * v6.3 自然语言动作路由测试。
 *
 * 重点：
 * 1. 关键词 → 正确动作 + 参数（正式→rewrite/formal、翻译成英文→translate/en）；
 * 2. **AI 门控（规则 15）**：AI 动作在未启用时标记 aiDisabled，绝不绕过开关；
 * 3. 本地动作（sql-in）不受 AI 门控影响；
 * 4. 未命中/空输入 → actionId null（不瞎猜）。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { parseNlCommand } from "@/lib/nlActionParser";
import { setAiAvailable } from "@/lib/transforms/aiTransforms";

beforeEach(() => {
  setAiAvailable(true);
});

describe("关键词命中", () => {
  it("正式/礼貌 → ai-rewrite tone=formal", () => {
    const r = parseNlCommand("把这个改得正式一点");
    expect(r.actionId).toBe("ai-rewrite");
    expect(r.params?.tone).toBe("formal");
    expect(r.aiDisabled).toBeUndefined();
  });

  it("简单/口语 → ai-rewrite tone=casual", () => {
    const r = parseNlCommand("说得简单通俗点");
    expect(r.actionId).toBe("ai-rewrite");
    expect(r.params?.tone).toBe("casual");
  });

  it("简洁 → ai-rewrite tone=concise", () => {
    const r = parseNlCommand("帮我简洁一下");
    expect(r.actionId).toBe("ai-rewrite");
    expect(r.params?.tone).toBe("concise");
  });

  it("翻译成英文 → ai-translate lang=en", () => {
    const r = parseNlCommand("翻译成英文");
    expect(r.actionId).toBe("ai-translate");
    expect(r.params?.lang).toBe("en");
  });

  it("翻译成日文 → ai-translate lang=ja", () => {
    const r = parseNlCommand("译成日文");
    expect(r.actionId).toBe("ai-translate");
    expect(r.params?.lang).toBe("ja");
  });

  it("泛「翻译」 → ai-translate 默认 en", () => {
    const r = parseNlCommand("翻译一下");
    expect(r.actionId).toBe("ai-translate");
    expect(r.params?.lang).toBe("en");
  });

  it("总结/摘要 → ai-summarize", () => {
    expect(parseNlCommand("总结要点").actionId).toBe("ai-summarize");
    expect(parseNlCommand("帮我提炼一下").actionId).toBe("ai-summarize");
  });

  it("解释 → ai-explain-code", () => {
    expect(parseNlCommand("解释一下这段").actionId).toBe("ai-explain-code");
  });

  it("sql → sql-in（本地动作）", () => {
    expect(parseNlCommand("转成 SQL IN").actionId).toBe("sql-in");
  });
});

describe("AI 门控（规则 15）", () => {
  it("AI 未启用时，AI 动作标记 aiDisabled", () => {
    setAiAvailable(false);
    const r = parseNlCommand("改得正式一点");
    expect(r.actionId).toBe("ai-rewrite");
    expect(r.aiDisabled).toBe(true);
  });

  it("AI 未启用时，本地动作（sql-in）不受影响", () => {
    setAiAvailable(false);
    const r = parseNlCommand("转成 SQL IN");
    expect(r.actionId).toBe("sql-in");
    expect(r.aiDisabled).toBeUndefined();
  });
});

describe("未命中", () => {
  it("空输入 → null", () => {
    expect(parseNlCommand("").actionId).toBeNull();
    expect(parseNlCommand("   ").actionId).toBeNull();
  });

  it("无意义输入 → null（不瞎猜）", () => {
    expect(parseNlCommand("今天天气不错").actionId).toBeNull();
    expect(parseNlCommand("随便").actionId).toBeNull();
  });
});
