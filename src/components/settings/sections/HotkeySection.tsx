import type { AppConfig } from "@/stores/appStore";
import { useToast } from "@/components/Toast";
import { logger } from "@/lib/logger";
import { globalHotkeysTaken } from "@/lib/globalHotkeys";
import { SettingTile } from "../ToggleRow";
import { HotkeyRecorder } from "../HotkeyRecorder";
import { RecHotkeyRows } from "./RecHotkeyRows";
import styles from "../../Settings.module.css";

interface HotkeySectionProps {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<boolean>;
}

// 🔴 必须返回片段，原因同 StatsSection。
// 行为选项归各功能分类，本节统一管理全局快捷键。
export function HotkeySection({ config, updateAndSave }: HotkeySectionProps) {
  const { toast } = useToast();
  return (
    <>
      {/* ── 快捷键 ── */}
      <div className={styles.sSection}>快捷键</div>
      <div className={styles.sRow}>
        <SettingTile hue="system">⌨</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>唤出窗口</div>
          <div className={`${styles.sRowDesc}`}>全局快捷键，在任何位置唤出</div>
        </div>
        <HotkeyRecorder value={config.hotkey} allowClear taken={globalHotkeysTaken(config, "hotkey")} onChange={async (v) => {
          const oldVal = config.hotkey;
          if (!await updateAndSave({ hotkey: v })) return;
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("reregister_hotkeys");
            toast("快捷键已更新", "success");
          } catch (e) {
            const restored = await updateAndSave({ hotkey: oldVal });
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn("热键设置失败", e);
            toast(`快捷键设置失败：${msg}。${restored ? "已恢复原值" : "原值未能保存，请重试"}`, "error");
          }
        }} />
      </div>
      <div className={styles.sRow}>
        <SettingTile hue="paste">📋</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>依次粘贴</div>
          <div className={`${styles.sRowDesc}`}>按顺序逐条粘贴剪贴板</div>
        </div>
        <HotkeyRecorder value={config.sequential_hotkey ?? ""} allowClear taken={globalHotkeysTaken(config, "sequential_hotkey")} onChange={async (v) => {
          const oldVal = config.sequential_hotkey ?? "";
          if (!await updateAndSave({ sequential_hotkey: v })) return;
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("reregister_hotkeys");
            toast("快捷键已更新", "success");
          } catch (e) {
            const restored = await updateAndSave({ sequential_hotkey: oldVal });
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn("热键设置失败", e);
            toast(`快捷键设置失败：${msg}。${restored ? "已恢复原值" : "原值未能保存，请重试"}`, "error");
          }
        }} />
      </div>
      <div className={styles.sRow}>
        <SettingTile hue="paste">📚</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>收集模式开关</div>
          <div className={`${styles.sRowDesc}`}>进入/退出剪贴板收集模式（栈模式）</div>
        </div>
        <HotkeyRecorder value={config.stack_toggle_hotkey ?? ""} allowClear taken={globalHotkeysTaken(config, "stack_toggle_hotkey")} onChange={async (v) => {
          const oldVal = config.stack_toggle_hotkey ?? "";
          if (!await updateAndSave({ stack_toggle_hotkey: v })) return;
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("reregister_hotkeys");
            toast("快捷键已更新", "success");
          } catch (e) {
            const restored = await updateAndSave({ stack_toggle_hotkey: oldVal });
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn("热键设置失败", e);
            toast(`快捷键设置失败：${msg}。${restored ? "已恢复原值" : "原值未能保存，请重试"}`, "error");
          }
        }} />
      </div>
      <div className={styles.sRow}>
        <SettingTile hue="paste">📤</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>粘贴最近收集</div>
          <div className={`${styles.sRowDesc}`}>粘贴最近收集的内容并移出收集列表</div>
        </div>
        <HotkeyRecorder value={config.stack_paste_hotkey ?? ""} allowClear taken={globalHotkeysTaken(config, "stack_paste_hotkey")} onChange={async (v) => {
          const oldVal = config.stack_paste_hotkey ?? "";
          if (!await updateAndSave({ stack_paste_hotkey: v })) return;
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("reregister_hotkeys");
            toast("快捷键已更新", "success");
          } catch (e) {
            const restored = await updateAndSave({ stack_paste_hotkey: oldVal });
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn("热键设置失败", e);
            toast(`快捷键设置失败：${msg}。${restored ? "已恢复原值" : "原值未能保存，请重试"}`, "error");
          }
        }} />
      </div>
      <div className={styles.sRow}>
        <SettingTile hue="paste">⚡</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>快捷粘贴</div>
          <div className={`${styles.sRowDesc}`}>在光标处弹出面板，选择内容后粘贴</div>
        </div>
        <HotkeyRecorder value={config.quick_paste_hotkey ?? ""} allowClear taken={globalHotkeysTaken(config, "quick_paste_hotkey")} onChange={async (v) => {
          const oldVal = config.quick_paste_hotkey ?? "";
          if (!await updateAndSave({ quick_paste_hotkey: v })) return;
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("reregister_hotkeys");
            toast("快捷键已更新", "success");
          } catch (e) {
            const restored = await updateAndSave({ quick_paste_hotkey: oldVal });
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn("热键设置失败", e);
            toast(`快捷键设置失败：${msg}。${restored ? "已恢复原值" : "原值未能保存，请重试"}`, "error");
          }
        }} />
      </div>
      <div className={styles.sRow}>
        <SettingTile hue="capture">📸</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>截图标注</div>
          <div className={`${styles.sRowDesc}`}>全局热键唤出截图：选区 → 标注 → OCR 识别 → 复制/保存/AI 处理</div>
        </div>
        <HotkeyRecorder value={config.screenshot_hotkey ?? ""} allowClear taken={globalHotkeysTaken(config, "screenshot_hotkey")} onChange={async (v) => {
          const oldVal = config.screenshot_hotkey ?? "";
          if (!await updateAndSave({ screenshot_hotkey: v })) return;
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("reregister_hotkeys");
            toast("快捷键已更新", "success");
          } catch (e) {
            const restored = await updateAndSave({ screenshot_hotkey: oldVal });
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn("热键设置失败", e);
            toast(`快捷键设置失败：${msg}。${restored ? "已恢复原值" : "原值未能保存，请重试"}`, "error");
          }
        }} />
      </div>
      <div className={styles.sRow}>
        <SettingTile hue="editor">📅</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>今日速记</div>
          <div className={`${styles.sRowDesc}`}>把剪贴板当前内容追加到「今天」那条笔记，不用打开窗口</div>
        </div>
        <HotkeyRecorder value={config.daily_note_hotkey ?? ""} allowClear taken={globalHotkeysTaken(config, "daily_note_hotkey")} onChange={async (v) => {
          const oldVal = config.daily_note_hotkey ?? "";
          if (!await updateAndSave({ daily_note_hotkey: v })) return;
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("reregister_hotkeys");
            toast("快捷键已更新", "success");
          } catch (e) {
            const restored = await updateAndSave({ daily_note_hotkey: oldVal });
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn("热键设置失败", e);
            toast(`快捷键设置失败：${msg}。${restored ? "已恢复原值" : "原值未能保存，请重试"}`, "error");
          }
        }} />
      </div>
      <div className={styles.sRow}>
        <SettingTile hue="editor">🏝️</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>待办岛唤起</div>
          <div className={`${styles.sRowDesc}`}>唤出屏幕顶部的待办胶囊并直进「记一条」；岛展开时按 = 收回</div>
        </div>
        <HotkeyRecorder value={config.todo_island_hotkey ?? ""} allowClear taken={globalHotkeysTaken(config, "todo_island_hotkey")} onChange={async (v) => {
          const oldVal = config.todo_island_hotkey ?? "";
          if (!await updateAndSave({ todo_island_hotkey: v })) return;
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("reregister_hotkeys");
            toast("快捷键已更新", "success");
          } catch (e) {
            const restored = await updateAndSave({ todo_island_hotkey: oldVal });
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn("热键设置失败", e);
            toast(`快捷键设置失败：${msg}。${restored ? "已恢复原值" : "原值未能保存，请重试"}`, "error");
          }
        }} />
      </div>
      <RecHotkeyRows config={config} updateAndSave={updateAndSave} />
    </>
  );
}
