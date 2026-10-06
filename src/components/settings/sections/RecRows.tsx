/**
 * RecRows — 「截图与栈」分区下的「屏幕录制」设置行（设计稿 §6）。
 *
 * 五行：默认画质档 / 系统声音 / 麦克风 / 热键 / 保存目录。
 * 档位 key 表唯一来源 lib/recQuality（后端 rec/quality.rs 同表）；热键保存后
 * 调 reregister_hotkeys 重注册（失败回滚，同 HotkeySection 惯例）。
 * 🔴 必须返回片段，原因同 ScreenshotRows：容器 children 扁平。
 */
import { invoke } from "@tauri-apps/api/core";
import { HotkeyRecorder } from "../HotkeyRecorder";
import { ToggleRow, SettingTile } from "../ToggleRow";
import type { AppConfig } from "@/stores/appStore";
import type { SettingsData } from "@/hooks/useSettingsData";
import { REC_QUALITIES, recQualityOf, type RecQualityKey } from "@/lib/recQuality";
import { globalHotkeysTaken } from "@/lib/globalHotkeys";
import { toastActionFailed } from "@/lib/utils";
import styles from "../../Settings.module.css";

interface RecRowsProps {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<void>;
  chains: SettingsData["chains"];
}

async function reregisterQuiet(): Promise<void> {
  await invoke("reregister_hotkeys");
}

export function RecRows({ config, updateAndSave }: RecRowsProps) {
  const quality = recQualityOf(config.rec_quality);
  return (
    <>
      <div className={styles.sRow}>
        <SettingTile hue="capture">🎚</SettingTile>
        <div className={styles.sRowBody}>
          <div className={styles.sRowLabel}>默认画质档</div>
          <div className={styles.sRowDesc}>{quality.desc}；开始录制前的确认条可临时切换</div>
        </div>
        <div className={styles.sSegGroup}>
          {REC_QUALITIES.map((q) => (
            <button
              key={q.key}
              type="button"
              className={`${styles.sSegText}${config.rec_quality === q.key ? ` ${styles.sSegActive}` : ""}`}
              aria-pressed={config.rec_quality === q.key}
              onClick={() => void updateAndSave({ rec_quality: q.key })}
              title={q.desc}
            >
              {q.label}
            </button>
          ))}
        </div>
      </div>
      <ToggleRow
        icon="🔊"
        hue="capture"
        label="录制系统声音"
        desc="把电脑正在播放的声音录进视频（默认开）"
        value={config.rec_sys_audio}
        onChange={(v) => void updateAndSave({ rec_sys_audio: v })}
      />
      <ToggleRow
        icon="🎙"
        hue="capture"
        label="录制麦克风"
        desc="把解说人声录进视频（默认关，避免隐私意外）"
        value={config.rec_mic_audio}
        onChange={(v) => void updateAndSave({ rec_mic_audio: v })}
      />
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
              await updateAndSave({ rec_hotkey: v });
              try {
                await reregisterQuiet();
              } catch (e) {
                await updateAndSave({ rec_hotkey: oldVal });
                toastActionFailed("录屏快捷键设置（变更未生效，已恢复原值）", e);
              }
            })();
          }}
        />
      </div>
      <SaveDirRow
        value={config.rec_save_dir}
        onPick={(dir) => void updateAndSave({ rec_save_dir: dir })}
      />
    </>
  );
}

/** 保存目录行：展示当前值 + 更改按钮（plugin-dialog 选目录）。空 = 默认目录。
 *  export 无特殊含义：设置页扁平树守卫按「顶层两空格 return 后必须紧跟片段」扫
 *  Section/Rows 结尾的组件——不给 helper 加 export 的话，它的 return 会被误记到
 *  上一个分区组件（RecRows）头上而误报。 */
export function SaveDirRow({ value, onPick }: { value: string; onPick: (dir: string) => void }) {
  const pick = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const chosen = await open({
      directory: true,
      multiple: false,
      title: "选择录屏保存目录",
      defaultPath: value || undefined,
    });
    if (typeof chosen === "string") onPick(chosen);
  };
  return (
    <div className={styles.sRow}>
      <SettingTile hue="save">📁</SettingTile>
      <div className={styles.sRowBody}>
        <div className={styles.sRowLabel}>保存目录</div>
        <div className={styles.sRowDesc}>{value || "默认「视频\\PastePanda\\」"}</div>
      </div>
      <button type="button" className={styles.sSegText} onClick={() => void pick()}>
        更改
      </button>
    </div>
  );
}

/** 供 CaptureSection 挂小节标题用（保持 children 扁平的口径）。 */
export function RecSectionTitle() {
  return <div className={styles.sSection}>屏幕录制</div>;
}

export type { RecQualityKey };