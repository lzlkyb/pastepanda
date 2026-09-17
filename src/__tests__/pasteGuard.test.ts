/**
 * v6.2 粘贴守卫测试：敏感检测 → 确认条 → 脱敏粘贴 / 原样 / 取消。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { pasteGuarded } from "@/lib/pasteGuard";
import { pasteTextGuarded, pasteRichGuarded } from "@/lib/api/paste";
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

/**
 * 无窗口热键路径（栈/依次/索引/全部粘贴，headless=true）**跳过**敏感确认。
 *
 * 2026-09-16 用户拍板：确认条是主窗口模态框，headless 场景用户在外部应用、
 * 主窗口隐藏——弹框即打断（promise 挂在一个看不见的 resolve 上）。
 * 这组测试钉住「headless 不弹条、原样直粘」；若将来要改回询问式，
 * 必须先解决无焦点应答交互，而不是简单删掉这些断言。
 */
describe("pasteTextGuarded/pasteRichGuarded · headless 跳过敏感确认", () => {
  const SENSITIVE = "key: sk-abcdef1234567890";

  beforeEach(() => {
    useDialogStore.setState({ pasteGuard: null });
    (invoke as ReturnType<typeof vi.fn>).mockReset();
    (invoke as ReturnType<typeof vi.fn>).mockImplementation(
      (cmd: string, _args?: Record<string, unknown>) => {
        if (cmd === "paste_precheck") {
          return Promise.resolve({ targetApp: null, targetCategory: null });
        }
        if (cmd === "paste_text" || cmd === "paste_rich") {
          return Promise.resolve({ success: true });
        }
        return Promise.reject(new Error(`unexpected cmd: ${cmd}`));
      },
    );
  });

  it("pasteTextGuarded(headless=true)：敏感内容不弹条，原样直粘（带 trigger）", async () => {
    const ok = await pasteTextGuarded(SENSITIVE, true);
    expect(ok).toBe(true);
    expect(useDialogStore.getState().pasteGuard).toBeNull();
    expect(invoke).toHaveBeenCalledWith("paste_text", {
      text: SENSITIVE,
      trigger: "headless",
    });
  });

  it("pasteTextGuarded(headless=false)：同样内容仍走确认条（主窗口路径不受影响）", async () => {
    const p = pasteTextGuarded(SENSITIVE);
    await new Promise((r) => setTimeout(r, 10));
    expect(useDialogStore.getState().pasteGuard).not.toBeNull();
    useDialogStore.getState().pasteGuard!.resolve("cancel");
    expect(await p).toBe(false);
  });

  it("pasteRichGuarded(headless=true)：敏感内容不弹条，原样直粘", async () => {
    const ok = await pasteRichGuarded("<p>key: sk-abcdef1234567890</p>", SENSITIVE, true);
    expect(ok).toBe(true);
    expect(useDialogStore.getState().pasteGuard).toBeNull();
    expect(invoke).toHaveBeenCalledWith("paste_rich", {
      htmlFragment: "<p>key: sk-abcdef1234567890</p>",
      plainText: SENSITIVE,
      trigger: "headless",
    });
  });
});
