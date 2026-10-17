import { afterEach, expect, it, vi } from "vitest";
import { cachedUserChains, chainStepTransforms, invalidateUserChains, isChainAvailable, loadUserChains, runChain } from "@/lib/chains/registry";
import { chainList } from "@/lib/api/chains";
import { registerTransform, unregisterTransform } from "@/lib/transforms/registry";
import { setAiAvailable } from "@/lib/transforms/aiTransforms";
vi.mock("@/lib/api/chains", () => ({ chainList: vi.fn() }));
afterEach(() => { invalidateUserChains(); unregisterTransform("gated-ai"); setAiAvailable(false); vi.clearAllMocks(); });
it("registered AI actions remain unavailable when AI is switched off", async () => {
  const run = vi.fn(() => ({ ok: true, output: "must not run" }));
  registerTransform({ id: "gated-ai", label: "AI", group: "ai", remote: true, detect: () => 1, run });
  setAiAvailable(false);
  const chain = { id: "gated", name: "gated", description: "", steps: [{ transformId: "gated-ai", risk: "network" as const }] };
  expect(isChainAvailable(chain)).toBe(false);
  expect(chainStepTransforms().some(t => t.id === "gated-ai")).toBe(false);
  const confirm = vi.fn(async () => true);
  expect((await runChain(chain, "text", {}, confirm)).ok).toBe(false);
  expect(confirm).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});
it("an invalidated old fetch cannot overwrite the newer cache", async () => {
  let finish!: (value: []) => void;
  vi.mocked(chainList).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const old = loadUserChains(true);
  invalidateUserChains();
  vi.mocked(chainList).mockResolvedValueOnce([{ id: "fresh", name: "fresh", description: "", steps: [{ transformId: "strip", risk: "local" }] }]);
  await loadUserChains(true);
  finish([]); await old;
  expect(cachedUserChains().map(c => c.id)).toContain("fresh");
});
it("strict UI loading distinguishes errors from an empty saved list", async () => {
  vi.mocked(chainList).mockRejectedValueOnce(new Error("db busy"));
  await expect(loadUserChains(true, true)).rejects.toThrow("db busy");
});
