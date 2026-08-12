/**
 * v6.2 粘贴守卫测试：敏感检测 → 确认条 → 脱敏粘贴 / 原样 / 取消。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { pasteGuarded } from "@/lib/pasteGuard";
import { useDialogStore } from "@/stores/dialogStore";

describe("pasteGuarded · 粘贴守卫（v6.2）", () => {
  let lastPasted: string | null;

  beforeEach(() => {
    lastPasted = null;
    useDialogStore.setState({ pasteGuard: null });
    (invoke as ReturnType<typeof vi.fn>).mockReset();
    (invoke as ReturnType<typeof vi.fn>).mockImplementation(
      (cmd: string, args?: { text?: string }) => {
        if (cmd === "paste_precheck") {
          return Promise.resolve({ targetApp: null, targetCategory: null });
        }
        if (cmd === "paste_text") {
          lastPasted = args?.text ?? null;
          return Promise.resolve({ success: true });
        }
        return Promise.reject(new Error(`unexpected cmd: ${cmd}`));
      },
    );
  });

  it("敏感内容（含 API key）→ 弹确认条，选「脱敏」→ 粘贴脱敏版", async () => {
    const p = pasteGuarded("key: sk-abcdef1234567890");
    await new Promise((r) => setTimeout(r, 10));
    const guard = useDialogStore.getState().pasteGuard;
    expect(guard).not.toBeNull();
    expect(guard!.maskPreview).not.toContain("sk-abcdef1234567890");

    guard!.resolve("mask");
    const ok = await p;
    expect(ok).toBe(true);
    expect(lastPasted).not.toContain("sk-abcdef1234567890");
    expect(lastPasted).toContain("***");
  });

  it("敏感内容 → 选「原样」→ 粘贴原文", async () => {
    const p = pasteGuarded("联系 13812345678");
    await new Promise((r) => setTimeout(r, 10));
    const guard = useDialogStore.getState().pasteGuard;
    expect(guard).not.toBeNull();
    guard!.resolve("raw");
    const ok = await p;
    expect(ok).toBe(true);
    expect(lastPasted).toContain("13812345678");
  });

  it("敏感内容 → 选「取消」→ 不粘贴", async () => {
    const p = pasteGuarded("key: sk-abcdef1234567890");
    await new Promise((r) => setTimeout(r, 10));
    const guard = useDialogStore.getState().pasteGuard;
    expect(guard).not.toBeNull();
    guard!.resolve("cancel");
    const ok = await p;
    expect(ok).toBe(false);
    expect(lastPasted).toBeNull();
  });

  it("普通内容不敏感 → 不弹条，直接粘贴", async () => {
    const p = pasteGuarded("今天天气不错");
    const ok = await p;
    expect(ok).toBe(true);
    expect(lastPasted).toBe("今天天气不错");
    expect(useDialogStore.getState().pasteGuard).toBeNull();
  });
});
