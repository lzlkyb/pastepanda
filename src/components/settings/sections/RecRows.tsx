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
              await updateAndSave({ rec_pause_hotkey: v });
              try {
                await reregisterQuiet();
              } catch (e) {
                await updateAndSave({ rec_pause_hotkey: oldVal });
                toastActionFailed("暂停快捷键设置（变更未生效，已恢复原值）", e);
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
              await updateAndSave({ rec_stop_hotkey: v });
              try {
                await reregisterQuiet();
              } catch (e) {
                await updateAndSave({ rec_stop_hotkey: oldVal });
                toastActionFailed("停止快捷键设置（变更未生效，已恢复原值）", e);
              }
            })();
          }}
        />
      </div>
      <ToggleRow
        icon="👁"
        hue="capture"
        label="点击高亮（烧入画面）"
        desc="回放时能看到点击处的青色圆环（~0.4s 扩散）；烧进视频不可后期移除，与事件记录互不依赖"
        value={config.rec_click_highlight}
        onChange={(v) => void updateAndSave({ rec_click_highlight: v })}
      />
      <ToggleRow
        icon="📋"
        hue="capture"
        label="记录点击与按键事件"
        desc="写同名 .events.json（时间基 = 视频时间轴）；只记修饰键组合与命名键，普通字符键不记录"
        value={config.rec_event_sidecar}
        onChange={(v) => void updateAndSave({ rec_event_sidecar: v })}
      />
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
              await updateAndSave({ rec_mark_hotkey: v });
              try {
                await reregisterQuiet();
              } catch (e) {
                await updateAndSave({ rec_mark_hotkey: oldVal });
                toastActionFailed("标记时刻快捷键设置（变更未生效，已恢复原值）", e);
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
        <div className={styles.sRowDesc}>{value || "默认保存到系统视频目录中的 PastePanda 文件夹"}</div>
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
