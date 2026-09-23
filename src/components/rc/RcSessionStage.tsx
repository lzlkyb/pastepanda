/**
 * RcSessionStage — 会话画面区（viewShell）：顶条 + fakeScreen（视图工具 / 画布 /
 * 等待占位 / 只看水印 / 连接详情 / 全屏提示）。
 *
 * 从 RcSessionView 拆出（2026-09-21，`.tsx ≤ 300` 红线）。边界刻意划在「只消费、
 * 不改编排」：`input` / `link` / `frames` 三个 hook 仍在 RcSessionView 里调用，
 * 这里整组接收它们的返回值，而不是把 30 个字段逐个摊成 props（那只是把解构搬个家）。
 *
 * v4 对稿（第三轮，B 窗）：根是 viewShell——深色画布块与下方「申请控制权行 + 会话
 * 底栏」分层，底栏是画布下方独立的亮玻璃条（稿 .sessionBar），不再贴在深色画布连成一片。
 */
import { Eye, Loader2 } from "lucide-react";
import type { RcSession } from "@/lib/api/rc";
import type { UseRc } from "@/hooks/useRc";
import type { useRcFrames } from "@/hooks/useRcFrames";
import { releaseModifiers } from "@/hooks/useRcInput";
import type { useRcInput } from "@/hooks/useRcInput";
import type { RcLinkSnapshot } from "@/hooks/useRcLinkState";
import type { RcCursorShape } from "@/hooks/useRcCursor";
import type { FitMode } from "@/lib/rcSessionStats";
import { qualityLabel } from "@/lib/rcQuality";
import { RcHud } from "./RcHud";
import { RcViewTools } from "./RcViewTools";
import { RcSessionTop } from "./RcSessionTop";
import { RcScreenCanvas } from "./RcScreenCanvas";
import { RcFsHint } from "./RcFsHint";
import styles from "./RemoteComputer.module.css";

type RcInput = ReturnType<typeof useRcInput>;
type RcFrames = ReturnType<typeof useRcFrames>;

export function RcSessionStage({
  session,
  busy,
  rc,
  input,
  link,
  frames,
  cursorShape,
  fit,
  onFit,
  fullscreen,
  onToggleFullscreen,
  fsHintDismissed,
  onDismissFsHint,
  qPick,
  scopePick,
  screenRef,
  canvasRef,
  onReconnect,
  onRequestEnd,
}: {
  session: RcSession;
  busy: boolean;
  rc: UseRc;
  input: RcInput;
  link: RcLinkSnapshot;
  frames: RcFrames;
  cursorShape: RcCursorShape | null;
  fit: FitMode;
  onFit: (m: FitMode) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  fsHintDismissed: boolean;
  onDismissFsHint: () => void;
  /** 会话内生效的画质档（HUD 显示与 fps120 采样密度都依赖它） */
  qPick: string;
  /** 会话内生效的画面范围（HUD 显示） */
  scopePick: string;
  screenRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  onReconnect?: () => void;
  /** 会话内结束（父级包了 ConfirmDialog，这里只负责触发） */
  onRequestEnd: () => void;
}) {
  const canControl = session.capability === "control";
  /** 本机是否正作为**被控端**推流（决定 HUD 能不能拿到自动档的「生效档」）。 */
  const inboundActive = session.phase === "inbound_active";
  const {
    visible,
    hasFrame,
    statusText,
    codec,
    fps,
    contentRef,
    size,
    latencyMs,
    bitrateKbps,
    segCapMs,
    segEncMs,
    segNetMs,
    segDecMs,
    respMs,
  } = frames;

  const placeholderSub =
    codec === "h264"
      ? "对方正在用 H.264 推流"
      : `对方编码中 · ${qualityLabel(qPick)}档`;
  const onKeyDown = (e: React.KeyboardEvent) => input.onKeyDown(e);
  const onKeyUp = (e: React.KeyboardEvent) => input.onKeyUp(e);

  return (
    <div className={styles.viewShell}>
      <RcSessionTop
        session={session}
        canControl={canControl}
        kbOn={input.kbOn}
        linkState={link.state}
        unansweredSec={link.unansweredSec}
        busy={busy}
        fullscreen={fullscreen}
        // R3：false = 对端 caps 未声明数据报鼠标（7.2.1 及更早）→ 顶栏提示升级
        peerDgramInput={rc.status?.peer_dgram_input}
        onReleaseKb={input.releaseKb}
        onReconnect={onReconnect}
        onRequestEnd={onRequestEnd}
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
          onFit={onFit}
          pointerLocked={input.pointerLocked}
          onTogglePointer={input.togglePointerLock}
          canControl={canControl}
          fullscreen={fullscreen}
          onToggleFullscreen={onToggleFullscreen}
        />
        <RcScreenCanvas
          canvasRef={canvasRef}
          contentRef={contentRef}
          size={size}
          fit={fit}
          canControl={canControl}
          hasFrame={hasFrame}
          active={visible}
          input={input}
          cursorShape={cursorShape}
        />
        {/* B3（2026-09-23）：statusText 原先只在 !hasFrame 的占位块里渲染——
            连续取帧失败到阈值写进画面的「画面接收异常，正在自动重试…」在
            有画面的会话里永远看不到（U3.5：不许落到静默）。B1 的暂停提示
            同用这条常驻位。 */}
        {hasFrame && (statusText || !visible) && (
          <div className={styles.stageNotice} role="status">
            {!visible
              ? "已暂停：窗口失去焦点，画面与控制暂停，点击本窗口恢复"
              : statusText}
          </div>
        )}
        {!hasFrame && (
          /* U3：一帧都没等到且链路已判死 = 错误态，不能继续演「等待中」。 */
          link.state === "failed" ? (
            <div className={styles.placeholder}>
              <div>连接已断开，未能收到画面</div>
              <div className={styles.placeholderSub}>可尝试重新连接，或检查双方网络</div>
              {onReconnect && (
                <button
                  type="button"
                  className={styles.miniBtnPri}
                  disabled={busy}
                  onClick={onReconnect}
                >
                  重新连接
                </button>
              )}
            </div>
          ) : (
            <div className={styles.placeholder}>
              <Loader2 size={22} className={styles.spin} />
              <div>{statusText || "等待对方画面…"}</div>
              <div className={styles.placeholderSub}>{placeholderSub}</div>
            </div>
          )
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
          /* 稿「连接详情」里的画面尺寸（2560×1440）。来自 useRcFrames 的 size，
             首帧未到时为 0 → HUD 自动不出这一行。 */
          frameSize={size}
        />
        {/* 案 A：非全屏轻提示（判据 lib/rcFsHint；不挡画面中心操作） */}
        <RcFsHint
          canControl={canControl}
          hasFrame={hasFrame}
          fullscreen={fullscreen}
          dismissed={fsHintDismissed}
          contentSize={size}
          canvasRef={canvasRef}
          screenRef={screenRef}
          onFullscreen={onToggleFullscreen}
          onDismiss={onDismissFsHint}
        />
      </div>
    </div>
  );
}
