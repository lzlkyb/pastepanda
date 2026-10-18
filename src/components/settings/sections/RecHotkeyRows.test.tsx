import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_CONFIG } from "@/stores/appStore";
import { toastActionFailed } from "@/lib/utils";
import { RecHotkeyRows } from "./RecHotkeyRows";
import styles from "../../Settings.module.css";

vi.mock("../HotkeyRecorder", () => ({ HotkeyRecorder: ({ onChange }: { onChange: (v: string) => void }) =>
  <button onClick={() => onChange("ctrl+alt+f12")}>录制</button>,
}));
vi.mock("@/lib/utils", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/utils")>(), toastActionFailed: vi.fn(),
}));

const fields = [
  ["录屏热键", "rec_hotkey"], ["录制中：暂停 / 继续", "rec_pause_hotkey"],
  ["录制中：停止并保存", "rec_stop_hotkey"], ["录制中：标记时刻", "rec_mark_hotkey"],
] as const;
beforeEach(() => { vi.mocked(invoke).mockReset().mockResolvedValue(undefined); vi.mocked(toastActionFailed).mockClear(); });
afterEach(cleanup);

async function change(label: string, save: (p: Record<string, unknown>) => Promise<boolean>) {
  const { getByText } = render(<RecHotkeyRows config={DEFAULT_CONFIG} updateAndSave={save} />);
  const row = getByText(label).closest(`.${styles.sRow}`)!;
  await act(async () => { fireEvent.click(row.querySelector("button")!); });
}

it.each(fields)("迁移后 %s 仍先保存再注册", async (label, field) => {
  const save = vi.fn().mockResolvedValue(true);
  await change(label, save);
  expect(save).toHaveBeenCalledWith({ [field]: "ctrl+alt+f12" });
  expect(invoke).toHaveBeenCalledWith("reregister_hotkeys");
  expect(save.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(invoke).mock.invocationCallOrder[0]);
});

it.each(fields)("迁移后 %s 注册失败仍恢复旧值并反馈", async (label, field) => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error("registration denied"));
  const save = vi.fn().mockResolvedValue(true);
  await change(label, save);
  expect(save).toHaveBeenLastCalledWith({ [field]: DEFAULT_CONFIG[field] });
  expect(toastActionFailed).toHaveBeenCalled();
});

it("保存失败不调用注册服务", async () => {
  await change("录屏热键", vi.fn().mockResolvedValue(false));
  expect(invoke).not.toHaveBeenCalled();
});
