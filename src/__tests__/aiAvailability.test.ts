/**
 * 「AI 到底能不能用」三态判定测试（唯一判定 @/lib/aiAvailability）。
 *
 * 重点：
 * 1. 三态：未启用 → off；启用但无密钥 → nokey（就是以前被胶囊说成「就绪」的那个态）；
 *    启用+有密钥 → on；Ollama 这类 needsKey=false 的本地厂商免密钥也得是 on（不能误判成 nokey）；
 * 2. **收口**：变换门控 isAiAvailable() 与胶囊/快捷区读的是同一份状态，不得各算一遍。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// 后端 IPC 全部 mock（aiTransforms 也从这个模块拿函数，所以它用到的名字也要给齐）
const api = vi.hoisted(() => ({
  aiGetConfig: vi.fn(),
  aiHasKey: vi.fn(),
  aiListProviders: vi.fn(),
  aiGetUsageStats: vi.fn(),
  aiListActions: vi.fn(),
  aiListCustomActions: vi.fn(),
  aiRun: vi.fn(),
}));
vi.mock("@/lib/api/ai", () => api);

import {
  getAiAvailability,
  refreshAiAvailability,
  setAiAvailabilityForTest,
} from "@/lib/aiAvailability";
import { isAiAvailable, setAiAvailable } from "@/lib/transforms/aiTransforms";

/** 两个厂商：openai 要密钥，ollama 不要 */
const PROVIDERS = [
  { id: "openai", needsKey: true },
  { id: "ollama", needsKey: false },
];

function cfg(over: Record<string, unknown> = {}) {
  return { enabled: true, provider: "openai", model: "gpt-4o-mini", ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  setAiAvailabilityForTest("loading"); // 清空共享缓存，避免用上一个用例的结论
  api.aiListProviders.mockResolvedValue(PROVIDERS);
  api.aiGetUsageStats.mockResolvedValue({ totalCalls: 12 });
});

describe("三态判定", () => {
  it("未启用 → off", async () => {
    api.aiGetConfig.mockResolvedValue(cfg({ enabled: false }));
    api.aiHasKey.mockResolvedValue(true);
    await refreshAiAvailability();
    expect(getAiAvailability().status).toBe("off");
    expect(isAiAvailable()).toBe(false);
  });

  it("启用但没选服务商 → off", async () => {
    api.aiGetConfig.mockResolvedValue(cfg({ provider: "  " }));
    api.aiHasKey.mockResolvedValue(true);
    await refreshAiAvailability();
    expect(getAiAvailability().status).toBe("off");
  });

  it("启用 + 无密钥 → nokey（绝不能算 on）", async () => {
    api.aiGetConfig.mockResolvedValue(cfg());
    api.aiHasKey.mockResolvedValue(false);
    await refreshAiAvailability();
    expect(getAiAvailability().status).toBe("nokey");
    expect(getAiAvailability().model).toBe("gpt-4o-mini"); // 胶囊 title 要能告知是哪个模型缺密钥
  });

  it("启用 + 有密钥 → on（带本周用量）", async () => {
    api.aiGetConfig.mockResolvedValue(cfg());
    api.aiHasKey.mockResolvedValue(true);
    await refreshAiAvailability();
    expect(getAiAvailability().status).toBe("on");
    expect(getAiAvailability().weekCalls).toBe(12);
  });

  it("启用 + 本地厂商（needsKey=false）无密钥 → on", async () => {
    api.aiGetConfig.mockResolvedValue(cfg({ provider: "ollama", model: "qwen2.5" }));
    api.aiHasKey.mockResolvedValue(false);
    await refreshAiAvailability();
    expect(getAiAvailability().status).toBe("on");
  });

  it("模型名为空时给「已配置」占位", async () => {
    api.aiGetConfig.mockResolvedValue(cfg({ model: "   " }));
    api.aiHasKey.mockResolvedValue(true);
    await refreshAiAvailability();
    expect(getAiAvailability().model).toBe("已配置");
  });

  it("首次判定失败 → off（不停在 loading 转圈）", async () => {
    api.aiGetConfig.mockRejectedValue(new Error("ipc 挂了"));
    api.aiHasKey.mockResolvedValue(true);
    await refreshAiAvailability();
    expect(getAiAvailability().status).toBe("off");
  });

  it("off / nokey 不拉用量（白花的 IPC）", async () => {
    api.aiGetConfig.mockResolvedValue(cfg({ enabled: false }));
    api.aiHasKey.mockResolvedValue(true);
    await refreshAiAvailability();
    api.aiGetConfig.mockResolvedValue(cfg());
    api.aiHasKey.mockResolvedValue(false);
    await refreshAiAvailability();
    expect(api.aiGetUsageStats).not.toHaveBeenCalled();
  });
});

describe("收口：只有一处判定、一份缓存", () => {
  it("nokey 时变换门控也不可用（不会摆出必然失败的 AI 动作）", async () => {
    api.aiGetConfig.mockResolvedValue(cfg());
    api.aiHasKey.mockResolvedValue(false);
    await refreshAiAvailability();
    expect(getAiAvailability().status).toBe("nokey");
    expect(isAiAvailable()).toBe(false);
  });

  it("on 时变换门控可用", async () => {
    api.aiGetConfig.mockResolvedValue(cfg());
    api.aiHasKey.mockResolvedValue(true);
    await refreshAiAvailability();
    expect(isAiAvailable()).toBe(true);
  });

  it("setAiAvailable（测试/初始化用）写的是同一份共享状态", () => {
    setAiAvailable(true);
    expect(getAiAvailability().status).toBe("on");
    expect(isAiAvailable()).toBe(true);
    setAiAvailable(false);
    expect(getAiAvailability().status).toBe("off");
    expect(isAiAvailable()).toBe(false);
  });
});
