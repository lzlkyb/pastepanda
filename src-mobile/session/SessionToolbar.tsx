import { useEffect, useState, type ReactNode } from "react";
import { Keyboard, Monitor, Ellipsis, RotateCw, MousePointer2, ChevronDown, ArrowLeft } from "lucide-react";
import { PointerModeSheet } from "./PointerModeSheet";
import type { PointerMode } from "./useSessionPointer";
import { POINTER_MODES } from "./pointerModes";
import { MobileSheet } from "../ui/MobileSheet";
import { MobileNotice } from "../ui/MobileNotice";
import { SessionClipboardPanel } from "./SessionClipboardPanel";
import type { useSessionClipboard } from "./useSessionClipboard";
import { useMobileBack } from "../ui/useMobileBack";
import { rcErrorText } from "../devices/rcErrorText";
import { MOBILE_QUALITY_CYCLE, type MobileQuality } from "./qualityCycle";
import { qualityLabel } from "@/lib/rcQuality";
import type { useSessionSettings } from "./useSessionSettings";
import { SessionSettingFeedback } from "./SessionSettingFeedback";
import ui from "../ui/MobileUi.module.css";
import styles from "./RcMobileSession.module.css";

export type MobileKeyMode = "type" | "direct";

export function SessionToolbar({
  landscape,
  visible,
  keyboardOn,
  onToggleKeyboard,
  onResetZoom,
  quality,
  onPickQuality,
  audioOn,
  onToggleAudio,
  onToggleOrientation,
  clipboard,
  onEnd,
  canControl = true,
  ending = false,
  endError,
  onPanelChange,
  pointerMode = "trackpad",
  onPointerMode,
  mouseOpen = false,
  onToggleMouse,
  onRevealTools,
  onRevealPointer,
  requestEnd = 0,
  requestScreen = 0,
  requestMore = 0,
  inputReady = true,
  onConnectionDetails,
  connectionEntry,
  mouseAssist,
  toolHint = false,
  settings, orientationHint, onOrientationHintDismiss, fileEntry, feedbackEntry,
}: {
  landscape: boolean;
  visible: boolean;
  keyboardOn: boolean;
  onToggleKeyboard: () => void;
  onResetZoom: () => void;
  quality: MobileQuality | null;
  onPickQuality: (quality: MobileQuality) => void;
  audioOn: boolean;
  onToggleAudio: () => void;
  onToggleOrientation: () => void;
  clipboard: ReturnType<typeof useSessionClipboard>;
  onEnd: () => void;
  canControl?: boolean;
  ending?: boolean;
  endError?: string | null;
  onPanelChange?: (open: boolean) => void;
  pointerMode?: PointerMode;
  onPointerMode?: (mode: PointerMode) => void;
  mouseOpen?: boolean;
  onToggleMouse?: () => void;
  onRevealTools?: () => void;
  onRevealPointer?: () => void;
  requestEnd?: number;
  requestScreen?: number;
  requestMore?: number;
  inputReady?: boolean;
  onConnectionDetails?: () => void;
  connectionEntry?: ReactNode;
  mouseAssist?: ReactNode;
  /** 横屏首次引导（useImmersiveCapsule phase=hint）：把手脉冲 + 一次性气泡。 */
  toolHint?: boolean;
  settings?: ReturnType<typeof useSessionSettings>;
  orientationHint?: string;
  onOrientationHintDismiss?: () => void;
  fileEntry?: ReactNode;
  feedbackEntry?: ReactNode;
}) {
  const [panel, setPanel] = useState<"screen" | "more" | "end" | "mode" | null>(null);
  useEffect(() => {
    if (panel && keyboardOn) onToggleKeyboard();
  }, [panel, keyboardOn, onToggleKeyboard]);
  useEffect(() => {
    if (requestEnd) setPanel("end");
  }, [requestEnd]);
  useEffect(() => {
    if (requestScreen) setPanel("screen");
  }, [requestScreen]);
  useEffect(() => { if (requestMore) setPanel("more"); }, [requestMore]);
  const back = () => {
    if (keyboardOn) onToggleKeyboard();
    else setPanel("end");
  };
  useMobileBack(true, back, true);
  useEffect(() => {
    onPanelChange?.(panel !== null || clipboard.clipOpen);
  }, [panel, clipboard.clipOpen, onPanelChange]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || panel || clipboard.clipOpen) return;
      event.preventDefault();
      event.stopPropagation();
      if (keyboardOn) onToggleKeyboard();
      else setPanel("end");
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [keyboardOn, onToggleKeyboard, panel, clipboard.clipOpen]);
  const closePanel = () => {
    if (!ending) setPanel(null);
  };
  const cls = landscape
    ? `${styles.toolbar} ${styles.toolbarCapsule} ${visible ? "" : styles.toolbarHidden}`
    : styles.toolbar;
  return (
    <>
      <div className={landscape ? styles.toolRail : styles.portraitTools}>
      <div className={landscape ? styles.toolRailScroll : styles.portraitTools}>
      {landscape && <div className={styles.landscapeTools}>
        {!keyboardOn && (
        <button
          type="button"
          className={styles.toolHandle + (toolHint ? " " + styles.toolHandlePulse : "")}
          onClick={onRevealTools}
          aria-expanded={visible}
        >
          <ChevronDown size={18} aria-hidden="true" />
          {visible ? "收起" : "工具"}
        </button>
        )}
        {connectionEntry}
      </div>}
      <nav hidden={keyboardOn || (landscape && !visible)} className={cls} aria-label="会话工具">
        <button
          type="button"
          className={styles.tbBtn + " " + styles.tbOn + (pointerMode === "pad" ? " " + styles.pointerWide : "")}
          disabled={!canControl || !inputReady}
          onClick={() => setPanel("mode")}
        >
          <MousePointer2 size={22} aria-hidden="true" />
          <span>{POINTER_MODES[pointerMode].label}</span>
        </button>
        <button type="button" className={styles.tbBtn} disabled={!canControl || !inputReady} onClick={onToggleKeyboard}>
          <Keyboard size={22} aria-hidden="true" />
          <span>键盘</span>
        </button>
        <button type="button" className={styles.tbBtn} onClick={() => setPanel("screen")}>
          <Monitor size={22} aria-hidden="true" />
          <span>画面</span>
        </button>
        <button type="button" className={styles.tbBtn} onClick={() => setPanel("more")}>
          <Ellipsis size={22} aria-hidden="true" />
          <span>更多</span>
        </button>
        {!landscape && fileEntry}
      </nav>
      {landscape && mouseAssist}
      {landscape && fileEntry}
      {landscape && feedbackEntry}
      </div>
      {landscape && <button type="button" className={`${styles.tbBtn} ${styles.railExit}`} onClick={() => setPanel("end")}>
        <ArrowLeft size={20} aria-hidden="true" />
        <span>退出</span>
      </button>}
      </div>
      {/* 气泡挂在 rail 外层：toolRail overflow 裁剪会吃掉伸出画面的部分。 */}
      {landscape && toolHint && !visible && !keyboardOn && (
        <div className={styles.toolTip} role="note">画面、键盘、画质工具都收在这里</div>
      )}
      <PointerModeSheet
        open={panel === "mode"}
        onClose={closePanel}
        mode={pointerMode}
        onMode={onPointerMode ?? (() => {})}
        mouseOpen={mouseOpen}
        onMouse={onToggleMouse ?? (() => {})}
        enabled={canControl && inputReady}
      />
      <MobileSheet open={panel === "screen"} title="画面" onClose={closePanel} footer={(settings?.items.quality || orientationHint) && <>
        <SessionSettingFeedback state={settings?.items.quality} onRetry={() => void settings?.retry("quality")} />
        {orientationHint && <MobileNotice compact tone="error" title="显示方向未能切换" detail={orientationHint} onDismiss={onOrientationHintDismiss} />}
      </>}>
        <div className={styles.panelActions}>
          <button
            type="button"
            className={ui.secondary}
            onClick={() => {
              onResetZoom();
              setPanel(null);
            }}
          >
            适应屏幕
          </button>
          <button type="button" className={ui.secondary} onClick={onToggleOrientation}>
            <RotateCw size={18} aria-hidden="true" />
            {landscape ? "切换到竖屏" : "切换到横屏"}
          </button>
          <button
            type="button"
            className={ui.secondary}
            onClick={() => {
              onRevealPointer?.();
              setPanel(null);
            }}
          >
            回到指针
          </button>
          <h3 className={ui.sectionHeading}>画质</h3>
          {/* 语义必须先于第一次点击可见：点实名档会整场关掉电脑的自动档
              （2026-10-06 复测 B 的误触陷阱——点了「清晰」，自动档静默阵亡）。 */}
          <p className={styles.panelHint}>选「清晰 / 均衡 / 流畅」会锁档并关闭电脑自动档；点「自动」恢复。</p>
          {!quality && <p className={styles.panelHint}>当前电脑画质尚未确认，选择档位后等待电脑确认。</p>}
          {quality === "auto" && <p className={styles.panelHint}>电脑正按网络状况自动换档。</p>}
          {quality && quality !== "auto" && (
            <p className={styles.panelHint}>已锁档「{qualityLabel(quality)}」：电脑自动档已关闭，点「自动」恢复。</p>
          )}
          <div className={styles.qualityChoices} role="radiogroup" aria-label="画质">
            {MOBILE_QUALITY_CYCLE.map((value) => (
              <button
                type="button"
                role="radio"
                key={value}
                aria-checked={quality === value}
                className={quality === value ? ui.primary : ui.secondary}
                onClick={() => onPickQuality(value)}
              >
                {qualityLabel(value)}
              </button>
            ))}
          </div>
          <p className={styles.panelHint}>{pointerMode === "pad" || pointerMode === "floating"
            ? "画面手势只调整本地视野；点击滚动按钮后，用触控板或控制柄滚动电脑页面。"
            : "双指捏合可缩放画面；双指移动可滚动电脑页面。"}</p>
        </div>
      </MobileSheet>
      <SessionClipboardPanel clipboard={clipboard} canControl={canControl && inputReady} />
      <MobileSheet open={panel === "more"} title="更多" onClose={closePanel}
        footer={settings?.items.audio && <SessionSettingFeedback state={settings.items.audio} onRetry={() => void settings.retry("audio")} />}>
        <div className={styles.panelActions}>
          {onConnectionDetails && <button type="button" className={ui.secondary} onClick={() => {
            setPanel(null);
            onConnectionDetails();
          }}>连接详情</button>}
          <button type="button" className={ui.secondary} onClick={() => setPanel("screen")}>
            <Monitor size={18} aria-hidden="true" />
            画面与画质
          </button>
          <button
            type="button"
            className={ui.secondary}
            disabled={!canControl || !inputReady}
            onClick={() => {
              setPanel(null);
              clipboard.toggleClip();
            }}
          >
            剪贴板
          </button>
          {!canControl && <MobileNotice>当前会话只观看画面，键盘和剪贴板不可用。</MobileNotice>}
          <button type="button" className={ui.secondary} aria-pressed={audioOn} onClick={onToggleAudio}>
            {audioOn ? "关闭电脑声音" : "开启电脑声音"}
          </button>
          <p className={styles.panelHint}>电脑声音默认关闭，开启后通过手机播放。</p>
          <button type="button" className={ui.danger} onClick={() => setPanel("end")}>
            断开连接
          </button>
        </div>
      </MobileSheet>
      <MobileSheet
        open={panel === "end"}
        title="断开连接？"
        description="将结束这次远程会话，电脑上的工作会继续保留。"
        onClose={closePanel}
      >
        <div className={styles.panelActions}>
          {endError && <MobileNotice error title="连接未能断开" detail={rcErrorText(endError)} />}
          <button type="button" className={ui.danger} disabled={ending} onClick={onEnd}>
            {ending ? "正在断开…" : "确认断开"}
          </button>
          <button type="button" className={ui.secondary} disabled={ending} onClick={() => setPanel(null)}>
            继续连接
          </button>
        </div>
      </MobileSheet>
    </>
  );
}
