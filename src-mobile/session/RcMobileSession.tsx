import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRcFrames } from "@/hooks/useRcFrames";
import { useRcAudio } from "@/hooks/useRcAudio";
import { useRcBackgroundPause } from "@/hooks/useRcBackgroundPause";
import { useRcSessionKeepalive } from "./useRcSessionKeepalive";
import { normalizeMobileQuality, type MobileQuality } from "./qualityCycle";
import type { PinchViewportHandle } from "../video/PinchViewport";
import { useSessionPointer } from "./useSessionPointer";
import { MouseAssist } from "./MouseAssist";
import { RcSessionHeader } from "./RcSessionHeader";
import { RcConnectionBadge, RcConnectionDetails } from "./RcConnectionDetails";
import { useMobileConnectionInfo } from "./useMobileConnectionInfo";
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
import { SessionFeedback } from "./SessionFeedback";
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

  const [keyMode, setKeyMode] = useState<MobileKeyMode>("type");
  const keyModeRef = useRef(keyMode);
  keyModeRef.current = keyMode;
  // 画质：手机就是编码端，档位决定它发什么。hint 可能迟到（状态轮询）或中途被
  // 电脑端改档，变了就跟着对齐；用户本地已选的档在 hint 不变时不被覆盖。
  const [quality, setQuality] = useState<MobileQuality>(() => normalizeMobileQuality(qualityHint));
  useEffect(() => {
    setQuality(normalizeMobileQuality(qualityHint));
  }, [qualityHint]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [fileOpen, setFileOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [requestEnd, setRequestEnd] = useState(0);
  const [requestScreen, setRequestScreen] = useState(0);
  const [audioOn, setAudioOn] = useState(false);
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
  const sandboxContent = useRef(contentSize ?? { w: 0, h: 0 });
  if (contentSize) sandboxContent.current = contentSize;
  const contentRef = pumpActive ? frames.contentRef : sandboxContent;
  const hasFrame = pumpActive ? frames.hasFrame : true;
  const modsComboRef = useRef<(() => void) | null>(null);
  const input = useRcMobileInput({
    canControl: canControl && !fileOpen && !connectionOpen && !panelOpen,
    hasFrame: hasFrame && (!pumpActive || !frames.statusText),
    canvasRef,
    contentRef,
    onComboCompleted: () => modsComboRef.current?.(),
    lastInputAt,
  });
  const mods = useModifierKeys({ sendKeyDown: input.sendKeyDown, sendKeyUp: input.sendKeyUp });
  modsComboRef.current = mods.releasePending;
  // 发送失败横幅（规则 15.3）：失败点亮；用户关掉后，恢复成功→再次失败才重新出现。
  const [sendFailAck, setSendFailAck] = useState(false);
  useEffect(() => {
    if (!input.sendFailed) setSendFailAck(false);
  }, [input.sendFailed]);
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

  const capsule = useImmersiveCapsule({ keyboardOpen: keyboardOpen || panelOpen || fileOpen || connectionOpen });
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
    enabled: hasFrame && (!pumpActive || !frames.statusText) && !panelOpen && !fileOpen && !connectionOpen,
    canControl,
    releaseKeys: mods.releaseAll,
    feedback,
  });
  const toggleTyping = () => {
    pointer.reset();
    toggleKeyboard();
  };
  const resetPointer = pointer.reset;
  const releaseModifiers = mods.releaseAll;
  const openConnection = useCallback(() => {
    resetPointer();
    if (keyboardOpen) toggleKeyboard();
    setConnectionOpen(true);
  }, [resetPointer, keyboardOpen, toggleKeyboard]);
  const closeConnection = useCallback(() => setConnectionOpen(false), []);
  const connectionQuality = useCallback(() => {
    setConnectionOpen(false);
    setRequestScreen((n) => n + 1);
  }, []);

  const pickKeyMode = useCallback(
    (mode: MobileKeyMode) => {
      releaseAll();
      releaseModifiers();
      setKeyMode(mode);
      input.sendRaw({ kind: "set_key_mode", mode });
    },
    [releaseAll, releaseModifiers, input.sendRaw],
  );
  const pickQuality = useCallback((next: MobileQuality) => {
    setQuality(next);
    input.sendRaw({ kind: "set_quality", quality: next });
  }, [input.sendRaw]);
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
  const orient = useOrientationLock();
  const toggleOrientation = useCallback(() => {
    resetPointer();
    if (capsule.landscape) orient.exitLandscape();
    else void orient.enterLandscape();
  }, [capsule.landscape, orient, resetPointer]);
  useRcAudio(sessionId ?? "", pumpActive && audioOn);
  useEffect(() => {
    if (!pumpActive) return;
    input.sendRaw({ kind: "audio_on", on: audioOn });
  }, [pumpActive, audioOn, input.sendRaw]);

  const mouseAssist = <MouseAssist visible={pointer.mouseOpen && !keyboardOpen && !panelOpen && !fileOpen && !connectionOpen && canControl && hasFrame && (!pumpActive || !frames.statusText)}
    padOpen={pointer.padOpen} padRef={pointer.padRef} dragging={pointer.dragging} scrolling={pointer.scrolling}
    onClick={pointer.click} onDrag={pointer.toggleDrag} onScroll={pointer.toggleScroll} />;
  return (
    <div className={styles.root} data-landscape={capsule.landscape} data-keyboard={keyboardOpen}>
      {!capsule.landscape && <RcSessionHeader title={title} subtitle={subtitle} info={connection} onDetails={openConnection}
        onBack={() => setRequestEnd((n) => n + 1)} onScreen={() => setRequestScreen((n) => n + 1)} />}

      <div className={styles.feedbackSlot}>
        <SessionFeedback pointer={pointer} orient={orient} clipboard={clip}
          sendFailed={pumpActive && input.sendFailed && !sendFailAck}
          onSendFailDismiss={() => setSendFailAck(true)}
          teach={capsule.phase === "teaching"
            ? { secondsLeft: capsule.secondsLeft, onEnd: capsule.endTeaching }
            : undefined} />
        {file && <SessionFileRequests file={file} open={fileOpen} onClose={() => setFileOpen(false)} onOpen={() => {
          pointer.reset();
          if (keyboardOpen) toggleKeyboard();
          setFileOpen(true);
        }} />}
      </div>
      <div className={styles.controlArea} onPointerDownCapture={capsule.dismissHint}>
        <SessionScreen pointer={pointer} canControl={canControl} hasFrame={hasFrame}
          statusText={pumpActive ? frames.statusText : undefined} waitHint={frames.waitHint} onReturn={() => setRequestEnd(n => n + 1)}
          blocked={keyboardOpen || panelOpen || fileOpen || connectionOpen} canvasRef={canvasRef} surfaceRef={surfaceRef}
          viewportRef={viewportRef} cursorRef={cursorRef} chargeRef={chargeRef} remoteCursorRef={remoteCursorRef}
          remoteShape={remoteCursor.shape} sandboxSize={pumpActive ? undefined : contentSize} />
        {(!capsule.landscape || pointer.padOpen) && mouseAssist}
      </div>

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
        />
      }

      <SessionToolbar
        landscape={capsule.landscape}
        visible={capsule.landscape ? capsule.capsuleVisible : true}
        keyboardOn={keyboardOpen}
        onToggleKeyboard={toggleTyping}
        onResetZoom={() => viewportRef.current?.reset()}
        quality={quality}
        onPickQuality={pickQuality}
        audioOn={audioOn}
        onToggleAudio={() => setAudioOn((on) => !on)}
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
        onRevealTools={capsule.toggle}
        toolHint={capsule.phase === "hint"}
        onRevealPointer={pointer.reveal}
        requestEnd={requestEnd}
        requestScreen={requestScreen}
        onConnectionDetails={openConnection}
        connectionEntry={<RcConnectionBadge info={connection} onOpen={openConnection} />}
        mouseAssist={capsule.landscape && !pointer.padOpen ? mouseAssist : undefined}
      />
      <RcConnectionDetails open={connectionOpen} title={title} info={connection} quality={quality} onClose={closeConnection} onQuality={connectionQuality} />
    </div>
  );
}
