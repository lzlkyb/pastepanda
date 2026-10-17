/**
 * RecAudioToggles — 录前条上两枚音源胶囊（规则 7：从 RecSettingsCluster 拆出）。
 *
 * §5.1 文案减法：文字**只留音源名**，「开 / 关」两个字交给状态点承担
 * （实心 accent = 开，空心描边 = 关）。原版靠把文字调到 40% 变虚来报「关」，
 * 源码注释自述六个主题全部不过 AA（3.30 / 3.27 / 2.55 / 2.55 / 2.34 / 2.42）。
 * 状态语义由 `aria-pressed` 承担、补充说明由 `title` 承担，两者都不占视觉宽度。
 *
 * ⚠️ 这两者是**兜底**：去掉文字后不许让状态只能靠悬停才能拿到——
 * 状态点本身是实心/空心两种可辨形态（去色测试仍成立）。
 */
import { Mic, Volume2, type LucideIcon } from "lucide-react";

function SoundToggle({
  on,
  label,
  Icon,
  onToggle,
}: {
  on: boolean;
  label: string;
  Icon: LucideIcon;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`rec-snd ${on ? "on" : "off"}`}
      aria-pressed={on}
      title={`${label}：${on ? "已开" : "已关"}`}
      onClick={onToggle}
    >
      <Icon size={13} aria-hidden="true" />
      <i className="rec-snd-dot" aria-hidden="true" />
      <span className="rec-snd-lbl">{label}</span>
    </button>
  );
}

export function AudioToggles({
  sysAudio,
  micAudio,
  onSys,
  onMic,
}: {
  sysAudio: boolean;
  micAudio: boolean;
  onSys: () => void;
  onMic: () => void;
}) {
  return (
    <>
      <SoundToggle on={sysAudio} label="电脑声音" Icon={Volume2} onToggle={onSys} />
      <SoundToggle on={micAudio} label="麦克风" Icon={Mic} onToggle={onMic} />
    </>
  );
}
