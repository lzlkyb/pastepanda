/**
 * 变换 / AI 产物粘贴后的「源条目价值信号」。
 *
 * 背景：`VALUE_PRESERVE_SQL` 的判据是
 *   `history_id IS NOT NULL AND outcome = 'pasted'`
 * ——**不要求** `action_id = 'paste'`。而 `useActionEventLog` 从来不传 historyId，
 * 于是经它记的事件 history_id 全是 NULL（实测本机 17 条无一例外），
 * 「这条内容被用过」这个信号在变换 / AI 路径上完全收不到。
 *
 * 后果：把某条内容做正则替换 / 提取要点后粘贴出去，源条目在过期清理看来
 * 仍然「从未被用过」，到期会被当无价值内容清掉。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useActionEventLog } from "@/hooks/useActionEventLog";

function loggedEvents(): Array<Record<string, unknown>> {
  return vi
    .mocked(invoke)
    .mock.calls.filter((c) => c[0] === "action_event_log")
    .map((c) => (c[1] as { event: Record<string, unknown> }).event);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue({ success: true });
});

describe("useActionEventLog", () => {
  it("带上 historyId，源条目的价值信号才收得到", () => {
    const { result } = renderHook(() => useActionEventLog("json", "Code.exe", "hist-42"));
    result.current("json-format", "pasted");

    const ev = loggedEvents()[0];
    expect(ev).toBeDefined();
    expect(ev.actionId).toBe("json-format");
    expect(ev.outcome).toBe("pasted");
    // 这一条是关键：没有它，VALUE_PRESERVE_SQL 的 history_id IS NOT NULL 永远不成立
    expect(ev.historyId).toBe("hist-42");
  });

  it("没有源条目时不传 historyId（不能塞空串——空串不是 NULL，会被当成有效关联）", () => {
    const { result } = renderHook(() => useActionEventLog("text", "Code.exe"));
    result.current("json-format", "copied");

    const ev = loggedEvents()[0];
    expect(ev.historyId).toBeUndefined();
  });
});
