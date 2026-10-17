/**
 * RecOverlayParts — 录屏选区覆盖层的**纯展示**部件（规则 7 拆分）：
 * PreviewBar 预览条 + ConfirmBar 确认条（选区视觉层在 RecTargetFrames，倒计时转出到 RecCountdownOverlay）。
 * 不持有状态、不碰 IO——状态机与鼠标交互在 useRecSelectMouse / useRecOverlayKeys；
 * 目标读数胶囊在 RecTargetChip、音源胶囊在 RecAudioToggles、画质浮层在 RecSettingsCluster。
 *
 * 2026-10-16 苹果风重做（方案 §5.1 文案减法 / §5.2 结构减法）：
 * ① 条从「12 个元素齐平、靠 `|` 与 `·` 当分隔符」改成三级分组（主动作 │ 目标 │ 设置），
 *    分隔交给 8px 间距与一枚 `sep` 竖线；
 * ② 条底那行常驻教学（把条撑成两行）删掉，收进条右端 `?` 就地点开；
 * ③ 目标读数只留尺寸：来源交给左侧图标、动作就是这枚胶囊自己（22 字 → 0 字）；
 * ④ 「开始录制」是全条唯一实色按钮（V3 一屏一个强调色）。
 */
import { X } from "lucide-react";
import type { RecQualityItem } from "@/lib/recQuality";
import { SettingsCluster } from "./RecSettingsCluster";
import { AudioToggles } from "./RecAudioToggles";
import { TargetChip, type TargetKind } from "./RecTargetChip";
import { HelpHint } from "./RecHelpHint";
import type { Rect } from "./snap";
import styles from "./RecOffice.module.css";

/**
 * 目标读数（§3 不变量的展示面）。
 * 一律用**物理**像素，并做与 `rec_start` 同一条偶数对齐（`Math.round(…) & ~1`）——
 * 这样读数里的数字就等于真正送进编码器的尺寸；奇数 dpr（1.25×404=505）下不对齐会吹牛 1px。
 *
 * 返回 `{ text, kind }`：**文字里不再写来源**（「窗口所在区域」「整个屏幕」），
 * 来源由 `kind` 交给胶囊左侧那枚图标（§5.1，这条读数 22 字 → 0 字）。
 */
export function recTarget(
  target: Rect | null,
  screenPhys: { w: number; h: number },
  dpr: number,
  kind: "window" | "region" = "window",
): { text: string; kind: TargetKind } {
  const phys = (v: number) => Math.max(16, Math.round(v) & ~1);
  if (!target) return { text: `${phys(screenPhys.w)} × ${phys(screenPhys.h)}`, kind: "screen" };
  // 「窗口」而不是窗口名：enum_window_rects 只回矩形（screenshot.rs:2111），没有标题，
  // 设计稿 §1 里那句「文件资源管理器」要改后端才能兑现——不拿假名字糊上去。
  return {
    text: `${phys(target.w * dpr)} × ${phys(target.h * dpr)}`,
    kind: kind === "window" ? "window" : "region",
  };
}

/** 退出 = 条上唯一的鼠标出口（§17 键盘只是加速器）。键位由 title 与 `?` 承载，不占常驻宽度。 */
function QuitButton({ onCancel }: { onCancel: () => void }) {
  return (
    <button
      type="button"
      className="rec-icon-btn"
      onClick={onCancel}
      title="关闭选区，什么都不录（Esc）"
      aria-label="关闭选区，什么都不录"
    >
      <X size={13} aria-hidden="true" />
    </button>
  );
}

export function ConfirmBar(props: {
  rect: Rect;
  target: { text: string; kind: TargetKind };
  screenCssW: number;
  screenCssH: number;
  quality: RecQualityItem;
  onQuality: (q: RecQualityItem) => void;
  sysAudio: boolean;
  micAudio: boolean;
  onSys: () => void;
  onMic: () => void;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  helpOpen: boolean;
  onToggleHelp: () => void;
  onRedraw: () => void;
  onCancel: () => void;
  onStart: () => void;
  checking?: boolean;
}) {
  const {
    rect, screenCssW, screenCssH, settingsOpen, onToggleSettings, helpOpen, onToggleHelp,
    onRedraw, onCancel, onStart, target,
  } = props;
  // 与 .scopeBar 的宽度上限一致；条内已无教学行，正常屏宽下不换行。
  const barW = 800;
  // 水平钳在屏内：选区贴右缘时确认条不能把右半截伸出屏幕（P3，2026-10-05 审查）
  const x = Math.min(
    Math.max(8, rect.x + rect.w / 2 - barW / 2),
    Math.max(8, screenCssW - barW - 8),
  );
  const below = rect.y + rect.h + 14;
  const top = below + 120 > screenCssH ? Math.max(8, rect.y - 130) : below;
  return (
    <div className={`rec-glass ${styles.scopeBar}`} style={{ left: x, top }}> {/* ui-rule-ok: 选区位置动态驱动，静态尺寸由 CSS Module 负责 */}
      {/* ① 主动作（全条唯一实色） */}
      <button type="button" className="rec-btn-start" onClick={onStart} disabled={props.checking}>
        <span className="dot" />
        {props.checking ? "检查声音…" : "开始录制"}
      </button>
      <kbd>Enter</kbd>
      <span className="rec-sep" aria-hidden="true" />
      {/* ② 目标：已落子，读数不再可改（要改走「重画」） */}
      <TargetChip text={target.text} kind={target.kind} />
      <span className="rec-sep" aria-hidden="true" />
      {/* ③ 设置 */}
      <button type="button" className="rec-btn-ghost" onClick={onRedraw}>
        重画
      </button>
      <SettingsCluster
        open={settingsOpen}
        onToggle={onToggleSettings}
        // 条贴屏顶时浮层翻到下方，不许伸出屏外
        flipBelow={top < 150}
        quality={props.quality}
        onQuality={props.onQuality}
      />
      <AudioToggles
        sysAudio={props.sysAudio}
        micAudio={props.micAudio}
        onSys={props.onSys}
        onMic={props.onMic}
      />
      <span className={styles.barGrow} />
      <HelpHint open={helpOpen} onToggle={onToggleHelp}>
        拖拽可以自选区域；这里的读数就是真正送进编码器的尺寸。<br />
        按屏幕位置录制：窗口移开或被人挡住，录到的内容会跟着变。
      </HelpHint>
      <QuitButton onCancel={onCancel} />
    </div>
  );
}

/** 预览条（甲案 §1）：终点按钮 + 实时读数；不再要求先做一次含义不明确的点击。 */
export function PreviewBar({
  target,
  hasWindowTarget,
  onReleaseTarget,
  screenCssH,
  quality,
  onQuality,
  sysAudio,
  micAudio,
  onSys,
  onMic,
  settingsOpen,
  onToggleSettings,
  helpOpen,
  onToggleHelp,
  onCancel,
  onStart,
  checking,
}: {
  target: { text: string; kind: TargetKind };
  /** 当前目标是一扇悬停窗口（= 读数胶囊可以放弃它回到整屏）；整屏态不给死控件。 */
  hasWindowTarget: boolean;
  onReleaseTarget: () => void;
  screenCssH: number;
  quality: RecQualityItem;
  onQuality: (q: RecQualityItem) => void;
  sysAudio: boolean;
  micAudio: boolean;
  onSys: () => void;
  onMic: () => void;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  helpOpen: boolean;
  onToggleHelp: () => void;
  onCancel: () => void;
  onStart: () => void;
  checking?: boolean;
}) {
  return (
    <div
      className={`rec-glass ${styles.scopeBar}`}
      style={{ left: "50%", transform: "translateX(-50%)", bottom: screenCssH * 0.08 }}
    >
      {/* ① 主动作（全条唯一实色） */}
      <button type="button" className="rec-btn-start" onClick={onStart} disabled={checking}>
        <span className="dot" />
        {checking ? "检查声音…" : "开始录制"}
      </button>
      <kbd>Enter</kbd>
      <span className="rec-sep" aria-hidden="true" />
      {/* ② 目标：读数即控制（规则 17）——目标是一扇窗时，整枚胶囊就是「改录整屏」的按钮，
          默认主张（整屏）必须有一条纯鼠标路径，不能只靠 Esc 退出整层。 */}
      <TargetChip
        text={target.text}
        kind={target.kind}
        onRelease={hasWindowTarget ? onReleaseTarget : undefined}
      />
      <span className="rec-sep" aria-hidden="true" />
      {/* ③ 设置 */}
      <SettingsCluster
        open={settingsOpen}
        onToggle={onToggleSettings}
        // 预览条固定在屏下方 8%，浮层恒在条上方
        flipBelow={false}
        quality={quality}
        onQuality={onQuality}
      />
      <AudioToggles sysAudio={sysAudio} micAudio={micAudio} onSys={onSys} onMic={onMic} />
      <span className={styles.barGrow} />
      <HelpHint open={helpOpen} onToggle={onToggleHelp}>
        移动鼠标预览窗口，单击采纳；也可以直接拖拽画自己的区域。<br />
        按屏幕位置录制：窗口移开或被人挡住，录到的内容会跟着变。
      </HelpHint>
      <QuitButton onCancel={onCancel} />
    </div>
  );
}

export { CountdownOverlay } from "./RecCountdownOverlay";
