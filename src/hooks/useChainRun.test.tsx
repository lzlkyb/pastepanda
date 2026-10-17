import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useChainRun } from "./useChainRun";
import { registerTransform, unregisterTransform } from "@/lib/transforms/registry";
import { setAiAvailable } from "@/lib/transforms/aiTransforms";
import type { Chain } from "@/lib/chains/types";
const chain: Chain = { id: "test", name: "test", description: "", steps: [{ transformId: "hook-step", risk: "local" }] };
afterEach(() => { cleanup(); unregisterTransform("hook-step"); setAiAvailable(false); });
it("an old run cannot overwrite a reopened input", async () => {
  let finish!: (r: { ok: true; output: string }) => void;
  registerTransform({ id: "hook-step", label: "step", group: "text", detect: () => 1,
    run: text => text === "old" ? new Promise(resolve => { finish = resolve; }) : { ok: true, output: "new result" } });
  const hook = renderHook(({ text }) => useChainRun(chain, text), { initialProps: { text: "old" } });
  let old!: Promise<void>;
  act(() => { old = hook.result.current.run(); });
  hook.rerender({ text: "new" });
  await act(async () => { await hook.result.current.run(); });
  await act(async () => { finish({ ok: true, output: "old result" }); await old; });
  expect(hook.result.current.result?.final).toBe("new result");
});
it("stopping while waiting for AI confirmation releases the promise without sending", async () => {
  setAiAvailable(true);
  let calls = 0;
  registerTransform({ id: "hook-step", label: "step", group: "ai", remote: true, detect: () => 1,
    run: () => { calls++; return { ok: true, output: "must not run" }; } });
  const hook = renderHook(() => useChainRun(chain, "input"));
  let task!: Promise<void>;
  act(() => { task = hook.result.current.run(); });
  await waitFor(() => expect(hook.result.current.pending?.input).toBe("input"));
  await act(async () => { hook.result.current.stop(); await task; });
  expect(calls).toBe(0);
  expect(hook.result.current.running).toBe(false);
  expect(hook.result.current.result?.cancelled).toBe(true);
});
