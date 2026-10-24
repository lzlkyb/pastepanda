/**
 * saveHotkey —— 热键设置保存的**唯一路径**（批次② · 规则 11.1 收口）。
 *
 * 改前 `HotkeySection.tsx` 里 8 个热键录制器各带一份完全相同的 onChange
 * （保存 → reregister → 成功弹「快捷键已更新」/ 失败回滚 + 弹错），
 * `RecHotkeyRows.tsx` 又是第 9–12 份（成功静默版）。连着改几个热键就连环
 * 弹几条成功提示——批次②统一为：
 *
 * - **成功静默**：录制器控件本身显示新键位，反馈与触发在同一可见性域（规则 15.1）。
 * - **失败必弹**：回滚原值 + `toastActionFailed`（与 RecHotkeyRows 原行为一致）。
 */
import type { AppConfig } from "@/stores/appStore";
import { toastActionFailed } from "@/lib/utils";

export async function saveHotkey(
  config: AppConfig,
  updateAndSave: (partial: Record<string, unknown>) => Promise<boolean>,
  key: keyof AppConfig,
  value: string,
  label: string,
): Promise<void> {
  const oldVal = String(config[key] ?? "");
  if (!await updateAndSave({ [key]: value })) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("reregister_hotkeys");
    // 成功不弹 toast——控件已显示新键位（见文件头注释）。
  } catch (e) {
    const restored = await updateAndSave({ [key]: oldVal });
    toastActionFailed(`${label}（${restored ? "已恢复原值" : "原值未能保存，请重试"}）`, e);
  }
}
