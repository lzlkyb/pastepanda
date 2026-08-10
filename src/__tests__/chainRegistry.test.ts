import { describe, it, expect } from "vitest";
import { PRESET_CHAINS, getPresetChain, runChain } from "@/lib/chains/registry";
import { registerTransform, unregisterTransform } from "@/lib/transforms/registry";
import type { Chain } from "@/lib/chains/types";
import type { Transform } from "@/lib/transforms/types";
// 触发内置变换注册（strip_html / strip_lines / json_format / mask-sensitive / html_decode）
import "@/lib/transforms";

describe("runChain · 链式执行", () => {
  it("上一步输出作为下一步输入（网页 → 纯文本）", async () => {
    const chain = getPresetChain("web-to-text")!;
    const r = await runChain(chain, "<b>Hi</b>\n\n<i>there</i>");
    expect(r.ok).toBe(true);
    expect(r.stages).toHaveLength(3);
    // 第 1 步剥标签
    expect(r.stages[0].output).not.toContain("<b>");
    expect(r.stages[0].output).not.toContain("<i>");
    // 第 2 步的输出 = 第 1 步的输出去掉空行（输入是上一步的产物）
    expect(r.stages[1].input).toBe(r.stages[0].output);
    expect(r.stages[1].output).not.toContain("\n\n");
    // final = 最后一步输出
    expect(r.final).toBe(r.stages[2].output);
  });

  it("JSON 清洗：格式化后保留缩进", async () => {
    const chain = getPresetChain("json-clean")!;
    const r = await runChain(chain, '{"a":1,"b":[1,2]}');
    expect(r.ok).toBe(true);
    expect(r.final).toContain("\n  \"a\"");
  });

  it("敏感脱敏：destructive 步骤生效", async () => {
    const chain = getPresetChain("mask-and-paste")!;
    const r = await runChain(chain, "联系我 13812345678");
    expect(r.ok).toBe(true);
    expect(r.final).toContain("****");
  });

  it("失败定位到步骤并保留原文（JSON 链喂非 JSON）", async () => {
    const chain = getPresetChain("json-clean")!;
    const r = await runChain(chain, "这不是 JSON");
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe(0);
    expect(r.stages[0].ok).toBe(false);
    expect(r.stages[0].error).toContain("JSON");
    // 失败保留原文：final = 最后一个成功步骤的输出（这里没有成功步骤，= 原始输入）
    expect(r.final).toBe("这不是 JSON");
  });

  it("步骤不存在（未注册）按失败处理，不静默跳过", async () => {
    const chain: Chain = {
      id: "broken",
      name: "坏链",
      description: "",
      steps: [
        { transformId: "strip", risk: "local" },
        { transformId: "no-such-transform-xyz", risk: "local" },
      ],
    };
    const r = await runChain(chain, "hello");
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe(1);
    expect(r.stages[1].error).toContain("未注册");
    expect(r.final).toBe("hello"); // 保留第 1 步成功后的输出（此处第 1 步 strip 对 hello 无变化）
  });

  it("空输入可以运行（各步骤自行处理空串）", async () => {
    const chain = getPresetChain("web-to-text")!;
    const r = await runChain(chain, "");
    expect(r.ok).toBe(true);
  });
});

describe("runChain · AI 步骤确认（B2）", () => {
  it("AI 步骤执行前调用确认钩子，拒绝则中止并定位", async () => {
    // 测试环境未初始化 AI 动作，这里直接注册一个 remote 变换充当 AI 步骤
    const remoteT: Transform = {
      id: "fake-remote",
      label: "假远程",
      description: "",
      group: "ai",
      remote: true,
      detect: () => 0.5,
      run: async (text) => ({ ok: true, output: `AI(${text})` }),
    };
    registerTransform(remoteT);
    try {
      const chain: Chain = {
        id: "ai-chain",
        name: "AI 链",
        description: "",
        steps: [{ transformId: "fake-remote", risk: "network" }],
      };

      const denied = await runChain(chain, "hello", {}, async () => false);
      expect(denied.ok).toBe(false);
      expect(denied.failedAt).toBe(0);
      expect(denied.stages[0].error).toContain("取消");
      expect(denied.final).toBe("hello");

      const allowed = await runChain(chain, "hello", {}, async () => true);
      expect(allowed.ok).toBe(true);
      expect(allowed.final).toBe("AI(hello)");
    } finally {
      unregisterTransform("fake-remote");
    }
  });

  it("本地变换（非 remote）不触发确认钩子", async () => {
    const chain = getPresetChain("web-to-text")!;
    let calls = 0;
    const r = await runChain(chain, "<p>x</p>", {}, async () => {
      calls += 1;
      return true;
    });
    expect(r.ok).toBe(true);
    expect(calls).toBe(0);
  });
});

describe("PRESET_CHAINS · 预置链定义", () => {
  it("至少 3 条，且都引用了已注册的变换", async () => {
    expect(PRESET_CHAINS.length).toBeGreaterThanOrEqual(3);
    for (const chain of PRESET_CHAINS) {
      expect(chain.steps.length).toBeGreaterThan(0);
      for (const step of chain.steps) {
        const { getTransform } = await import("@/lib/transforms/registry");
        expect(getTransform(step.transformId), `${chain.id}.${step.transformId}`).toBeDefined();
      }
    }
  });

  it("每条链的步骤都有风险标注", () => {
    for (const chain of PRESET_CHAINS) {
      for (const step of chain.steps) {
        expect(["local", "network", "destructive"]).toContain(step.risk);
      }
    }
  });
});
