/**
 * RcSessionView — 会话壳。确认用 ConfirmDialog（非 window.confirm）。
 * 1:1 可横向/纵向滚动平移；画面停滞与自动剪贴板失败可见。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, Loader2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import { confirmDialog } from "@/lib/confirm";
import type { RcSession } from "@/lib/api/rc";
import type { UseRc } from "@/hooks/useRc";
import { useRcFrames } from "@/hooks/useRcFrames";
import { useRcCursor } from "@/hooks/useRcCursor";
import { useRcInput, releaseModifiers } from "@/hooks/useRcInput";
import { useRcLinkState } from "@/hooks/useRcLinkState";
import { useRcSessionNotices } from "@/hooks/useRcSessionNotices";
import { useRcClipboardAuto } from "@/hooks/useRcClipboardAuto";
import type { FitMode } from "@/lib/rcSessionStats";
import { qualityLabel } from "@/lib/rcQuality";
import { RcHud } from "./RcHud";
import { RcViewTools } from "./RcViewTools";
import { RcSessionTop } from "./RcSessionTop";
import { RcSessionBar } from "./RcSessionBar";
import { RcScreenCanvas } from "./RcScreenCanvas";
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
  const [qPick, setQPick] = useState(quality);
  const [scopePick, setScopePick] = useState(captureScope);
  // Q5：码率倍率。初值取本机配置（后端在会话建立时已把该值推给被控端，
  // 所以下拉显示的就是生效值）；会话内改下拉会同步对方并回写配置。
  const [bitratePick, setBitratePick] = useState(rc.status?.bitrate_pct ?? 100);
  const [fit, setFit] = useState<FitMode>("fit");
  const [fullscreen, setFullscreen] = useState(false);
  const screenRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // P4：每次输入发出的本地时刻（useRcInput 写、useRcFrames 读），操作延迟 HUD 用
  const inputEpochRef = useRef(0);
  const canControl = session.capability === "control";
  /** 本机是否正作为**被控端**推流（决定 HUD 能不能拿到自动档的「生效档」，见下方 RcHud）。 */
  const inboundActive = session.phase === "inbound_active";

  const {
    hasFrame,
    statusText,
    codec,
    fps,
    contentRef,
    lastFrameAt,
    size,
    latencyMs,
    bitrateKbps,
    segCapMs,
    segEncMs,
    segNetMs,
    segDecMs,
    respMs,
  } = useRcFrames(session.id, canvasRef, {
    // P0-1 A3：时钟偏差校准（后端 pong 估算）；未校准时为 0，延迟显示带「≈」
    clockSkewMs: rc.status?.clock_skew_ms ?? 0,
    lastInputAt: inputEpochRef,
    // D4：fps120 档解码配置要抬 H.264 level（1080p120 超出 L4.2 规格）
    qualityHint: qPick,
  });
  // P1-6：远端光标形状（非箭头形状换用本地系统光标渲染）
  const cursorShape = useRcCursor(session.id);

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
    hasFrame,
    contentRef,
    canvasRef,
    screenRef,
    onConfirmEnd: () => void requestEnd(),
    fit,
    // P4：fps120 档鼠标采样提到 8ms（datagram 不排队，纯采样密度问题）
    moveThrottleMs: qPick === "fps120" ? 8 : 16,
    inputEpochRef,
  });
  useEffect(() => {
    setQPick(quality);
    setScopePick(captureScope);
    // 换会话时码率倍率回到本机配置（上一场的临时选择不该带到下一场）；
    // 依赖里带上 cfg 值：首帧 status 尚未加载时初值按 100 兜底，status 到达
    // 后这里会把下拉纠正成真正的配置值。会话内改下拉也会回写 cfg，值一致，
    // 不会造成选中值跳变。
    setBitratePick(rc.status?.bitrate_pct ?? 100);
  }, [session.id, quality, captureScope, rc.status?.bitrate_pct]);
  // D6：对端 caps 重报 fps120 不可用（如范围切到多屏）时，本地的 fps120 选中值
  // 自动回落——否则下拉框会显示一个已不可选的档（RcDropdown 回退裸 key），
  // 被控端也已由能力校验/推流降档兜底，不会再按 8ms 硬跑。
  useEffect(() => {
    if (qPick === "fps120" && rc.status?.peer_fps120 === false) {
      setQPick("fps60");
    }
  }, [qPick, rc.status?.peer_fps120]);
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
  const onKeyDown = (e: React.KeyboardEvent) => input.onKeyDown(e);
  const onKeyUp = (e: React.KeyboardEvent) => input.onKeyUp(e);

  /* v4 对稿（第三轮，B 窗）：根容器改为 sessionWrap——深色画布块（viewShell：
     顶条 + fakeScreen）与下方「申请控制权行 + 会话底栏」分层，底栏是画布下方
     独立的亮玻璃条（稿 .sessionBar），不再贴在深色画布里连成一片。 */
  return (
    <div className={styles.sessionWrap}>
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
              // 普通键/鼠标键的按下态跟踪释放（releaseModifiers 只管修饰键+鼠标）
              input.releaseTracked();
            }
          }}
          onMouseDown={() => {
            if (canControl) screenRef.current?.focus();
          }}
          onContextMenu={(e) => {
            // 误触右键菜单修复③：会话表面（画面 letterbox / HUD / 工具）只有
            // canvas 屏蔽过本地右键菜单——其余区域右键会弹出 WebView2 默认菜单
            //（刷新/打印/检查…）。这里统一屏蔽；远端右键不受影响（它走
            // mousedown/mouseup 注入，与 contextmenu 无关）。
            e.preventDefault();
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
          <RcScreenCanvas
            canvasRef={canvasRef}
            contentRef={contentRef}
            size={size}
            fit={fit}
            canControl={canControl}
            hasFrame={hasFrame}
            input={input}
            cursorShape={cursorShape}
          />
          {!hasFrame && (
            <div className={styles.placeholder}>
              <Loader2 size={22} className={styles.spin} />
              <div>{statusText || "等待对方画面…"}</div>
              <div className={styles.placeholderSub}>{placeholderSub}</div>
            </div>
          )}
          {/* v4 对稿（B 窗）：只看水印，透明度呼吸 2.6s——「对面是活的」的最低成本
              表达。只在**只看且已有画面**时出现：等待态中央是 placeholder，可控态
              没有「只看」可说；pointer-events:none 不挡画布的任何交互。 */}
          {!canControl && hasFrame && (
            <div className={styles.viewOnlyMark} aria-hidden="true">
              <Eye size={14} />
              只看模式 · 对端桌面实时画面
            </div>
          )}
          {/* 🔴 自动档的落点只有**推流那台机器**知道。本组件当前只在出站会话渲染
              （RcWorkbench 判 `outbound_active`），所以 activeQuality 实际总是空、
              走 peerDriven 分支显示「自动 · 由对方决定」；inbound 那一支留着，
              是为了将来复用时不撒谎（被控端才是拿得到生效档的一方）。 */}
          <RcHud
            codec={codec}
            fps={fps}
            rttMs={link.rttMs}
            frameLatencyMs={latencyMs}
            lossPermille={rc.status?.loss_permille}
            bitrateKbps={bitrateKbps}
            segCapMs={segCapMs}
            segEncMs={segEncMs}
            segNetMs={segNetMs}
            segDecMs={segDecMs}
            respMs={respMs}
            quality={qPick}
            activeQuality={inboundActive ? rc.status?.active_quality : undefined}
            peerDriven={!inboundActive}
            scope={scopePick}
            linkState={link.state}
            pathKind={rc.status?.path_kind ?? ""}
            pointerLocked={input.pointerLocked}
          />
        </div>
      </div>

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
        quality={qPick}
        captureScope={scopePick}
        bitrate={bitratePick}
        onPickQuality={(k) => setQPick(k)}
        onPickScope={(s) => setScopePick(s)}
        onPickBitrate={(p) => setBitratePick(p)}
        clipAuto={clipAuto}
        // B5：基线由 hook 在开启时自动建立，这里只切开关，不手动 reset
        onToggleClipAuto={() => setClipAuto((v) => !v)}
        lastAutoAt={clip.lastAutoAt}
        autoFail={clip.autoFail}
        onStatus={(m, k) => toast(m, k)}
        kbOn={input.kbOn}
        pointerLocked={input.pointerLocked}
        fit={fit}
        sizeW={size.w}
        frameIdleSec={link.frameIdleSec}
      />
    </div>
  );
}
