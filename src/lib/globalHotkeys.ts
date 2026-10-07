/**
 * lib/globalHotkeys.ts — 全局热键**冲突清单**的唯一口径（规则 11.1）。
 *
 * 任何设置行的 HotkeyRecorder `taken` 都从这里取，禁止再手写内联数组：
 * 2026-10-05 审计发现新增 rec_hotkey 后其余 8 行的清单没跟上（单向收口），
 * 把截图热键改成 Ctrl+Alt+R 不报冲突、注册时静默互抢——这正是「第 7 个
 * 调用点仍会走错」的形态，收成一份清单后新增热键只改这里的 KEYS。
 *
 * 注意：Ctrl+Alt+1..9（索引粘贴前缀）是**区间**不是单键，字符串清单表达不了，
 * 与既有各行行为一致（不在此处理）；`select_all_hotkey` 不是全局热键，不算冲突。
 */
import type { AppConfig } from "@/stores/appStore";

/** 后端 HotkeyConfig 注册的全部全局热键对应的 config 字段（顺序无关）。 */
const GLOBAL_HOTKEY_KEYS = [
  "hotkey",
  "sequential_hotkey",
  "stack_toggle_hotkey",
  "stack_paste_hotkey",
  "quick_paste_hotkey",
  "screenshot_hotkey",
  "daily_note_hotkey",
  "todo_island_hotkey",
  "rec_hotkey",
  "rec_pause_hotkey",
  "rec_stop_hotkey",
] as const satisfies ReadonlyArray<keyof AppConfig>;

export type GlobalHotkeyKey = (typeof GLOBAL_HOTKEY_KEYS)[number];

/** 冲突清单：除 `own`（本行自己的字段，录自己的旧值没有意义）外的全部全局热键。 */
export function globalHotkeysTaken(
  config: Pick<AppConfig, GlobalHotkeyKey>,
  own?: GlobalHotkeyKey,
): string[] {
  return GLOBAL_HOTKEY_KEYS.filter((k) => k !== own).map((k) => config[k] ?? "");
}
