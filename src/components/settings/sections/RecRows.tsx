import { ToggleRow, SettingTile } from "../ToggleRow";
import type { AppConfig } from "@/stores/appStore";
import { REC_QUALITIES, recQualityOf, type RecQualityKey } from "@/lib/recQuality";
import styles from "../../Settings.module.css";

interface RecRowsProps {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<boolean>;
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
  return <div data-settings-parent="截图与录屏" className={styles.sSection}>屏幕录制</div>;
}

export type { RecQualityKey };
