import type { AppConfig } from "@/stores/appStore";
import { globalHotkeysTaken } from "@/lib/globalHotkeys";
import { saveHotkey } from "@/lib/hotkeySave";
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
//
// 批次②（2026-10-24）：8 个录制器的 onChange 原是 8 份逐字拷贝（连改几个
// 热键就连环弹几条「快捷键已更新」）。收口到 `saveHotkey`：成功静默
// （控件本身显示新键位即反馈），失败回滚 + 弹错。
export function HotkeySection({ config, updateAndSave }: HotkeySectionProps) {
  return (
    <>
      {/* ── 快捷键 ── */}
      <div className={styles.sSection}>快捷键</div>
      <div className={styles.sRow}>
        <SettingTile hue="system">⌨</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={styles.sRowLabel}>唤出窗口</div>
          <div className={styles.sRowDesc}>全局快捷键，在任何位置唤出</div>
        </div>
        <HotkeyRecorder value={config.hotkey} allowClear taken={globalHotkeysTaken(config, "hotkey")} onChange={(v) => void saveHotkey(config, updateAndSave, "hotkey", v, "快捷键设置")} />
      </div>
      <div className={styles.sRow}>
        <SettingTile hue="paste">📋</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={styles.sRowLabel}>依次粘贴</div>
          <div className={styles.sRowDesc}>按顺序逐条粘贴剪贴板</div>
        </div>
        <HotkeyRecorder value={config.sequential_hotkey ?? ""} allowClear taken={globalHotkeysTaken(config, "sequential_hotkey")} onChange={(v) => void saveHotkey(config, updateAndSave, "sequential_hotkey", v, "依次粘贴快捷键设置")} />
      </div>
      <div className={styles.sRow}>
        <SettingTile hue="paste">📚</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={styles.sRowLabel}>收集模式开关</div>
          <div className={styles.sRowDesc}>进入/退出剪贴板收集模式（栈模式）</div>
        </div>
        <HotkeyRecorder value={config.stack_toggle_hotkey ?? ""} allowClear taken={globalHotkeysTaken(config, "stack_toggle_hotkey")} onChange={(v) => void saveHotkey(config, updateAndSave, "stack_toggle_hotkey", v, "收集模式快捷键设置")} />
      </div>
      <div className={styles.sRow}>
        <SettingTile hue="paste">📤</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={styles.sRowLabel}>粘贴最近收集</div>
          <div className={styles.sRowDesc}>粘贴最近收集的内容并移出收集列表</div>
        </div>
        <HotkeyRecorder value={config.stack_paste_hotkey ?? ""} allowClear taken={globalHotkeysTaken(config, "stack_paste_hotkey")} onChange={(v) => void saveHotkey(config, updateAndSave, "stack_paste_hotkey", v, "粘贴收集快捷键设置")} />
      </div>
      <div className={styles.sRow}>
        <SettingTile hue="paste">⚡</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={styles.sRowLabel}>快捷粘贴</div>
          <div className={styles.sRowDesc}>在光标处弹出面板，选择内容后粘贴</div>
        </div>
        <HotkeyRecorder value={config.quick_paste_hotkey ?? ""} allowClear taken={globalHotkeysTaken(config, "quick_paste_hotkey")} onChange={(v) => void saveHotkey(config, updateAndSave, "quick_paste_hotkey", v, "快捷粘贴热键设置")} />
      </div>
      <div className={styles.sRow}>
        <SettingTile hue="capture">📸</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={styles.sRowLabel}>截图标注</div>
          <div className={styles.sRowDesc}>全局热键唤出截图：选区 → 标注 → OCR 识别 → 复制/保存/AI 处理</div>
        </div>
        <HotkeyRecorder value={config.screenshot_hotkey ?? ""} allowClear taken={globalHotkeysTaken(config, "screenshot_hotkey")} onChange={(v) => void saveHotkey(config, updateAndSave, "screenshot_hotkey", v, "截图快捷键设置")} />
      </div>
      <div className={styles.sRow}>
        <SettingTile hue="editor">📅</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={styles.sRowLabel}>今日速记</div>
          <div className={styles.sRowDesc}>把剪贴板当前内容追加到「今天」那条笔记，不用打开窗口</div>
        </div>
        <HotkeyRecorder value={config.daily_note_hotkey ?? ""} allowClear taken={globalHotkeysTaken(config, "daily_note_hotkey")} onChange={(v) => void saveHotkey(config, updateAndSave, "daily_note_hotkey", v, "今日速记快捷键设置")} />
      </div>
      <div className={styles.sRow}>
        <SettingTile hue="editor">🏝️</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={styles.sRowLabel}>待办岛唤起</div>
          <div className={styles.sRowDesc}>唤出屏幕顶部的待办胶囊并直进「记一条」；岛展开时按 = 收回</div>
        </div>
        <HotkeyRecorder value={config.todo_island_hotkey ?? ""} allowClear taken={globalHotkeysTaken(config, "todo_island_hotkey")} onChange={(v) => void saveHotkey(config, updateAndSave, "todo_island_hotkey", v, "待办岛快捷键设置")} />
      </div>
      <RecHotkeyRows config={config} updateAndSave={updateAndSave} />
    </>
  );
}
