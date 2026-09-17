/**
 * RcSessionView — 会话壳。确认用 ConfirmDialog（非 window.confirm）。
 * 1:1 可横向/纵向滚动平移；画面停滞与自动剪贴板失败可见。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import { confirmDialog } from "@/lib/confirm";
import { rcSendInput } from "@/lib/api/rc";
import type { RcSession } from "@/lib/api/rc";
import type { UseRc } from "@/hooks/useRc";
import { keyToVk, shouldForwardToRemote } from "@/lib/rcKeyMap";
import { isSessionEscape, shouldSwallowEscape } from "@/lib/rcKeyGuard";
import { useRcFrames } from "@/hooks/useRcFrames";
import { useRcInput, releaseModifiers } from "@/hooks/useRcInput";
import { useRcLinkState } from "@/hooks/useRcLinkState";
import { useRcSessionNotices } from "@/hooks/useRcSessionNotices";
import { useRcClipboardAuto } from "@/hooks/useRcClipboardAuto";
import type { FitMode } from "@/lib/rcSessionStats";
import { qualityLabel } from "@/lib/rcSessionStats";
import { RcHud } from "./RcHud";
import { RcViewTools } from "./RcViewTools";
import { RcClipboardBar } from "./RcClipboardBar";
import { RcQualityBar } from "./RcQualityBar";
import { RcSessionTop } from "./RcSessionTop";
import { RcStatusBar } from "./RcStatusBar";
import { canvasStyleFor } from "./rcCanvasStyle";
import styles from "./RemoteComputer.module.css";

export function RcSessionView({
  session,
  busy,
  onEnd,
  onReconnect,
  rc,
  quality,
  captureScope,
}: {
  session: RcSession;
  busy: boolean;
  onEnd: () => void;
  onReconnect?: () => void;
  rc: UseRc;
  quality: string;
  captureScope: string;
}) {
  const { toast } = useToast();
  const [clipAuto, setClipAuto] = useState(false);
  const [qPick, setQPick] = useState(quality);
  const [scopePick, setScopePick] = useState(captureScope);
  const [fit, setFit] = useState<FitMode>("fit");
  const [fullscreen, setFullscreen] = useState(false);
  const screenRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canControl = session.capability === "control";

  const { hasFrame, statusText, codec, fps, contentRef, lastFrameAt, size } = useRcFrames(
    session.id,
    canvasRef,
  );

  const onAutoFailToast = useCallback(
    (e: string) => toast(`自动同步剪贴板失败：${e}`, "error"),
    [toast],
  );
  const clip = useRcClipboardAuto({
    enabled: clipAuto,
    canControl,
    sessionId: session.id,
    onFailToast: onAutoFailToast,
  });

  const requestEnd = useCallback(async () => {
    const ok = await confirmDialog({
      title: "结束远程会话",
      message: "将断开与对方的画面与控制。对方也会立刻失去连接。",
      confirmText: "结束会话",
      variant: "danger",
    });
    if (ok) onEnd();
  }, [onEnd]);

  const input = useRcInput({
    canControl,
    hasFrame,
    contentRef,
    canvasRef,
    screenRef,
    onConfirmEnd: () => void requestEnd(),
    fit,
  });
  useEffect(() => {
    setQPick(quality);
    setScopePick(captureScope);
  }, [session.id, quality, captureScope]);
  // 会话内不停发心跳（窗口失焦也发，否则对方 3.5s 后暂停推流，像断线）。
  // 活性判定 / 画面静止 / 操作未响应三条判据各用各的数据源，全在 hook 里。
  const link = useRcLinkState({
    sessionId: session.id,
    hasFrame,
    lastFrameAt,
    lastActionAt: input.lastActionAt,
    rttMs: rc.status?.rtt_ms ?? 0,
    backendPongMs: rc.status?.last_pong_ms ?? 0,
    reconnecting: busy,
  });
  // 会话结束 / 换会话时补发 key-up 与鼠标松开，防止对端键卡住
  useEffect(() => {
    return () => {
      void releaseModifiers();
    };
  }, [session.id]);
  const toggleFullscreen = useCallback(() => {
    const el = screenRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen().catch(() => {});
  }, []);
  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // 会话内的一次性通知（对端注入失败 / 路径自动切换 relay↔直连）收口在 hook 里——
  // 这两条都是「说一次就够」的消息，留在会话壳里会把这个文件推过 300 行红线。
  const notify = useCallback((m: string, kind?: "error") => toast(m, kind), [toast]);
  useRcSessionNotices({
    pathNotice: rc.pathNotice,
    onPathConsumed: rc.clearPathNotice,
    notify,
  });

  const placeholderSub =
    codec === "h264"
      ? "对方正在用 H.264 推流"
      : `对方编码中 · ${qualityLabel(qPick)}档`;
  const canvasStyle = canvasStyleFor(fit, size, canControl);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!canControl || !input.kbOn) return;
    // 捕获态下 Esc 本地消费：不转发给对端，交给 window 两级 Esc 处理
    if (isSessionEscape(e) && shouldSwallowEscape(input.kbOn, input.pointerLocked, canControl)) return;
    if (!shouldForwardToRemote(e)) return;
    const vk = keyToVk(e);
    if (vk == null) return;
    e.preventDefault();
    e.stopPropagation();
    input.noteAction();
    void rcSendInput({ kind: "key", vk, down: true });
  };
  const onKeyUp = (e: React.KeyboardEvent) => {
    if (!canControl || !input.kbOn) return;
    if (isSessionEscape(e) && shouldSwallowEscape(input.kbOn, input.pointerLocked, canControl)) return;
    const vk = keyToVk(e);
    if (vk == null) return;
    e.preventDefault();
    e.stopPropagation();
    void rcSendInput({ kind: "key", vk, down: false });
  };

  return (
    <div className={styles.viewShell}>
      <RcSessionTop
        session={session}
        canControl={canControl}
        kbOn={input.kbOn}
        linkState={link.state}
        unansweredSec={link.unansweredSec}
        busy={busy}
        onReleaseKb={input.releaseKb}
        onReconnect={onReconnect}
        onRequestEnd={() => void requestEnd()}
      />

      <div
        ref={screenRef}
        className={input.kbOn ? `${styles.fakeScreen} ${styles.fakeScreenKb}` : styles.fakeScreen}
        tabIndex={canControl ? 0 : -1}
        onFocus={() => {
          if (canControl) input.setKbOn(true);
        }}
        onBlur={() => {
          if (canControl) {
            input.setKbOn(false);
            void releaseModifiers();
          }
        }}
        onMouseDown={() => {
          if (canControl) screenRef.current?.focus();
        }}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
      >
        <RcViewTools
          fit={fit}
          onFit={setFit}
          pointerLocked={input.pointerLocked}
          onTogglePointer={input.togglePointerLock}
          canControl={canControl}
          fullscreen={fullscreen}
          onToggleFullscreen={toggleFullscreen}
        />
        <div
          className={fit === "actual" ? styles.panBox : styles.fitBox}
          style={fit === "actual" ? undefined : { width: "100%", height: "100%" }}
        >
          <canvas
            ref={canvasRef}
            className={styles.screenCanvas}
            style={canvasStyle}
            onContextMenu={(e) => e.preventDefault()}
            onMouseMove={(e) => {
              if (!canControl || !hasFrame || input.pointerLocked) return;
              const r = input.norm(e);
              if (r) input.queueMove(r.x, r.y);
            }}
            onMouseDown={(e) => input.sendButton(e, true)}
            onMouseUp={(e) => input.sendButton(e, false)}
            onWheel={(e) => {
              if (!canControl || !hasFrame) return;
              const r = input.norm(e);
              if (!r) return;
              // 触控板横滑：优先水平分量，否则回退竖直
              const axis = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
              input.noteAction();
              void rcSendInput({
                kind: "wheel",
                x: r.x,
                y: r.y,
                delta: axis > 0 ? -120 : 120,
              });
            }}
          />
        </div>
        {!hasFrame && (
          <div className={styles.placeholder}>
            <Loader2 size={22} className={styles.spin} />
            <div>{statusText || "等待对方画面…"}</div>
            <div className={styles.placeholderSub}>{placeholderSub}</div>
          </div>
        )}
        <RcHud
          codec={codec}
          fps={fps}
          rttMs={link.rttMs}
          quality={qPick}
          scope={scopePick}
          linkState={link.state}
          pathKind={rc.status?.path_kind ?? ""}
          unansweredSec={link.unansweredSec}
          pointerLocked={input.pointerLocked}
        />
      </div>

      {canControl && (
        <>
          <RcClipboardBar
            clipAuto={clipAuto}
            onToggleAuto={() => {
              // B5：基线由 hook 在开启时自动建立，这里只切开关，不手动 reset
              setClipAuto((v) => !v);
            }}
            lastAutoAt={clip.lastAutoAt}
            autoFail={clip.autoFail}
            onStatus={(m, k) => toast(m, k)}
          />
          <RcStatusBar
            kbOn={input.kbOn}
            pointerLocked={input.pointerLocked}
            fit={fit}
            sizeW={size.w}
            frameIdleSec={link.frameIdleSec}
            unansweredSec={link.unansweredSec}
          />
        </>
      )}
      <RcQualityBar
        rc={rc}
        quality={qPick}
        captureScope={scopePick}
        mode="remote"
        onPickQuality={(k) => setQPick(k)}
        onPickScope={(s) => setScopePick(s)}
      />
    </div>
  );
}
