/**
 * RecOverlayParts — 录屏选区覆盖层的**纯展示**部件（规则 7 拆分）：
 * TargetFrames 选区视觉层 + PreviewBar 预览条 + ConfirmBar 确认条 + CountdownOverlay 倒计时。
 * 不持有状态、不碰 IO——状态机与鼠标交互都在 useRecSelectMouse / useRecOverlayKeys，
 * 画质与声音的 ⋯ 浮层在 RecSettingsCluster。
 *
 * 五期甲案（2026-10-10）：预览态就摆终点按钮与 <kbd>Enter</kbd>，读数写明「将录制」谁；
 * 四档画质与音源收进 ⋯，**结果留在条上当徽标**（规则 15.1：控件与反馈同一可见性域）。
 */
import type { RecQualityItem } from "@/lib/recQuality";
import { SettingsCluster } from "./RecSettingsCluster";
import type { Phase } from "@/hooks/useRecSelectMouse";
import type { Rect } from "./snap";

/** 四块暗遮罩（框外区域；坐标与截图同法）。 */
function Shades({ rect, screenCss }: { rect: Rect; screenCss: { w: number; h: number } }) {
  const top = { left: 0, top: 0, width: screenCss.w, height: Math.max(0, rect.y) };
  const bottom = {
    left: 0,
    top: rect.y + rect.h,
    width: screenCss.w,
    height: Math.max(0, screenCss.h - rect.y - rect.h),
  };
  const left = { left: 0, top: rect.y, width: Math.max(0, rect.x), height: rect.h };
  const right = {
    left: rect.x + rect.w,
    top: rect.y,
    width: Math.max(0, screenCss.w - rect.x - rect.w),
    height: rect.h,
  };
  return (
    <>
      {[top, bottom, left, right].map((s, i) => (
        <div
          key={i}
          className="rec-shade"
          style={{ left: s.left, top: s.top, width: s.width, height: s.height }}
        />
      ))}
    </>
  );
}

/**
 * 选区视觉层（暗遮罩 + 全屏四边暗带 + 选区框 / 悬停高亮 / 拖拽吸附）。
 * 从覆盖层主件抽出（规则 7：单文件 ≤300 行）——它只按 phase 决定「谁在框里」。
 */
export function TargetFrames({
  phase,
  recording,
  rect,
  hoverRect,
  snapRect,
  screenCss,
}: {
  phase: Phase;
  recording: boolean;
  rect: Rect;
  hoverRect: Rect | null;
  snapRect: Rect | null;
  screenCss: { w: number; h: number };
}) {
  const hovering = phase === "preview" && hoverRect !== null;
  // 悬停高亮（预览态）与拖拽吸附（拖拽态）互斥，共用同一枚 .rec-snap
  const highlight = hovering ? hoverRect : phase === "dragging" ? snapRect : null;
  return (
    <>
      {/* 暗遮罩：预览/拖拽/确认态才有；录制中零遮挡（预览态 rect=整屏 ⇒ 四块零面积 = 不压暗） */}
      {!recording && <Shades rect={rect} screenCss={screenCss} />}
      {/* 全屏预览态的四边暗带（同截图 .edge-band 的全屏辨识；几何是常量，收进 CSS） */}
      {phase === "preview" && (
        <>
          <div className="rec-edge-band eb-t" />
          <div className="rec-edge-band eb-b" />
          <div className="rec-edge-band eb-l" />
          <div className="rec-edge-band eb-r" />
        </>
      )}
      {/* 选区框：悬停/吸附高亮亮起时整屏框让位（两个框并存会打架，L5 不靠猜） */}
      {!hovering && (
        <div
          className={`rec-rect${phase === "preview" ? " full" : ""}${recording ? " recording" : ""}`}
          style={{ left: rect.x - 1.5, top: rect.y - 1.5, width: rect.w, height: rect.h }} /* ui-rule-ok: 动态定位（跟随选区），同文件既有模式 */
        />
      )}
      {highlight && (
        <div
          className="rec-snap"
          style={{ left: highlight.x - 1.5, top: highlight.y - 1.5, width: highlight.w, height: highlight.h }} /* ui-rule-ok: 动态定位（跟随候选窗口），同文件既有模式 */
        />
      )}
    </>
  );
}

/**
 * 「将录制」读数的**宾语**（§3 不变量的展示面；2026-10-10 审查后确认态/倒计时态也复用）。
 * 一律用**物理**像素，并做与 `rec_start` 同一条偶数对齐（`Math.round(…) & ~1`）——
 * 这样读数里的数字就等于真正送进编码器的尺寸；奇数 dpr（1.25×404=505）下不对齐会吹牛 1px。
 *
 * 返回的是「整个屏幕 1280×720」/「窗口 400×300」这一**宾语**，前缀「将录制：」由展示面自己带：
 * 读数与「来源提示」在确认条里是相邻两行，两句都带前缀就变成「将录制：将录制：」。
 */
export function recTargetReadout(
  target: Rect | null,
  screenPhys: { w: number; h: number },
  dpr: number,
  kind: "window" | "region" = "window",
): string {
  const phys = (v: number) => Math.max(16, Math.round(v) & ~1);
  if (!target) return `整个屏幕 ${phys(screenPhys.w)}×${phys(screenPhys.h)}`;
  // 「窗口」而不是窗口名：enum_window_rects 只回矩形（screenshot.rs:2111），没有标题，
  // 设计稿 §1 里那句「文件资源管理器」要改后端才能兑现——不拿假名字糊上去。
  return `${kind === "window" ? "窗口" : "选区"} ${phys(target.w * dpr)}×${phys(target.h * dpr)}`;
}

/** 条上的读数（2026-10-10 审查 P1）：两处玻璃条同一套写法，前缀在这里带。 */
export function TargetReadout({ text }: { text: string }) {
  return <span className="rec-readout">将录制：{text}</span>;
}

/** 条内共有的右侧动作（退出 + Esc 提示），两处玻璃条同一套。 */
function QuitHint({ onCancel }: { onCancel: () => void }) {
  return (
    <>
      <span className="muted">|</span>
      <button type="button" className="rec-glass-lnk" onClick={onCancel} title="关闭选区，什么都不录">
        ✕ 退出
      </button>
      <span className="muted">·</span>
      <kbd>Esc</kbd>
    </>
  );
}

export function ConfirmBar(props: {
  rect: Rect;
  readout: string;
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
  onRedraw: () => void;
  onCancel: () => void;
  onStart: () => void;
}) {
  const {
    rect, screenCssW, screenCssH, settingsOpen, onToggleSettings,
    onRedraw, onCancel, onStart,
  } = props;
  // 560 = 2026-10-10 审查 P2 把读数加进条后的**保守预留**（旧值 420 是 ⋯+徽标进条前的量，
  // 右缘钳位当时就已经偏小）。真机点验要确认：选区贴右缘时条不越屏；量小会留白，量大才越屏。
  const barW = 560;
  // 水平钳在屏内：选区贴右缘时确认条不能把右半截伸出屏幕（P3，2026-10-05 审查）
  const x = Math.min(
    Math.max(8, rect.x + rect.w / 2 - barW / 2),
    Math.max(8, screenCssW - barW - 8),
  );
  const below = rect.y + rect.h + 14;
  const top = below + 56 > screenCssH ? Math.max(8, rect.y - 70) : below;
  return (
    <div className="rec-glass" style={{ left: x, top, gap: 8 }}>
      <button type="button" className="rec-btn-start" onClick={onStart}>
        <span className="dot" />
        开始录制
      </button>
      <kbd>Enter</kbd>
      <span className="muted">|</span>
      {/* 读数（审查 P1）：确认态是承诺成立的那一拍，「将录制」不许消失 */}
      <TargetReadout text={props.readout} />
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
        sysAudio={props.sysAudio}
        micAudio={props.micAudio}
        onSys={props.onSys}
        onMic={props.onMic}
      />
      <QuitHint onCancel={onCancel} />
    </div>
  );
}

/** 预览条（甲案 §1）：终点按钮 + 实时读数 + ⋯；不再要求先做一次含义不明确的点击。 */
export function PreviewBar({
  readout,
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
  onCancel,
  onStart,
}: {
  readout: string;
  /** 当前目标是一扇悬停窗口（= 读数可以放弃它回到整屏）；整屏态不给死控件。 */
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
  onCancel: () => void;
  onStart: () => void;
}) {
  return (
    <div
      className="rec-glass"
      style={{ left: "50%", transform: "translateX(-50%)", bottom: screenCssH * 0.08 }}
    >
      <button type="button" className="rec-btn-start" onClick={onStart}>
        <span className="dot" />
        开始录制
      </button>
      <kbd>Enter</kbd>
      <span className="muted">|</span>
      {/* 读数即控制（规则 17）：目标是一扇窗时，它同时是「改录整屏」的按钮——
          默认主张（整屏）必须有一条鼠标路径，不能只靠 Esc 退出整层。 */}
      {hasWindowTarget ? (
        <button
          type="button"
          className="rec-readout rec-target-lnk"
          onClick={onReleaseTarget}
          title="录这扇窗口；点这里放弃它，改录整个屏幕"
        >
          将录制：{readout}
          <span className="rec-swap">改录整屏</span>
        </button>
      ) : (
        <TargetReadout text={readout} />
      )}
      <SettingsCluster
        open={settingsOpen}
        onToggle={onToggleSettings}
        // 预览条固定在屏下方 8%，浮层恒在条上方
        flipBelow={false}
        quality={quality}
        onQuality={onQuality}
        sysAudio={sysAudio}
        micAudio={micAudio}
        onSys={onSys}
        onMic={onMic}
      />
      <QuitHint onCancel={onCancel} />
    </div>
  );
}

/**
 * 倒计时（只盖选区）；「取消」是鼠标出口（§17：键盘只是加速器）。
 * 2026-10-10 审查 P1：这一层必须带上「将录制」——最后可中止的那一秒，
 * 屏幕上不该只剩一个数字（peak-end 的「end」是反的）。
 */
export function CountdownOverlay({ rect, count, readout, onCancel }: {
  rect: Rect; count: number; readout: string; onCancel: () => void;
}) {
  return (
    <div
      className="rec-countdown"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    >
      <span className="rec-count-target">将录制：{readout}</span>
      <span className="num">{Math.max(1, count)}</span>
      <button type="button" className="rec-count-cancel" onClick={onCancel}>
        取消
      </button>
      <span className="esc">
        <kbd>Esc</kbd> 回到选区
      </span>
    </div>
  );
}
