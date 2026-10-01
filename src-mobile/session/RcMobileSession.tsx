/**
 * RcMobileSession — 手机端会话壳（design/远程电脑-手机端-触摸语义与坐标系 §6）。
 *
 * 编排：PinchViewport（本地视野缩放）+ 触摸手势判定（touchClassifier）+
 * 事件发送（useRcMobileInput，桌面同口径）+ 修饰键条 + 软键盘桥 + 横屏沉浸
 * + **帧泵（useRcFrames，与桌面零差异的共享逻辑）** + 会话心跳（useRcHeartbeat）
 * + 音频（useRcAudio）。
 *
 * 两种画面源，同一壳：传 `sessionId` = 会话模式（泵/心跳/音频全开）；
 * 不传 = 沙盒模式（静态测试图，全部零 IPC），hasFrame 恒真。
 *
 * 🔴 输入分发顺序（design §5.5 红线，规则 11.1 收口）：顶缘热区判定（interceptDown）
 * → 手势状态机 → 远端。热区 tap 在 useTouchGestures 里被本地吃掉，绝不变成发给远端的左键。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRcFrames } from "@/hooks/useRcFrames";
import { useRcAudio } from "@/hooks/useRcAudio";
import { useRcHeartbeat } from "@/hooks/useRcHeartbeat";
import { PinchViewport, type PinchViewportHandle } from "../video/PinchViewport";
import { VideoSurface } from "../video/VideoSurface";
import { useTouchGestures } from "./useTouchGestures";
import { useRcMobileInput, sendEvent } from "./useRcMobileInput";
import { useModifierKeys } from "./useModifierKeys";
import { useImmersiveCapsule } from "./useImmersiveCapsule";
import { useOrientationLock } from "./useOrientationLock";
import { useSoftKeyboardBridge } from "./useSoftKeyboardBridge";
import { createTouchFeedback } from "./touchFeedback";
import { useSessionClipboard } from "./useSessionClipboard";
import { SessionToolbar, type MobileKeyMode } from "./SessionToolbar";
import { ModifierKeyBar } from "./ModifierKeyBar";
import styles from "./RcMobileSession.module.css";

const QUALITY_CYCLE = ["sharp", "balanced", "smooth"] as const;

export function RcMobileSession({
  title,
  subtitle,
  canvasRef,
  sessionId,
  contentSize,
  qualityHint,
  canControl = true,
  onEnd,
}: {
  title: string;
  subtitle?: string;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** 会话模式：帧泵以此为键开跑。缺省 = 沙盒模式（静态画布，泵关）。 */
  sessionId?: string;
  /** 沙盒模式：静态测试图尺寸（会话模式忽略，帧分辨率由解码 sink 写）。 */
  contentSize?: { w: number; h: number };
  /** D4：画质档名进解码配置（fps>60 抬 H.264 level）。 */
  qualityHint?: string;
  canControl?: boolean;
  onEnd: () => void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<PinchViewportHandle>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const chargeRef = useRef<HTMLDivElement>(null);

  const [keyMode, setKeyMode] = useState<MobileKeyMode>("type");
  const keyModeRef = useRef(keyMode);
  keyModeRef.current = keyMode;
  const [quality, setQuality] = useState<(typeof QUALITY_CYCLE)[number]>("balanced");
  /**
   * 会话音频，手机端**默认关**——公共场合突然外放电脑声音是事故，与桌面
   * 「默认开」是刻意的分歧。用户点「声音」才听。沙盒模式恒关。
   */
  const [audioOn, setAudioOn] = useState(false);
  const clip = useSessionClipboard();

  // ── 画面源：共享帧泵（会话）或静态画布（沙盒）──
  const pumpActive = !!sessionId;
  const frames = useRcFrames(sessionId ?? "", canvasRef, { qualityHint, enabled: pumpActive });
  const sandboxContent = useRef(contentSize ?? { w: 0, h: 0 });
  if (contentSize) sandboxContent.current = contentSize;
  // 归一化几何的内容尺寸：会话模式跟泵走（帧分辨率），沙盒模式静态
  const contentRef = pumpActive ? frames.contentRef : sandboxContent;
  const hasFrame = pumpActive ? frames.hasFrame : true;

  // 组合完成回调的晚绑定：input 先建、mods 后建，ref 每渲染接一次
  const modsComboRef = useRef<(() => void) | null>(null);
  const input = useRcMobileInput({
    canControl,
    hasFrame,
    canvasRef,
    contentRef,
    onComboCompleted: () => modsComboRef.current?.(),
  });
  const mods = useModifierKeys({ sendKeyDown: input.sendKeyDown, sendKeyUp: input.sendKeyUp });
  modsComboRef.current = mods.releasePending;
  const { sendKeyDown, sendKeyUp, sendKeyPair, sendText, releaseAll } = input;

  // ── 软键盘桥：挂载/销毁/键盘开合收口在 hook；打字/直控档经 keyModeRef 晚绑定 ──
  const { keyboardOpen, toggleKeyboard } = useSoftKeyboardBridge({
    sendText,
    sendKeyDown,
    sendKeyUp,
    sendKeyPair,
    keyModeRef,
  });

  const capsule = useImmersiveCapsule({ keyboardOpen });

  // ── 本地触摸反馈：纯 DOM 直写（60fps 热路径，不进 React 渲染）──
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

  // ── 手势 → 远端事件 + 反馈（判定结果的唯一消费点）──
  const gestures = useTouchGestures({
    surfaceRef,
    enabled: true,
    interceptDown: (cx, cy) =>
      capsule.interceptDown(cy, surfaceRef.current?.getBoundingClientRect().top ?? 0),
    callbacks: {
      onTap: (x, y, isDouble) => {
        input.sendClick(1, x, y);
        feedback.ripple(x, y, isDouble ? "big" : "left");
        feedback.cursorOn(x, y);
      },
      onMoveTo: (x, y) => {
        input.queueMove(x, y);
        feedback.cursorOn(x, y);
      },
      onCharge: (x, y) => {
        navigator.vibrate?.(20);
        feedback.charge("on", x, y);
      },
      onChargeCancel: () => feedback.charge("off"),
      onRightClick: (x, y) => {
        input.sendClick(2, x, y);
        feedback.ripple(x, y, "right");
        feedback.charge("off");
      },
      onDragStart: (x, y) => {
        input.dragDown(x, y);
        feedback.cursorOn(x, y);
        feedback.charge("drag", x, y);
      },
      onDragMove: (x, y) => {
        input.queueMove(x, y);
        feedback.cursorOn(x, y);
      },
      onDragEnd: (x, y) => {
        input.dragUp(x, y);
        feedback.charge("off");
      },
      onScrollDelta: (dx, dy, mx, my) => input.scrollByFrame(dx, dy, mx, my),
      onPinchStart: () => {},
      onPinchUpdate: (ratio, dx, dy, mx, my) =>
        viewportRef.current?.applyPinch(ratio, dx, dy, mx, my),
    },
  });

  // ── 兜底：失焦 / 旋转 / 隐藏 → 全量补发 up + 状态机复位（design §4.3）──
  // 依赖全为稳定引用（useCallback 成员），整条 effect 生命周期只订阅一次
  const { cancelAll } = gestures;
  useEffect(() => {
    const release = () => {
      releaseAll();
      mods.releaseAll();
      cancelAll();
      feedback.charge("off");
    };
    window.addEventListener("blur", release);
    window.addEventListener("orientationchange", release);
    return () => {
      window.removeEventListener("blur", release);
      window.removeEventListener("orientationchange", release);
    };
  }, [releaseAll, mods, cancelAll, feedback]);

  const pickKeyMode = useCallback((mode: MobileKeyMode) => {
    setKeyMode(mode);
    sendEvent({ kind: "set_key_mode", mode });
  }, []);
  const cycleQuality = useCallback(() => {
    setQuality((q) => {
      const next = QUALITY_CYCLE[(QUALITY_CYCLE.indexOf(q) + 1) % QUALITY_CYCLE.length];
      sendEvent({ kind: "set_quality", quality: next });
      return next;
    });
  }, []);

  // ── 会话心跳：被控端 3.5s 无心跳停推帧、15s 判失联收口（漏发 ping = 真机「15 秒必断」根因）
  useRcHeartbeat(sessionId ?? "");

  // ── 横屏按钮：竖屏点「横屏」进沉浸，横屏点「竖屏」还原（2026-10-01 用户拍板）。
  const orient = useOrientationLock();
  const toggleOrientation = useCallback(
    () => (capsule.landscape ? orient.exitLandscape() : void orient.enterLandscape()),
    [capsule.landscape, orient],
  );

  // ── 会话音频：audio_on 事件 + 本地泵；挂载同步一次开关（桌面纪律①），副作用收进 effect。
  useRcAudio(sessionId ?? "", pumpActive && audioOn);
  useEffect(() => {
    if (!pumpActive) return;
    sendEvent({ kind: "audio_on", on: audioOn });
  }, [pumpActive, audioOn]);

  return (
    <div className={styles.root}>
      {!capsule.landscape && (
        <header className={styles.statusRow}>
          <span className={styles.statusDot} aria-hidden="true" />
          <span className={styles.statusTitle}>{title}</span>
          {subtitle && <span className={styles.statusSub}>{subtitle}</span>}
        </header>
      )}

      <div className={styles.screenArea}>
        <PinchViewport ref={viewportRef} surfaceRef={surfaceRef}>
          <VideoSurface
            canvasRef={canvasRef}
            className={styles.canvas}
            statusText={frames.statusText}
            showStatus={pumpActive}
            sandboxSize={pumpActive ? undefined : contentSize}
          />
        </PinchViewport>
        <div ref={cursorRef} className={styles.cursorRing} aria-hidden="true" />
        <div ref={chargeRef} className={styles.chargeRing} aria-hidden="true" />
      </div>

      {keyboardOpen && (
        <ModifierKeyBar
          pending={mods.pending}
          onToggleMod={mods.toggle}
          onFunctionKey={(vk) => input.sendKeyPair(vk)}
          keyMode={keyMode}
          onPickKeyMode={pickKeyMode}
        />
      )}

      <SessionToolbar
        landscape={capsule.landscape}
        visible={capsule.landscape ? capsule.capsuleVisible : true}
        keyboardOn={keyboardOpen}
        onToggleKeyboard={toggleKeyboard}
        onResetZoom={() => viewportRef.current?.reset()}
        quality={quality}
        onCycleQuality={cycleQuality}
        audioOn={audioOn}
        onToggleAudio={() => setAudioOn((on) => !on)}
        onToggleOrientation={toggleOrientation}
        hint={orient.hint || clip.hint}
        clipOpen={clip.clipOpen}
        onToggleClip={clip.toggleClip}
        onClipPush={() => void clip.push()}
        onClipPull={() => void clip.pull()}
        onEnd={onEnd}
        onInteract={capsule.keepAlive}
      />
    </div>
  );
}
