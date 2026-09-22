/**
 * RcSessionView — 会话壳。只做编排：调用 hooks、组合画面区与会话底栏。
 *
 * 拆分史（`.tsx ≤ 300` 红线）：
 * - 2026-09-18：抽出 RcScreenCanvas；
 * - 2026-09-21：抽出 useRcSessionPrefs / useRcSessionAudio / useRcDisplayMode 与
 *   RcSessionStage（原 394 行）。画面区块的 props 一律**整组**接收 hook 返回值
 *   （`input` / `link` / `frames`），不再逐个摊平——摊平只是把解构搬个家。
 *
 * 确认一律用 ConfirmDialog（非 window.confirm，见 lib/confirm）。
 */
import { useCallback, useRef, useState } from "react";
import { useToast } from "@/components/Toast";
import { confirmDialog } from "@/lib/confirm";
import type { RcSession } from "@/lib/api/rc";
import type { UseRc } from "@/hooks/useRc";
import { useRcFrames } from "@/hooks/useRcFrames";
import { useRcCursor } from "@/hooks/useRcCursor";
import { useRcInput } from "@/hooks/useRcInput";
import { useRcLinkState } from "@/hooks/useRcLinkState";
import { useRcSessionNotices } from "@/hooks/useRcSessionNotices";
import { useRcClipboardAuto } from "@/hooks/useRcClipboardAuto";
import { useRcSessionPrefs } from "@/hooks/useRcSessionPrefs";
import { useRcSessionAudio } from "@/hooks/useRcSessionAudio";
import { useRcDisplayMode } from "@/hooks/useRcDisplayMode";
import { RcSessionStage } from "./RcSessionStage";
import { RcSessionBar } from "./RcSessionBar";
import styles from "./RemoteComputer.module.css";

export function RcSessionView({
  session,
  busy,
  onEnd,
  onReconnect,
  onRequestControl,
  rc,
  quality,
  captureScope,
}: {
  session: RcSession;
  busy: boolean;
  onEnd: () => void;
  onReconnect?: () => void;
  /** B-1：会话内申请升级为可控。实现口径 = 结束当前会话 + 重新申请（重新协商式），
   *  复用 RemoteComputerDialog 既有的 end→request 链路；协议层无中途信令通道，
   *  无缝提权（B-2）明确不做，见 design/远程电脑-交互精简-B方案-设计稿.html §3。 */
  onRequestControl?: () => void;
  rc: UseRc;
  quality: string;
  captureScope: string;
}) {
  const { toast } = useToast();
  const [clipAuto, setClipAuto] = useState(false);
  const screenRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // P4：每次输入发出的本地时刻（useRcInput 写、useRcFrames 读），操作延迟 HUD 用
  const inputEpochRef = useRef(0);
  const canControl = session.capability === "control";

  // 显示模式（缩放 / 全屏 / 非全屏提示 + 换会话清理）、声音开关、会话内可调项
  // （画质 / 范围 / 码率）各自独立成 hook，见 hooks/useRc*.ts。
  const display = useRcDisplayMode(session.id, screenRef);
  const { audioOn, toggleAudio } = useRcSessionAudio(session.id, toast);
  const prefs = useRcSessionPrefs({
    sessionId: session.id,
    quality,
    captureScope,
    bitratePct: rc.status?.bitrate_pct,
    peerFps120: rc.status?.peer_fps120,
  });

  const frames = useRcFrames(session.id, canvasRef, {
    // P0-1 A3：时钟偏差校准（后端 pong 估算）；未校准时为 0，延迟显示带「≈」
    clockSkewMs: rc.status?.clock_skew_ms ?? 0,
    lastInputAt: inputEpochRef,
    // D4：fps120 档解码配置要抬 H.264 level（1080p120 超出 L4.2 规格）
    qualityHint: prefs.qPick,
  });
  // P1-6：远端光标形状（非箭头形状换用本地系统光标渲染）
  const cursorShape = useRcCursor(session.id);

  // C-UI3：自动同步剪贴板失败要说人话，禁止静默 catch。
  const onAutoFailToast = useCallback(
    (e: string) => toast(`自动同步剪贴板失败：${e}`, "error"),
    [toast],
  );
  // B5：基线由 hook 在开启时自动建立，这里只切开关，不手动 reset
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

  // B-1：会话内申请升级为可控。这条操作会断开当前画面，必须先确认。
  const requestControl = useCallback(async () => {
    if (!onRequestControl) return;
    const ok = await confirmDialog({
      title: "申请控制权",
      message:
        "将结束本次「只看」会话，并向对方重新申请「可控」。\n对方需要再次确认；同意后新会话可控制。",
      confirmText: "申请控制权",
    });
    if (ok) onRequestControl();
  }, [onRequestControl]);

  const input = useRcInput({
    canControl,
    hasFrame: frames.hasFrame,
    contentRef: frames.contentRef,
    canvasRef,
    screenRef,
    onConfirmEnd: () => void requestEnd(),
    fit: display.fit,
    // P4：fps120 档鼠标采样提到 8ms（datagram 不排队，纯采样密度问题）
    moveThrottleMs: prefs.qPick === "fps120" ? 8 : 16,
    inputEpochRef,
  });

  // 会话内不停发心跳（窗口失焦也发，否则对方 3.5s 后暂停推流，像断线）。
  // 活性判定 / 画面静止 / 操作未响应三条判据各用各的数据源，全在 hook 里。
  const link = useRcLinkState({
    sessionId: session.id,
    hasFrame: frames.hasFrame,
    lastFrameAt: frames.lastFrameAt,
    lastActionAt: input.lastActionAt,
    rttMs: rc.status?.rtt_ms ?? 0,
    backendPongMs: rc.status?.last_pong_ms ?? 0,
    reconnecting: busy,
  });

  // 会话内的一次性通知（对端注入失败 / 路径自动切换 relay↔直连）收口在 hook 里——
  // 这两条都是「说一次就够」的消息，留在会话壳里会把这个文件推过 300 行红线。
  const notify = useCallback((m: string, kind?: "error") => toast(m, kind), [toast]);
  useRcSessionNotices({
    pathNotice: rc.pathNotice,
    onPathConsumed: rc.clearPathNotice,
    notify,
  });

  return (
    <div className={styles.sessionWrap}>
      <RcSessionStage
        session={session}
        busy={busy}
        rc={rc}
        input={input}
        link={link}
        frames={frames}
        cursorShape={cursorShape}
        fit={display.fit}
        onFit={display.setFit}
        fullscreen={display.fullscreen}
        onToggleFullscreen={display.toggleFullscreen}
        fsHintDismissed={display.fsHintDismissed}
        onDismissFsHint={display.dismissFsHint}
        qPick={prefs.qPick}
        scopePick={prefs.scopePick}
        screenRef={screenRef}
        canvasRef={canvasRef}
        onReconnect={onReconnect}
        onRequestEnd={() => void requestEnd()}
      />

      {!canControl && onRequestControl && (
        <div className={styles.recentRow}>
          <button
            type="button"
            className={styles.miniBtnPri}
            disabled={busy}
            title="结束本次「只看」会话，重新以「可控」发起（对方需再次确认）"
            onClick={() => void requestControl()}
          >
            申请控制权
          </button>
          <span className={styles.meta}>重新申请期间画面会断开，对方确认后恢复</span>
        </div>
      )}
      {/* 会话内控制收进**一条**（方案 B）：原先是 qBar(remote) + ctrlBar + statusBar 三条
          各自带边框的横条，画质/画面还在侧栏有一组同名的。 */}
      <RcSessionBar
        rc={rc}
        canControl={canControl}
        quality={prefs.qPick}
        captureScope={prefs.scopePick}
        bitrate={prefs.bitratePick}
        onPickQuality={(k) => prefs.setQPick(k)}
        onPickScope={(s) => prefs.setScopePick(s)}
        onPickBitrate={(p) => prefs.setBitratePick(p)}
        audioOn={audioOn}
        onToggleAudio={toggleAudio}
        clipAuto={clipAuto}
        onToggleClipAuto={() => setClipAuto((v) => !v)}
        lastAutoAt={clip.lastAutoAt}
        autoFail={clip.autoFail}
        onStatus={(m, k) => toast(m, k)}
        kbOn={input.kbOn}
        pointerLocked={input.pointerLocked}
        fit={display.fit}
        sizeW={frames.size.w}
        frameIdleSec={link.frameIdleSec}
      />
    </div>
  );
}
