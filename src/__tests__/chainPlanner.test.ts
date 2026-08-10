import { describe, it, expect } from "vitest";
import { parseChainPlan, plannedToChain, MAX_PLANNED_STEPS } from "@/lib/chains/planner";
// 触发内置变换注册（白名单校验靠的就是这份注册表）
import "@/lib/transforms";

describe("parseChainPlan—容错解析", () => {
  it("纯 JSON", () => {
    const p = parseChainPlan('{"name":"测试链","steps":[{"transformId":"strip"}]}');
    expect(p).not.toBeNull();
    expect(p!.name).toBe("测试链");
    expect(p!.steps.map((s) => s.transformId)).toEqual(["strip"]);
  });

  it("剥 ```json 围栅", () => {
    const raw = '好的，这是方案：\n```json\n{"steps":["strip"]}\n```\n希望有帮助';
    const p = parseChainPlan(raw);
    expect(p!.steps.map((s) => s.transformId)).toEqual(["strip"]);
  });

  it("剥无语言标记的围栅", () => {
    const p = parseChainPlan('```\n{"steps":["strip"]}\n```');
    expect(p!.steps).toHaveLength(1);
  });

  it("前后夹散文也能抠出来", () => {
    const p = parseChainPlan('我建议这样做：{"steps":["strip"]} 你看行吗？');
    expect(p!.steps).toHaveLength(1);
  });

  it("字段名漂移：plan / actions / pipeline 都认", () => {
    for (const key of ["plan", "actions", "pipeline", "chain"]) {
      const p = parseChainPlan(`{"${key}":["strip"]}`);
      expect(p, key).not.toBeNull();
      expect(p!.steps, key).toHaveLength(1);
    }
  });

  it("步骤项字段名漂移：id / action / transform 都认", () => {
    for (const key of ["id", "action", "actionId", "transform", "step"]) {
      const p = parseChainPlan(`{"steps":[{"${key}":"strip"}]}`);
      expect(p, key).not.toBeNull();
      expect(p!.steps, key).toHaveLength(1);
    }
  });

  it("不是 JSON → null", () => {
    expect(parseChainPlan("我不知道该怎么做")).toBeNull();
    expect(parseChainPlan("")).toBeNull();
    expect(parseChainPlan("{壏不完整的")).toBeNull();
  });

  it("步骤数组缺失或为空 → null", () => {
    expect(parseChainPlan('{"name":"空链"}')).toBeNull();
    expect(parseChainPlan('{"steps":[]}')).toBeNull();
  });
});

describe("parseChainPlan—红线 1：白名单", () => {
  it("模型编造的 id 被丢弃并记入 dropped", () => {
    const p = parseChainPlan(
      '{"steps":["strip","ai-fix-my-bug","json_format"]}',
    );
    expect(p!.steps.map((s) => s.transformId)).toEqual(["strip", "json_format"]);
    expect(p!.dropped).toEqual(["ai-fix-my-bug"]);
  });

  it("全是编造的 id → null（不该给用户看任何东西）", () => {
    const p = parseChainPlan('{"steps":["foo","bar","baz"]}');
    expect(p).toBeNull();
  });

  it("dropped 不重复记同一个 id", () => {
    const p = parseChainPlan('{"steps":["strip","foo","foo"]}');
    expect(p!.dropped).toEqual(["foo"]);
  });
});

describe("parseChainPlan—红线 2：risk 不采信模型", () => {
  /**
   * runChain 靠 risk 和 t.remote 决定要不要弹 onAiConfirm。
   * 如果采信模型写的 risk，它把联网步骤标成 local 就绕过了确认。
   */
  it("模型把本地步骤标成 network 也不算", () => {
    const p = parseChainPlan('{"steps":[{"id":"strip","risk":"network"}]}');
    expect(p!.steps[0].risk).toBe("local");
  });

  it("模型写了个非法 risk 也不会透传", () => {
    const p = parseChainPlan('{"steps":[{"id":"strip","risk":"随便填的"}]}');
    expect(p!.steps[0].risk).toBe("local");
  });
});

describe("parseChainPlan—红线 3：执行类不收", () => {
  /**
   * 执行类变换产生副作用（开浏览器等）而不产出文本。
   * ChainEditor 给人选的时候就排除了它们，而这里的输入来自模型，更不能放。
   */
  it("act-open-url 被丢弃", () => {
    const p = parseChainPlan('{"steps":["strip","act-open-url"]}');
    expect(p!.steps.map((s) => s.transformId)).toEqual(["strip"]);
    expect(p!.dropped).toContain("act-open-url");
  });

  it("只有执行类 → null", () => {
    expect(parseChainPlan('{"steps":["act-open-url"]}')).toBeNull();
  });
});

describe("parseChainPlan—步数与去重", () => {
  it(`最多 ${MAX_PLANNED_STEPS} 步`, () => {
    // 交替写两个合法 id，避开“连续重复”去重
    const ids = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0 ? "strip" : "json_format",
    );
    const p = parseChainPlan(JSON.stringify({ steps: ids }));
    expect(p!.steps).toHaveLength(MAX_PLANNED_STEPS);
  });

  it("连续重复的同一步骤合并", () => {
    const p = parseChainPlan('{"steps":["strip","strip","json_format"]}');
    expect(p!.steps.map((s) => s.transformId)).toEqual(["strip", "json_format"]);
  });

  it("非连续的重复保留（先清再格式再清是合理的）", () => {
    const p = parseChainPlan('{"steps":["strip","json_format","strip"]}');
    expect(p!.steps).toHaveLength(3);
  });
});

describe("parseChainPlan—文案限长与兼容", () => {
  it("没给名字时有兼容值", () => {
    const p = parseChainPlan('{"steps":["strip"]}');
    expect(p!.name).toBeTruthy();
    expect(p!.description).toBe("");
  });

  it("过长的名字与说明被截断", () => {
    const long = "很".repeat(200);
    const p = parseChainPlan(
      JSON.stringify({ name: long, description: long, steps: ["strip"] }),
    );
    expect(p!.name.length).toBeLessThanOrEqual(24);
    expect(p!.description.length).toBeLessThanOrEqual(80);
  });

  it("换行被压成单空格（界面是单行）", () => {
    const p = parseChainPlan('{"name":"a\\nb","steps":["strip"]}');
    expect(p!.name).toBe("a b");
  });
});

describe("plannedToChain", () => {
  it("带 ai-planned 前缀，下游能认出是 AI 编的", () => {
    const p = parseChainPlan('{"name":"X","steps":["strip"]}')!;
    const c = plannedToChain(p);
    expect(c.id).toBe("ai-planned");
    expect(c.name).toBe("X");
    expect(c.steps).toEqual(p.steps);
  });
});
