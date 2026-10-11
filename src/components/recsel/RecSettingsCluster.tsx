/**
 * RecSettingsCluster — 录屏选区的「画质 + 声音」⋯ 浮层（甲案 §2，规则 7 拆分）。
 *
 * 五期把四档画质与两个音源从主条收进 ⋯，但**结果必须留在条上当徽标**（规则 15.1：
 * 控件和它的反馈同一个可见性域）。预览条与确认条共用这一套：分支只在这里收口一次。
 */
import { REC_QUALITIES, type RecQualityItem } from "@/lib/recQuality";

/** ⋯ 的结果徽标：档名 + 已开音源图标，都没开就写「无声」。 */
export function recSettingsBadge(qualityLabel: string, sysAudio: boolean, micAudio: boolean): string {
  const icons = `${sysAudio ? "🔊" : ""}${micAudio ? "🎙" : ""}`;
  return `${qualityLabel} · ${icons || "无声"}`;
}

/** 画质 / 音源浮层：作为玻璃条的子元素定位在条上方（条贴近屏顶时翻到下方）。 */
function SettingsPop({
  flipBelow,
  quality,
  onQuality,
  sysAudio,
  micAudio,
  onSys,
  onMic,
}: {
  flipBelow: boolean;
  quality: RecQualityItem;
  onQuality: (q: RecQualityItem) => void;
  sysAudio: boolean;
  micAudio: boolean;
  onSys: () => void;
  onMic: () => void;
}) {
  return (
    <div
      className={`rec-glass rec-pop${flipBelow ? " below" : ""}`}
      id="rec-pop"
      role="group"
      aria-label="画质与声音"
    >
      <div className="rec-pop-row">
        <span className="lbl">画质</span>
        <span className="rec-seg" role="group" aria-label="画质档位">
          {REC_QUALITIES.map((q) => (
            <button
              key={q.key}
              type="button"
              className={quality.key === q.key ? "on" : ""}
              onClick={() => onQuality(q)}
              title={q.desc}
              // 🔴 选中态必须能被读屏拿到（改前只有 class = 视觉独占）。
              // 用 aria-pressed 而非 role=radio：radio 的既定期望是方向键 + roving tabindex，
              // 只贴 role 不实现键盘是半套语义；且音源两个开关本来就是 aria-pressed。
              aria-pressed={quality.key === q.key}
            >
              {q.label}
            </button>
          ))}
        </span>
      </div>
      <div className="rec-pop-row">
        <span className="lbl">声音</span>
        <button
          type="button"
          className={`rec-snd${sysAudio ? " on" : " off"}`}
          onClick={onSys}
          title="录进电脑正在播放的声音"
          aria-pressed={sysAudio}
        >
          🔊 系统声音
        </button>
        <button
          type="button"
          className={`rec-snd${micAudio ? " on" : " off"}`}
          onClick={onMic}
          title="录进解说人声"
          aria-pressed={micAudio}
        >
          🎙 麦克风
        </button>
      </div>
      <div className="rec-pop-row">
        <span className="muted">默认高清 · 录系统声音 · 不录麦克风；麦克风关乎别人听不听得见你</span>
      </div>
    </div>
  );
}

/** ⋯ 按钮 + 徽标 + 浮层的成对包装（两处玻璃条都用它）。 */
export function SettingsCluster(props: {
  open: boolean;
  onToggle: () => void;
  flipBelow: boolean;
  quality: RecQualityItem;
  onQuality: (q: RecQualityItem) => void;
  sysAudio: boolean;
  micAudio: boolean;
  onSys: () => void;
  onMic: () => void;
}) {
  const { open } = props;
  return (
    <>
      <button
        type="button"
        className="rec-btn-ghost"
        onClick={props.onToggle}
        aria-expanded={open}
        // 触发器 ↔ 浮层的关系与展开态一起报给读屏（改前只有 aria-expanded）
        aria-haspopup="true"
        aria-controls={open ? "rec-pop" : undefined}
        title="画质与声音"
      >
        ⋯
      </button>
      <span className="muted rec-badge">{recSettingsBadge(props.quality.label, props.sysAudio, props.micAudio)}</span>
      {open && (
        <SettingsPop
          flipBelow={props.flipBelow}
          quality={props.quality}
          onQuality={props.onQuality}
          sysAudio={props.sysAudio}
          micAudio={props.micAudio}
          onSys={props.onSys}
          onMic={props.onMic}
        />
      )}
    </>
  );
}
