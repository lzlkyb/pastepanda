//! v6.10 测试规划 · 红线守卫(前端)。
//!
//! 三条红线的前端侧断言:
//! 1. **不自动执行**:所有 AI 变换(remote)都经 aiRun 管线——该管线在后端强制
//!    「敏感内容先确认 + 非本地服务商出网确认」,前端无法绕过。
//! 2. **本地动作不出网**:非 remote 变换不依赖 aiRun(无 AI 网络调用)。
//! 3. **AI 动作注册不静默失败**:ai_list_actions 返回动作即注册成功。

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
// 副作用导入:注册全部预置本地变换(json_format 等)与 AI 变换工厂
import "@/lib/transforms/index";
import { initAiTransforms } from "@/lib/transforms/aiTransforms";
import { listTransforms, getTransform } from "@/lib/transforms/registry";
import type { Transform } from "@/lib/transforms/types";

// remote 变换的 run 是 makeRun 闭包,toString 会包含 aiRun 管线调用线索。
// 本守卫是「防未来重构把 remote 变换改成纯本地处理」的静态哨兵。
const AI_RUN_HINTS = ["aiRun", "ai_run", "transforms/ai", "invoke"];

function hasAiHint(t: Transform): boolean {
  return AI_RUN_HINTS.some((h) => String(t.run).includes(h));
}

describe("红线守卫 · AI 变换", () => {
  beforeAll(async () => {
    // 模拟后端动作列表(与 actions.rs 对齐的动作 id)
    vi.mocked(invoke).mockResolvedValueOnce([
      {
        id: "ai-translate",
        label: "翻译",
        description: "翻译成目标语言",
        icon: "languages",
        maxTokens: 1024,
        options: [],
        contentTypes: ["text"],
      },
      {
        id: "ai-summarize",
        label: "总结",
        description: "提炼要点",
        icon: "file-text",
        maxTokens: 1024,
        options: [],
        contentTypes: ["text"],
      },
    ]);
    // 自定义动作列表为空数组
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await initAiTransforms();
  });
  afterAll(() => {
    vi.mocked(invoke).mockReset();
  });

  it("所有 AI 变换都是 remote(出网语义,必须经 aiRun 管线)", () => {
    const ai = listTransforms().filter((t) => t.group === "ai");
    expect(ai.length).toBeGreaterThanOrEqual(2);
    for (const t of ai) {
      expect(t.remote, `${t.id} 必须是 remote(出网语义)`).toBe(true);
      // remote 变换的 run 必须带 AI 管线线索(后端做敏感/出网确认)
      expect(hasAiHint(t), `${t.id}.run 必须经 AI 管线`).toBe(true);
    }
  });

  it("AI 动作注册成功(可被引用)", () => {
    expect(getTransform("ai-translate")).toBeDefined();
    expect(getTransform("ai-summarize")).toBeDefined();
  });
});

describe("红线守卫 · 本地变换", () => {
  it("本地变换不是 remote,且 run 无 AI 管线线索", async () => {
    const jf = getTransform("json_format") as Transform | undefined;
    expect(jf, "json_format 是预置本地变换").toBeDefined();
    // remote 是可选项:undefined/false 都算本地。本地变换 run 必须无 AI 管线线索
    expect(!jf!.remote, "本地变换不是 remote").toBe(true);
    expect(hasAiHint(jf!), "本地变换不应经 AI 管线").toBe(false);
    // 本地变换 run 直接执行本地算法(不依赖 invoke);run 可能是异步,统一 await
    const r = await jf!.run('{"a":1}');
    expect(r.ok).toBe(true);
    expect(r.output).toBe('{\n  "a": 1\n}');
  });
});

describe("G5 · 动作 id 前后端对齐(契约快照)", () => {
  // 与 src-tauri/src/ai/actions.rs 的 ACTIONS 定义对齐(改动任一侧需同步,否则快捷区/意图推荐悬空)
  const BACKEND_AI_IDS = [
    "ai-commit-message",
    "ai-explain-code",
    "ai-fix-code",
    "ai-followup",
    "ai-json-to-type",
    "ai-key-points",
    "ai-merge-polish",
    "ai-polish",
    "ai-regex-generate",
    "ai-reply-draft",
    "ai-rewrite",
    "ai-sql-generate",
    "ai-summarize",
    "ai-tabulate",
    "ai-translate",
    "ai-weekly-report",
  ] as const;

  it("快捷区/意图硬编码引用的 AI 动作 id 必须存在于后端清单", () => {
    // 前端 ACTIONS 表与 intent.ts 里硬编码的 ai 动作 id(与 lib/aiQuick.ts 对齐)
    const frontendReferenced = [
      "ai-translate",
      "ai-summarize",
      "ai-rewrite",
      "ai-key-points",
      "ai-explain-code",
      "ai-json-to-type",
    ] as const;
    for (const id of frontendReferenced) {
      // 静态契约:前端硬编码引用的 id 必须存在于后端动作清单(注册检查由
      // 「所有 AI 变换都是 remote」测试承担——那边 mock 了真实动作列表)
      expect(BACKEND_AI_IDS as readonly string[]).toContain(id);
    }
    // 后端清单本身无重复
    expect(new Set(BACKEND_AI_IDS).size).toBe(BACKEND_AI_IDS.length);
  });
});
