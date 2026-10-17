import { afterEach, expect, it, vi } from "vitest";
import { runChain } from "@/lib/chains/registry";
import { registerTransform, unregisterTransform } from "@/lib/transforms/registry";
import type { Chain, ChainRunResult } from "@/lib/chains/types";
import "@/lib/transforms";

type Control = { signal?: AbortSignal; onProgress?: (p: { index: number; state: string; stages: unknown[] }) => void };
const controlledRun = runChain as unknown as (chain: Chain, text: string, opts: object, confirm: undefined, control: Control) => Promise<ChainRunResult & { cancelled?: boolean }>;
afterEach(() => { unregisterTransform("ux-delayed"); unregisterTransform("ux-next"); });
it("reports a running step before it resolves and stops before starting the next", async () => {
  let finish!: (r: { ok: true; output: string }) => void;
  const next = vi.fn(() => ({ ok: true, output: "next" }));
  registerTransform({ id: "ux-delayed", label: "延迟", group: "text", detect: () => 1, run: () => new Promise(resolve => { finish = resolve; }) });
  registerTransform({ id: "ux-next", label: "下一步", group: "text", detect: () => 1, run: next });
  const controller = new AbortController();
  const progress = vi.fn();
  const result = controlledRun({ id: "x", name: "x", description: "", steps: [{ transformId: "ux-delayed", risk: "local" }, { transformId: "ux-next", risk: "local" }] }, "original", {}, undefined, { signal: controller.signal, onProgress: progress });
  const before = progress.mock.calls.map(([p]) => p.state);
  controller.abort();
  finish({ ok: true, output: "first" });
  const done = await result;
  expect(before).toContain("running");
  expect(next).not.toHaveBeenCalled();
  expect(done.cancelled).toBe(true);
  expect(done.final).toBe("first");
});
it("a thrown step preserves the preceding result as a failed stage", async () => {
  registerTransform({ id: "ux-delayed", label: "失败步骤", group: "text", detect: () => 1, run: () => { throw new Error("service unavailable"); } });
  const result = await runChain({ id: "x", name: "x", description: "", steps: [{ transformId: "strip", risk: "local" }, { transformId: "ux-delayed", risk: "local" }] }, " original ").catch(() => null);
  expect(result?.ok).toBe(false);
  expect(result?.final).toBe("original");
  expect(result?.stages[1].error).toContain("service unavailable");
});
