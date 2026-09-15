/**
 * RcSessionView — 会话壳。确认用 ConfirmDialog（非 window.confirm）。
 * 1:1 可横向/纵向滚动平移；画面停滞与自动剪贴板失败可见。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useToast } from "@/components/Toast";
import { useWindowVisible } from "@/hooks/useWindowVisible";
import { confirmDialog } from "@/lib/confirm";
import { rcSendInput } from "@/lib/api/rc";
import type { RcSession } from "@/lib/api/rc";
import type { UseRc } from "@/hooks/useRc";
import { keyToVk, shouldForwardToRemote } from "@/lib/rcKeyMap";
import { useRcFrames } from "@/hooks/useRcFrames";
import { useRcInput, releaseModifiers } from "@/hooks/useRcInput";
import { useRcClipboardAuto } from "@/hooks/useRcClipboardAuto";
import type { FitMode } from "@/lib/rcSessionStats";
import { RcHud } from "./RcHud";
import { RcViewTools } from "./RcViewTools";
import { RcClipboardBar } from "./RcClipboardBar";
import { RcQualityBar } from "./RcQualityBar";
import { RcSessionTop } from "./RcSessionTop";
import styles from "./RemoteComputer.module.css";

const FIT_CSS: Record<FitMode, "contain" | "none" | "cover"> = {
  fit: "contain",
  actual: "none",
  fill: "cover",
};

function canvasStyleFor(
  fit: FitMode,
  size: { w: number; h: number },
  canControl: boolean,
): React.CSSProperties {
  const cursor = canControl ? "crosshair" : "default";
  if (fit === "actual") {
    return {
      width: size.w || undefined,
      height: size.h || undefined,
      maxWidth: "none",
      maxHeight: "none",
      imageRendering: "pixelated",
      cursor,
    };
  }
  return { width: "100%", height: "100%", objectFit: FIT_CSS[fit], cursor };
}

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
  const visible = useWindowVisible();
  const [clipAuto, setClipAuto] = useState(false);
  const [qPick, setQPick] = useState(quality);
  const [scopePick, setScopePick] = useState(captureScope);
  const [fit, setFit] = useState<FitMode>("fit");
  const [rttMs, setRttMs] = useState(0);
  const [heartbeatOk, setHeartbeatOk] = useState(true);
  const [stalled, setStalled] = useState(false);
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
  });

  useEffect(() => {
    setQPick(quality);
    setScopePick(captureScope);
  }, [session.id, quality, captureScope]);

  // 心跳 + RTT
  useEffect(() => {
    if (!visible) return;
    const t = window.setInterval(() => {
      void rcSendInput({ kind: "ping", ts: Date.now() }).catch(() => {
        setHeartbeatOk(false);
      });
    }, 1000);
    return () => window.clearInterval(t);
  }, [visible, session.id]);

  useEffect(() => {
    const r = rc.status?.rtt_ms ?? 0;
    if (r > 0) {
      setRttMs(r);
      setHeartbeatOk(true);
    } else if (hasFrame) {
      setHeartbeatOk(true);
    }
  }, [rc.status?.rtt_ms, hasFrame]);

  // 画面停滞检测：有帧之后超过 2.5s 没更新
  useEffect(() => {
    const t = window.setInterval(() => {
      const at = lastFrameAt.current;
      setStalled(hasFrame && at > 0 && Date.now() - at > 2500);
    }, 500);
    return () => window.clearInterval(t);
  }, [hasFrame, lastFrameAt]);

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

  useEffect(() => {
    let off: (() => void) | undefined;
    let last = "";
    void listen<string>("rc-inject-error", (e) => {
      const msg = e.payload;
      if (!msg || msg === last) return;
      last = msg;
      toast(`对方未能注入输入：${msg}`, "error");
    }).then((f) => { off = f; });
    return () => off?.();
  }, [toast]);

  const placeholderSub =
    codec === "h264"
      ? "对方正在用 H.264 推流"
      : `对方编码中 · ${qPick === "sharp" ? "清晰" : qPick === "smooth" ? "流畅" : "均衡"}档`;
  const canvasStyle = canvasStyleFor(fit, size, canControl);

  return (
    <div className={styles.viewShell}>
      <RcSessionTop
        session={session}
        canControl={canControl}
        kbOn={input.kbOn}
        stalled={stalled}
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
        onKeyDown={(e) => {
          if (!canControl || !input.kbOn) return;
          if (!shouldForwardToRemote(e)) return;
          const vk = keyToVk(e);
          if (vk == null) return;
          e.preventDefault();
          e.stopPropagation();
          void rcSendInput({ kind: "key", vk, down: true });
        }}
        onKeyUp={(e) => {
          if (!canControl || !input.kbOn) return;
          const vk = keyToVk(e);
          if (vk == null) return;
          e.preventDefault();
          e.stopPropagation();
          void rcSendInput({ kind: "key", vk, down: false });
        }}
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
              void rcSendInput({
                kind: "wheel",
                x: r.x,
                y: r.y,
                delta: e.deltaY > 0 ? -120 : 120,
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
          rttMs={rttMs}
          quality={qPick}
          scope={scopePick}
          heartbeatOk={heartbeatOk && !stalled}
          pointerLocked={input.pointerLocked}
        />
      </div>

      {canControl && (
        <>
          <RcClipboardBar
            clipAuto={clipAuto}
            onToggleAuto={() => {
              setClipAuto((v) => {
                if (!v) clip.resetBaseline();
                return !v;
              });
            }}
            lastAutoAt={clip.lastAutoAt}
            autoFail={clip.autoFail}
            onStatus={(m, k) => toast(m, k)}
          />
          <div className={styles.statusBar}>
            <span>
              {input.kbOn
                ? "键盘已捕获 · Esc 先释放，再按确认结束"
                : "点画面捕获键盘 · 系统键无法注入"}
            </span>
            {input.pointerLocked && <span> · 指针已锁定 · Esc 或按钮解除</span>}
            {fit === "actual" && size.w > 0 && <span> · 1:1 可拖动滚动条平移</span>}
            {stalled && <span className={styles.fbBad}> · 画面超过 2.5s 未更新</span>}
          </div>
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
