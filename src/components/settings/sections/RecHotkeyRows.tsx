import { invoke } from "@tauri-apps/api/core";
import type { AppConfig } from "@/stores/appStore";
import { globalHotkeysTaken } from "@/lib/globalHotkeys";
import { toastActionFailed } from "@/lib/utils";
import { HotkeyRecorder } from "../HotkeyRecorder";
import { SettingTile } from "../ToggleRow";
import styles from "../../Settings.module.css";

async function reregisterQuiet(): Promise<void> {
  await invoke("reregister_hotkeys");
}

/** 只移动录屏快捷键行，保留冲突检查、先保存再注册以及失败回滚。 */
export function RecHotkeyRows({ config, updateAndSave }: {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<boolean>;
}) {
  return (
    <>
      <div data-settings-parent="快捷键" className={styles.sSection}>录屏快捷键</div>
      <div className={styles.sRow}>
        <SettingTile hue="capture">⌨</SettingTile>
        <div className={styles.sRowBody}>
          <div className={styles.sRowLabel}>录屏热键</div>
          <div className={styles.sRowDesc}>主窗口关闭时也生效；录制中再按一次 = 停止</div>
        </div>
        <HotkeyRecorder
          value={config.rec_hotkey}
          allowClear
          taken={globalHotkeysTaken(config, "rec_hotkey")}
          onChange={(v) => {
            const oldVal = config.rec_hotkey;
            void (async () => {
              if (!await updateAndSave({ rec_hotkey: v })) return;
              try {
                await reregisterQuiet();
              } catch (e) {
                const restored = await updateAndSave({ rec_hotkey: oldVal });
                toastActionFailed(`录屏快捷键设置（${restored ? "已恢复原值" : "原值未能保存，请重试"}）`, e);
              }
            })();
          }}
        />
      </div>
      <div className={styles.sRow}>
        <SettingTile hue="capture">⏸</SettingTile>
        <div className={styles.sRowBody}>
          <div className={styles.sRowLabel}>录制中：暂停 / 继续</div>
          <div className={styles.sRowDesc}>仅录制中生效，其余时间按键无动作</div>
        </div>
        <HotkeyRecorder
          value={config.rec_pause_hotkey}
          allowClear
          taken={globalHotkeysTaken(config, "rec_pause_hotkey")}
          onChange={(v) => {
            const oldVal = config.rec_pause_hotkey;
            void (async () => {
              if (!await updateAndSave({ rec_pause_hotkey: v })) return;
              try {
                await reregisterQuiet();
              } catch (e) {
                const restored = await updateAndSave({ rec_pause_hotkey: oldVal });
                toastActionFailed(`暂停快捷键设置（${restored ? "已恢复原值" : "原值未能保存，请重试"}）`, e);
              }
            })();
          }}
        />
      </div>
      <div className={styles.sRow}>
        <SettingTile hue="capture">⏹</SettingTile>
        <div className={styles.sRowBody}>
          <div className={styles.sRowLabel}>录制中：停止并保存</div>
          <div className={styles.sRowDesc}>留空 = 不启用；丢弃仍走控制条两段确认，热键不误毁</div>
        </div>
        <HotkeyRecorder
          value={config.rec_stop_hotkey}
          allowClear
          taken={globalHotkeysTaken(config, "rec_stop_hotkey")}
          onChange={(v) => {
            const oldVal = config.rec_stop_hotkey;
            void (async () => {
              if (!await updateAndSave({ rec_stop_hotkey: v })) return;
              try {
                await reregisterQuiet();
              } catch (e) {
                const restored = await updateAndSave({ rec_stop_hotkey: oldVal });
                toastActionFailed(`停止快捷键设置（${restored ? "已恢复原值" : "原值未能保存，请重试"}）`, e);
              }
            })();
          }}
        />
      </div>
      <div className={styles.sRow}>
        <SettingTile hue="capture">🔖</SettingTile>
        <div className={styles.sRowBody}>
          <div className={styles.sRowLabel}>录制中：标记时刻</div>
          <div className={styles.sRowDesc}>在事件文件里打一个标记点（五期时间线刻度的素材）；关闭事件记录后无效果</div>
        </div>
        <HotkeyRecorder
          value={config.rec_mark_hotkey}
          allowClear
          taken={globalHotkeysTaken(config, "rec_mark_hotkey")}
          onChange={(v) => {
            const oldVal = config.rec_mark_hotkey;
            void (async () => {
              if (!await updateAndSave({ rec_mark_hotkey: v })) return;
              try {
                await reregisterQuiet();
              } catch (e) {
                const restored = await updateAndSave({ rec_mark_hotkey: oldVal });
                toastActionFailed(`标记时刻快捷键设置（${restored ? "已恢复原值" : "原值未能保存，请重试"}）`, e);
              }
            })();
          }}
        />
      </div>
    </>
  );
}
