import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SequenceDiscover } from "./SequenceDiscover";
import { registerTransform, unregisterTransform } from "@/lib/transforms/registry";
import { setAiAvailable } from "@/lib/transforms/aiTransforms";

vi.mock("@/lib/api/sequence", () => ({ sequenceSuggest: vi.fn(async () => [{ actions: ["sequence-local", "sequence-ai"], count: 4, lastUsed: "2026-10-17" }]) }));
vi.mock("@/lib/api/chains", () => ({ chainList: vi.fn(async () => []), chainSave: vi.fn() }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/ChainEditor", () => ({ MAX_CHAIN_NAME_CHARS: 24 }));

afterEach(() => { cleanup(); unregisterTransform("sequence-local"); unregisterTransform("sequence-ai"); setAiAvailable(false); });
it("hides an already loaded AI sequence immediately when AI is disabled", async () => {
  registerTransform({ id: "sequence-local", label: "本地清理", group: "text", detect: () => 1, run: text => ({ ok: true, output: text }) });
  registerTransform({ id: "sequence-ai", label: "AI 汇总", group: "ai", remote: true, detect: () => 1, run: text => ({ ok: true, output: text }) });
  setAiAvailable(true);
  await act(async () => { render(<SequenceDiscover open />); });
  expect(screen.getByText("本地清理 → AI 汇总")).toBeTruthy();
  act(() => { setAiAvailable(false); });
  expect(screen.queryByText("本地清理 → AI 汇总")).toBeNull();
});
