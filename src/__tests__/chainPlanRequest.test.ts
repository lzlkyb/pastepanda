import { afterEach, expect, it, vi } from "vitest";
import { aiPlanChain } from "@/lib/api/ai";
import { requestPlannedChain } from "@/lib/chains/planRequest";
import { setAiAvailable } from "@/lib/transforms/aiTransforms";
import { registerTransform, unregisterTransform } from "@/lib/transforms/registry";
vi.mock("@/lib/api/ai", async original => ({ ...await original<typeof import("@/lib/api/ai")>(), aiPlanChain: vi.fn() }));
afterEach(() => { setAiAvailable(false); vi.clearAllMocks(); });
it("passes the user's goal as an explicit field", async () => {
  setAiAvailable(true);
  vi.mocked(aiPlanChain).mockResolvedValue({ status: "ok", content: '{"name":"清理","steps":["strip"]}' } as never);
  const r = await requestPlannedChain("content", false, "只清理空白，不要翻译");
  expect(aiPlanChain).toHaveBeenCalledWith("content", expect.any(Array), false, "只清理空白，不要翻译");
  expect(r.status).toBe("ok");
});
it("AI disabled makes zero planner requests", async () => {
  setAiAvailable(false);
  await expect(requestPlannedChain("content", false, "goal")).rejects.toThrow("未启用");
  expect(aiPlanChain).not.toHaveBeenCalled();
});
it("the bounded planner catalog keeps requested AI and masking operations", async () => {
  setAiAvailable(true);
  const ids = Array.from({ length: 80 }, (_, i) => `catalog-${i}`);
  for (const id of ids) registerTransform({ id, label: id, group: "text", detect: () => 1, run: () => ({ ok: true, output: "" }) });
  registerTransform({ id: "ai-summarize", label: "总结", group: "ai", remote: true, detect: () => 1, run: () => ({ ok: true, output: "" }) });
  vi.mocked(aiPlanChain).mockResolvedValue({ status: "ok", content: '{"steps":["strip"]}' } as never);
  try {
    await requestPlannedChain("content", false, "先脱敏，再总结要点");
    const actions = vi.mocked(aiPlanChain).mock.calls[0][1];
    expect(actions.length).toBeLessThanOrEqual(60);
    expect(actions.slice(0, 60).some(t => t.id === "ai-summarize")).toBe(true);
    expect(actions.slice(0, 60).some(t => t.id === "mask-sensitive")).toBe(true);
  } finally { for (const id of [...ids, "ai-summarize"]) unregisterTransform(id); }
});
