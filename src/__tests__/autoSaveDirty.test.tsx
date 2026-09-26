/**
 * 自动保存的**脏标记**回归钉子。
 *
 * 钉的是 2026-09-26 行为审查里实测确认的坏路径：
 * 写盘是 `await` 的，返回后无条件 `setIsDirty(false)` —— 若这期间用户又打了字，
 * **未保存的新文本**就被标成「已保存」。
 *
 * 为什么这条值得单独钉：它不表现为界面错乱，而是表现为**丢稿**。
 * 关闭守卫按 `isDirty` 决定要不要拦，被错置成 false 就一路直接关、不提示，
 * 从写盘返回到下一轮防抖到期约 1 秒，全在这条窗口里。
 *
 * `useAutoSaveFile` 是纯 hook（值 + setter 进出，无组件依赖），
 * 所以这里用真实 state 包一个探针，而不是 mock 状态机。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAutoSaveFile } from "@/components/editors/fullscreen/useAutoSaveFile";
import type { FileWatch } from "@/components/editors/useFileWatch";

/** 方法身份必须恒定（useAutoSaveFile 把它们放进了依赖数组） */
const FAKE_WATCH = {
  checkNow: async () => false,
  markSynced: async () => {},
  externalChanged: false,
} as unknown as FileWatch;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function AutoSaveHost() {
  const [text, setText] = useState("v1");
  const [baseline, setBaseline] = useState("v0");
  const [isDirty, setIsDirty] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [autoSaveError, setAutoSaveError] = useState(false);

  useAutoSaveFile({
    enabled: true,
    text,
    baseline,
    effectiveSourceId: null,
    currentFilePath: "D:\\docs\\x.md",
    fileWatch: FAKE_WATCH,
    setIsSaving,
    setInitialContent: setBaseline,
    setIsDirty,
    setAutoSaveError,
  });

  return (
    <>
      <div data-testid="state">
        {JSON.stringify({ text, baseline, isDirty, isSaving, autoSaveError })}
      </div>
      <button onClick={() => setText("v2")}>再改一笔</button>
    </>
  );
}

const readState = () =>
  JSON.parse(document.querySelector('[data-testid="state"]')!.textContent!) as {
    text: string;
    baseline: string;
    isDirty: boolean;
    isSaving: boolean;
  };

beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("钉子 C：写盘期间又改动，脏标记必须如实", () => {
  it("写盘返回后 text 已不等于新基线 ⇒ isDirty 必须仍为 true", async () => {
    const gate = deferred<void>();
    vi.mocked(invoke).mockImplementation(async (...args: unknown[]) => {
      if (args[0] === "write_text_file_full") return gate.promise; // 悬挂，模拟写盘耗时
      return undefined;
    });

    render(<AutoSaveHost />);

    // 等过 1s 防抖：写盘发起并悬挂
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1200));
    });
    expect(readState().isSaving).toBe(true);

    // 悬挂期间用户又改了一笔
    await act(async () => {
      fireEvent.click(screen.getByText("再改一笔"));
    });

    // 放行首次写盘（写下去的是 v1）
    await act(async () => {
      gate.resolve();
      await new Promise((r) => setTimeout(r, 80));
    });

    const s = readState();
    expect(s.text).toBe("v2");
    expect(s.baseline).toBe("v1");
    // 回归点：改前这里是 false —— 守卫会据此认定「没东西要存」而直接关窗
    expect(s.isDirty).toBe(true);
  }, 20000);
});
