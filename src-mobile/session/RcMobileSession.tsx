import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRcFrames } from "@/hooks/useRcFrames";
import { useRcAudio } from "@/hooks/useRcAudio";
import { useRcBackgroundPause } from "@/hooks/useRcBackgroundPause";
import { useRcSessionKeepalive } from "./useRcSessionKeepalive";
import type { MobileQuality } from "./qualityCycle";
import { useSessionSettings } from "./useSessionSettings";
import type { PinchViewportHandle } from "../video/PinchViewport";
import { useSessionPointer } from "./useSessionPointer";
import { MouseAssist } from "./MouseAssist";
import { RcSessionHeader } from "./RcSessionHeader";
import { RcConnectionBadge, RcConnectionDetails } from "./RcConnectionDetails";
import { useMobileConnectionInfo } from "./useMobileConnectionInfo";
import { rcConnectStage } from "./rcConnectStage";
import { useDirectSwitchToast } from "./useDirectSwitchToast";
import { useAutoSuggestToast } from "./useAutoSuggestToast";
import type { RcStatus } from "@/lib/api/rcTypes";
import { useRcMobileInput } from "./useRcMobileInput";
import { useModifierKeys } from "./useModifierKeys";
import { useImmersiveCapsule } from "./useImmersiveCapsule";
import { useOrientationLock } from "./useOrientationLock";
import { useSoftKeyboardBridge } from "./useSoftKeyboardBridge";
import { createTouchFeedback } from "./touchFeedback";
import { useSessionClipboard } from "./useSessionClipboard";
import { useRemoteCursor } from "./useRemoteCursor";
import { SessionToolbar, type MobileKeyMode } from "./SessionToolbar";
import { ModifierKeyBar } from "./ModifierKeyBar";
import { SessionFileRequests } from "./SessionFileRequests";
import { SessionScreen } from "./SessionScreen";
import { SessionStatusFeedback, useAcknowledgedSendFailure } from "./SessionStatusFeedback";
import type { RcFileView } from "@/hooks/useRcFile";
import styles from "./RcMobileSession.module.css";

export function RcMobileSession({
  title,
  subtitle,
  canvasRef,
  sessionId,
  contentSize,
  qualityHint,
  canControl = true,
  endError,
  ending = false,
  onEnd,
  file,
  status,
  clipboard,
}: {
  title: string;
  subtitle?: string;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  sessionId?: string;
  contentSize?: { w: number; h: number };
  qualityHint?: string;
  canControl?: boolean;
  endError?: string | null;
  ending?: boolean;
  onEnd: () => void;
  file?: RcFileView;
  status?: RcStatus | null;
  /** 注入口（触摸沙盒用）；缺省走内部真实剪贴板 hook。 */
  clipboard?: ReturnType<typeof useSessionClipboard>;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<PinchViewportHandle>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const chargeRef = useRef<HTMLDivElement>(null);
  const remoteCursorRef = useRef<HTMLDivElement>(null);

  const settings = useSessionSettings(sessionId);
  const keyChoice = settings.items.key_mode;
  const keyMode = (keyChoice?.status === "unconfirmed" ? keyChoice.value : settings.confirmed.key_mode) as MobileKeyMode;
  const keyModeRef = useRef(keyMode);
  keyModeRef.current = keyMode;
  // The local stream preference is not a receipt from the computer's encoder.
  const quality = settings.confirmed.quality as MobileQuality | null;
  const [panelOpen, setPanelOpen] = useState(false);
  const [fileOpen, setFileOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const connectionBack = useRef<(() => void) | undefined>(undefined);
  const screenBack = useRef<(() => void) | undefined>(undefined);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [requestEnd, setRequestEnd] = useState(0);
  const [requestScreen, setRequestScreen] = useState(0);
  const [requestMore, setRequestMore] = useState(0);
  const audioChoice = settings.items.audio;
  const audioOn = (audioChoice?.status === "unconfirmed" ? audioChoice.value : settings.confirmed.audio) === "on";
  const internalClip = useSessionClipboard();
  const clip = clipboard ?? internalClip;
  const pumpActive = !!sessionId;
  const lastInputAt = useRef(0);
  const frames = useRcFrames(sessionId ?? "", canvasRef, {
    qualityHint,
    enabled: pumpActive,
    clockSkewMs: status?.clock_skew_ms,
    lastInputAt,
    // §17.3：等画面按阶段说实话（拨号/等对方批准/编码器起帧），
    // 文案在 lib/rcWaitStage——手机端此前只有一句静态「等待对方画面…」
    phase: status?.session?.phase,
  });
  const connection = useMobileConnectionInfo(sessionId, status, frames);
  // ① 连接建立阶段化（甲+乙稿）：发起链三段映射成水位/步进点；被控态回退现役卡。
  const connectStage = useMemo(
    () => rcConnectStage(status?.session?.phase, connection.pathKind, !!frames.waitHint),
    [status?.session?.phase, connection.pathKind, frames.waitHint],
  );
  const directToast = useDirectSwitchToast(connection);
  const acceptAuto = useCallback(() => { void settings.pick("quality", "auto"); }, [settings.pick]);
  const autoSuggest = useAutoSuggestToast(connection, quality, acceptAuto);
  const sandboxContent = useRef(contentSize ?? { w: 0, h: 0 });
  if (contentSize) sandboxContent.current = contentSize;
  const contentRef = pumpActive ? frames.contentRef : sandboxContent;
  const hasFrame = pumpActive ? frames.hasFrame : true;
  const modsComboRef = useRef<(() => void) | null>(null);
  const input = useRcMobileInput({
    canControl: canControl && !fileOpen && !connectionOpen && !panelOpen && !feedbackOpen,
    hasFrame: hasFrame && (!pumpActive || !frames.statusText),
    canvasRef,
    contentRef,
    onComboCompleted: () => modsComboRef.current?.(),
    lastInputAt,
  });
  const mods = useModifierKeys({ sendKeyDown: input.sendKeyDown, sendKeyUp: input.sendKeyUp });
  const sendFailure = useAcknowledgedSendFailure(pumpActive && input.sendFailed);
  modsComboRef.current = mods.releasePending;
  const { sendKeyDown, sendKeyUp, sendKeyPair, sendText, releaseAll } = input;
  const { keyboardOpen, toggleKeyboard } = useSoftKeyboardBridge({
    sendText,
    sendKeyDown,
    sendKeyUp,
    sendKeyPair,
    keyModeRef,
  });
  useEffect(() => {
    if (keyboardOpen && (!canControl || !hasFrame || (pumpActive && !!frames.statusText))) toggleKeyboard();
  }, [keyboardOpen, canControl, hasFrame, pumpActive, frames.statusText, toggleKeyboard]);

  const feedback = useMemo(
    () =>
      createTouchFeedback({
        surface: () => surfaceRef.current,
        cursorEl: () => cursorRef.current,
        chargeEl: () => chargeRef.current,
        classes: {
          ripple: styles.ripple,
          rippleRight: styles.rippleRight,
          rippleBig: styles.rippleBig,
          cursorRing: styles.cursorRing,
          cursorRingOn: styles.cursorRingOn,
          chargeRing: styles.chargeRing,
          chargeRingOn: styles.chargeRingOn,
          chargeRingDrag: styles.chargeRingDrag,
        },
      }),
    [],
  );

  const pointer = useSessionPointer({
    input,
    canvasRef,
    contentRef,
    surfaceRef,
    viewportRef,
    enabled: hasFrame && (!pumpActive || !frames.statusText) && !keyboardOpen && !panelOpen && !fileOpen && !connectionOpen && !feedbackOpen,
    canControl,
    releaseKeys: mods.releaseAll,
    feedback,
  });
  const capsule = useImmersiveCapsule({ keyboardOpen: keyboardOpen || panelOpen || fileOpen || connectionOpen || feedbackOpen || pointer.dragging || pointer.scrolling, attention: !!file?.asks.length || !!file?.error });
  const toggleTyping = () => {
    pointer.reset();
    toggleKeyboard();
  };
  const resetPointer = pointer.reset;
  const releaseModifiers = mods.releaseAll;
  const openConnection = useCallback((onBack?: () => void) => {
    // Header/badge DOM handlers can pass a click event; only a route callback is a source.
    connectionBack.current = typeof onBack === "function" ? onBack : undefined;
    resetPointer();
    if (keyboardOpen) toggleKeyboard();
    setConnectionOpen(true);
  }, [resetPointer, keyboardOpen, toggleKeyboard]);
  const closeConnection = useCallback(() => setConnectionOpen(false), []);
  const openScreen = () => { screenBack.current = undefined; setRequestScreen(n => n + 1); };
  const connectionQuality = useCallback(() => {
    setConnectionOpen(false);
    screenBack.current = () => { setConnectionOpen(true); };
    setRequestScreen((n) => n + 1);
  }, []);

  const pickKeyMode = useCallback(
    (mode: MobileKeyMode) => {
      releaseAll();
      releaseModifiers();
      void settings.pick("key_mode", mode);
    },
    [releaseAll, releaseModifiers, settings.pick],
  );
  const pickQuality = useCallback((next: MobileQuality) => {
    void settings.pick("quality", next);
  }, [settings.pick]);
  // 后台保活（2026-10-02）：进/出后台通知被控端挂起/恢复推流。
  // 🔴 心跳不在这里发——已下沉到发起端 Rust（outbound.rs `HEARTBEAT_PING_MS`），
  // WebView 随 Activity 暂停不再误断前台会话；后台场景由 BgPause 的 TTL 兜底。
  useRcBackgroundPause(sessionId ?? "");
  // 前台服务保活（B 方案，与上面叠加）：会话期间持前台服务，进程不被冻结
  // （桌面 no-op）。进会话开、卸载停——开关纪律见 useRcSessionKeepalive 注释。
  useRcSessionKeepalive(sessionId, title);
  const remoteCursor = useRemoteCursor({
    enabled: pumpActive,
    canvasRef,
    contentRef,
    cursorRef: remoteCursorRef,
    surfaceRef,
    onPosition: pointer.syncPosition,
  });
  const orient = useOrientationLock(sessionId);
  const toggleOrientation = useCallback(() => {
    resetPointer();
    if (capsule.landscape) void orient.exitLandscape();
    else void orient.enterLandscape();
  }, [capsule.landscape, orient, resetPointer]);
  useRcAudio(sessionId ?? "", pumpActive && audioOn);
  useEffect(() => {
    if (!pumpActive) return;
    void settings.pick("audio", "off");
  }, [pumpActive, sessionId, settings.pick]);

  const statusFeedback = <SessionStatusFeedback pointer={pointer} orient={orient} clipboard={clip} settings={settings}
    directToast={directToast} autoSuggest={autoSuggest} feedbackOpen={feedbackOpen}
    blocked={panelOpen || fileOpen || connectionOpen} onOpenChange={setFeedbackOpen} landscape={capsule.landscape}
    sendFailed={sendFailure.visible} onSendFailDismiss={sendFailure.dismiss} statusText={pumpActive ? frames.statusText : undefined}
    waitHint={frames.waitHint} hasFrame={hasFrame} keyboardOpen={keyboardOpen} toggleTyping={toggleTyping}
    onScreen={openScreen} onMore={() => setRequestMore(n => n + 1)} onReturn={() => setRequestEnd(n => n + 1)} />;
  const mouseAssist = <MouseAssist visible={pointer.mode !== "floating" && pointer.mouseOpen && !keyboardOpen && !panelOpen && !fileOpen && !connectionOpen && !feedbackOpen && canControl && hasFrame && (!pumpActive || !frames.statusText)}
    padOpen={pointer.padOpen} padRef={pointer.padRef} dragging={pointer.dragging} scrolling={pointer.scrolling}
    clickEnabled={pointer.clickEnabled}
    onClick={pointer.click} onDrag={pointer.toggleDrag} onScroll={pointer.toggleScroll} />;
  return (
    <div className={styles.root} data-landscape={capsule.landscape} data-keyboard={keyboardOpen} data-tools-expanded={capsule.capsuleVisible && !keyboardOpen} data-immersive={capsule.immersive}>
      {!capsule.landscape && <RcSessionHeader title={title} subtitle={subtitle} info={connection} onDetails={openConnection}
        onBack={() => setRequestEnd((n) => n + 1)} onScreen={openScreen} />}

      <div className={styles.controlArea} onPointerDownCapture={capsule.dismissHint}>
        <SessionScreen pointer={pointer} canControl={canControl} hasFrame={hasFrame}
          statusText={pumpActive ? frames.statusText : undefined} waitHint={frames.waitHint}
          stage={pumpActive ? connectStage : null} onReturn={() => setRequestEnd(n => n + 1)}
          blocked={keyboardOpen || panelOpen || fileOpen || connectionOpen || feedbackOpen} canvasRef={canvasRef} surfaceRef={surfaceRef}
          viewportRef={viewportRef} cursorRef={cursorRef} chargeRef={chargeRef} remoteCursorRef={remoteCursorRef}
          remoteShape={remoteCursor.shape} sandboxSize={pumpActive ? undefined : contentSize} />
        {(!capsule.landscape || pointer.padOpen) && mouseAssist}
      </div>

      {statusFeedback}

      {
        <ModifierKeyBar
          open={keyboardOpen}
          onHide={toggleTyping}
          onSendText={input.submitText}
          pending={mods.pending}
          onToggleMod={mods.toggle}
          onFunctionKey={(vk) => input.sendKeyPair(vk)}
          keyMode={keyMode}
          onPickKeyMode={pickKeyMode}
          setting={settings.items.key_mode} onRetryMode={() => void settings.retry("key_mode")}
        />
      }

      <SessionToolbar
        landscape={capsule.landscape}
        visible={capsule.landscape ? capsule.capsuleVisible : true}
        keyboardOn={keyboardOpen}
        onToggleKeyboard={toggleTyping}
        onResetZoom={() => viewportRef.current?.reset()}
        quality={quality}
        settings={settings}
        orientationHint={orient.hint}
        onOrientationHintDismiss={orient.clearHint}
        onPickQuality={pickQuality}
        audioOn={audioOn}
        onToggleAudio={() => void settings.pick("audio", audioOn ? "off" : "on")}
        onToggleOrientation={toggleOrientation}
        clipboard={clip}
        onEnd={onEnd}
        canControl={canControl}
        inputReady={hasFrame && (!pumpActive || !frames.statusText)}
        ending={ending}
        endError={endError}
        onPanelChange={setPanelOpen}
        pointerMode={pointer.mode}
        onPointerMode={pointer.pickMode}
        mouseOpen={pointer.mouseOpen}
        onToggleMouse={pointer.toggleMouse}
        onRevealTools={() => { pointer.reset(); capsule.toggle(); }}
        immersive={capsule.immersive}
        onImmersive={() => { pointer.reset(); capsule.enterImmersive(); }}
        onRestoreTools={() => { pointer.reset(); capsule.reveal(); }}
        toolHint={capsule.phase === "hint"}
        onRevealPointer={pointer.reveal}
        requestEnd={requestEnd}
        requestScreen={requestScreen}
        requestMore={requestMore}
        waiting={status?.session?.phase === "idle" || status?.session?.phase === "outbound_pending"}
        requestedScreenBack={screenBack.current}
        onConnectionDetails={openConnection}
        connectionEntry={<RcConnectionBadge info={connection} onOpen={openConnection} />}
        mouseAssist={capsule.landscape && !pointer.padOpen ? mouseAssist : undefined}
        fileEntry={file && (file.asks.length > 0 || file.error) ? <button type="button" className={styles.tbBtn} onClick={() => {
          pointer.reset(); if (keyboardOpen) toggleKeyboard(); setFileOpen(true);
        }}>文件{file.error ? " · 异常" : ` · ${file.asks.length}`}</button> : undefined}
      />
      {file && <SessionFileRequests file={file} open={fileOpen} onClose={() => setFileOpen(false)} />}
      <RcConnectionDetails open={connectionOpen} title={title} info={connection} quality={quality ?? "unknown"} onClose={closeConnection} onBack={connectionBack.current ? () => { closeConnection(); connectionBack.current?.(); } : undefined} onQuality={connectionQuality} />
    </div>
  );
}
