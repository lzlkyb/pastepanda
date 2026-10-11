import { useEffect, useRef, useState, type ReactNode } from "react";
import { Keyboard, Monitor, Ellipsis, MousePointer2, ChevronDown, ArrowLeft } from "lucide-react";
import { PointerModeSheet } from "./PointerModeSheet";
import type { PointerMode } from "./useSessionPointer";
import { POINTER_MODES } from "./pointerModes";
import { SessionClipboardPanel } from "./SessionClipboardPanel";
import type { useSessionClipboard } from "./useSessionClipboard";
import { useMobileBack } from "../ui/useMobileBack";
import type { MobileQuality } from "./qualityCycle";
import type { useSessionSettings } from "./useSessionSettings";
import { SessionToolbarPanels, type SessionPanel } from "./SessionToolbarPanels";
import styles from "./RcMobileSession.module.css";

export type MobileKeyMode = "type" | "direct";
export type SessionToolbarProps = {
  immersive?: boolean;
  onImmersive?: () => void;
  onRestoreTools?: () => void;
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
  /** Pending/idle is a request, even if a first frame has not arrived yet. */
  waiting?: boolean;
  onPanelChange?: (open: boolean) => void;
  pointerMode?: PointerMode;
  onPointerMode?: (mode: PointerMode) => void;
  mouseOpen?: boolean;
  onToggleMouse?: () => void;
  onRevealTools?: () => void;
  onRevealPointer?: () => void;
  requestEnd?: number;
  requestScreen?: number;
  requestedScreenBack?: () => void;
  requestMore?: number;
  inputReady?: boolean;
  onConnectionDetails?: (onBack?: () => void) => void;
  connectionEntry?: ReactNode;
  mouseAssist?: ReactNode;
  toolHint?: boolean;
  settings?: ReturnType<typeof useSessionSettings>;
  orientationHint?: string;
  onOrientationHintDismiss?: () => void;
  fileEntry?: ReactNode;
  feedbackEntry?: ReactNode;
};

export function SessionToolbar(props: SessionToolbarProps) {
  const { landscape, visible, keyboardOn, onToggleKeyboard, clipboard, canControl = true, ending = false,
    onPanelChange, pointerMode = "trackpad", onPointerMode, mouseOpen = false, onToggleMouse,
    onRevealTools, requestEnd = 0, requestScreen = 0, requestMore = 0, inputReady = true,
    onConnectionDetails, connectionEntry, mouseAssist, toolHint = false, fileEntry, feedbackEntry, waiting = false,
    onEnd, requestedScreenBack } = props;
  const [panel, setPanel] = useState<SessionPanel | null>(null);
  const [trail, setTrail] = useState<SessionPanel[]>([]);
  const externalBack = useRef<(() => void) | undefined>(undefined);
  const clipboardBack = useRef(false);
  const openRoot = (next: SessionPanel) => {
    externalBack.current = undefined;
    setTrail([]);
    setPanel(next);
  };
  const closeAll = () => {
    if (ending) return;
    externalBack.current = undefined;
    setTrail([]);
    setPanel(null);
  };
  const backPanel = () => {
    if (ending) return;
    if (trail.length) {
      setPanel(trail[trail.length - 1]);
      setTrail(trail.slice(0, -1));
    } else if (externalBack.current) {
      const restore = externalBack.current;
      closeAll();
      restore();
    } else closeAll();
  };
  const enterPanel = (next: SessionPanel) => {
    if (panel) setTrail([...trail, panel]);
    setPanel(next);
  };
  const requestExit = () => {
    if (ending) return;
    enterPanel("end");
    // Cancelling a request needs no second confirmation; an established session does.
    if (waiting) onEnd();
  };
  useEffect(() => { if (panel && keyboardOn) onToggleKeyboard(); }, [panel, keyboardOn, onToggleKeyboard]);
  useEffect(() => { if (requestEnd) requestExit(); }, [requestEnd]);
  useEffect(() => {
    if (!requestScreen) return;
    openRoot("screen");
    externalBack.current = requestedScreenBack;
  }, [requestScreen]);
  useEffect(() => { if (requestMore) openRoot("more"); }, [requestMore]);
  const back = () => {
    if (keyboardOn) onToggleKeyboard();
    else requestExit();
  };
  useMobileBack(true, back, true);
  useEffect(() => { onPanelChange?.(panel !== null || clipboard.clipOpen); }, [panel, clipboard.clipOpen, onPanelChange]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || panel || clipboard.clipOpen) return;
      event.preventDefault();
      event.stopPropagation();
      back();
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [keyboardOn, onToggleKeyboard, panel, clipboard.clipOpen, waiting, ending, onEnd]);
  const cls = landscape ? [styles.toolbar, styles.toolbarCapsule, visible ? "" : styles.toolbarHidden].join(" ") : styles.toolbar;
  const hasSource = trail.length > 0 || !!externalBack.current;
  return <>
    {landscape && props.immersive && <button type="button" className={styles.immersiveHandle} onClick={props.onRestoreTools}><ChevronDown size={18} aria-hidden="true" />工具</button>}
    <div hidden={landscape && props.immersive} className={landscape ? styles.toolRail : styles.portraitTools}>
      <div className={landscape ? styles.toolRailScroll : styles.portraitTools}>
        {landscape && <div className={styles.landscapeTools}>
          {!keyboardOn && <button type="button" className={styles.toolHandle + (toolHint ? " " + styles.toolHandlePulse : "")}
            onClick={onRevealTools} aria-expanded={visible}>
            <ChevronDown size={18} aria-hidden="true" />{visible ? "收起" : "工具"}
          </button>}
          {connectionEntry}
        </div>}
        <nav hidden={keyboardOn || (landscape && !visible)} className={cls} aria-label="会话工具">
          <button type="button" className={styles.tbBtn + " " + styles.tbOn + (pointerMode === "pad" ? " " + styles.pointerWide : "")}
            disabled={!canControl || !inputReady} onClick={() => openRoot("mode")}>
            <MousePointer2 size={22} aria-hidden="true" /><span>{POINTER_MODES[pointerMode].label}</span>
          </button>
          <button type="button" className={styles.tbBtn} disabled={!canControl || !inputReady} onClick={onToggleKeyboard}>
            <Keyboard size={22} aria-hidden="true" /><span>键盘</span>
          </button>
          <button type="button" className={styles.tbBtn} onClick={() => openRoot("screen")}><Monitor size={22} aria-hidden="true" /><span>画面</span></button>
          <button type="button" className={styles.tbBtn} onClick={() => openRoot("more")}><Ellipsis size={22} aria-hidden="true" /><span>更多</span></button>
          {!landscape && fileEntry}
        </nav>
        {landscape && visible && mouseAssist}
        {landscape && fileEntry}
        {landscape && visible && !keyboardOn && props.onImmersive && <button type="button" className={styles.tbBtn} onClick={props.onImmersive}><Monitor size={20} aria-hidden="true" /><span>沉浸画面</span></button>}
      </div>
      {landscape && <button type="button" className={[styles.tbBtn, styles.railExit].join(" ")} onClick={requestExit}>
        <ArrowLeft size={20} aria-hidden="true" /><span>{waiting ? "取消申请" : "退出"}</span>
      </button>}
    </div>
    {feedbackEntry}
    {landscape && toolHint && !visible && !keyboardOn && <div className={styles.toolTip} role="note">画面、键盘、画质工具都收在这里</div>}
    <PointerModeSheet open={panel === "mode"} onClose={closeAll} mode={pointerMode} onMode={onPointerMode ?? (() => {})}
      mouseOpen={mouseOpen} onMouse={onToggleMouse ?? (() => {})} enabled={canControl && inputReady} />
    <SessionToolbarPanels {...props} panel={panel} onClose={closeAll} onBack={hasSource ? backPanel : undefined}
      onScreen={() => enterPanel("screen")} onExit={requestExit}
      onConnection={() => { closeAll(); onConnectionDetails?.(() => openRoot("more")); }}
      onClipboard={() => { clipboardBack.current = true; closeAll(); clipboard.openClip(); }} />
    <SessionClipboardPanel clipboard={clipboard} canControl={canControl && inputReady} onBack={clipboardBack.current ? () => {
      clipboard.toggleClip(); clipboardBack.current = false; openRoot("more");
    } : undefined} onClose={() => { clipboardBack.current = false; clipboard.toggleClip(); }} />
  </>;
}
