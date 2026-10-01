/**
 * RcSessionStage — 会话画面区（viewShell）：纯壳顶条 + fakeScreen（画布 /
 * 等待占位 / 只看水印 / 全屏提示）。
 *
 * 从 RcSessionView 拆出（2026-09-21，`.tsx ≤ 300` 红线）。边界刻意划在「只消费、
 * 不改编排」：`input` / `link` / `frames` 三个 hook 仍在 RcSessionView 里调用，
 * 这里整组接收它们的返回值，而不是把 30 个字段逐个摊成 props（那只是把解构搬个家）。
 *
 * 2026-09-24 控端态浮条收编：viewTools / 左上 HUD 按钮退场，会话控制全部交给
 * RcSessionView 挂的 RcSessionCapsule（会隐藏的顶部胶囊）。
 *
 * 2026-09-28 方案 A（design/远程电脑-控端全屏胶囊统一-设计稿.html）：全屏态不再
 * 换第二条控制条（RcFullscreenHotbar 退役），两态同一条胶囊；顶栏 `.viewTop` 在
 * 全屏时整条退场（身份/窗口键并入胶囊），画面盒回到整个屏幕。
 */
import { rcCanControl } from "@/lib/rcCapability";
import { Eye, Loader2 } from "lucide-react";
import { useEffect } from "react";
import type { RcSession } from "@/lib/api/rc";
import { rcDisplayName } from "@/lib/rcDevice";
import type { useRcFrames } from "@/hooks/useRcFrames";
import { releaseModifiers } from "@/hooks/useRcInput";
import type { useRcInput } from "@/hooks/useRcInput";
import type { RcLinkSnapshot } from "@/hooks/useRcLinkState";
import type { RcCursorShape } from "@/hooks/useRcCursor";
import type { FitMode } from "@/lib/rcSessionStats";
import { qualityLabel } from "@/lib/rcQuality";
import { rcBlurReleasesHeld, rcBlurTarget } from "@/lib/rcFocusRelease";
import { rcPanelOpenCount } from "@/lib/rcPanelFocus";
import { RcSessionTop } from "./RcSessionTop";
import { RcScreenCanvas } from "./RcScreenCanvas";
import { RcFsHint } from "./RcFsHint";
import { RcLinkMask } from "./RcLinkMask";
import styles from "./RemoteComputer.module.css";

type RcInput = ReturnType<typeof useRcInput>;
type RcFrames = ReturnType<typeof useRcFrames>;

export function RcSessionStage({
  session,
  busy,
  input,
  link,
  frames,
  cursorShape,
  fit,
  fullscreen,
  onToggleFullscreen,
  fsHintDismissed,
  onDismissFsHint,
  qPick,
  screenRef,
  wrapRef,
  canvasRef,
  onReconnect,
  onRequestEnd,
}: {
  session: RcSession;
  /** 重连等在途（等待占位里的「重新连接」按钮禁用态） */
  busy: boolean;
  input: RcInput;
  link: RcLinkSnapshot;
  frames: RcFrames;
  cursorShape: RcCursorShape | null;
  fit: FitMode;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  fsHintDismissed: boolean;
  onDismissFsHint: () => void;
  /** 会话内生效的画质档（等待占位文案用它） */
  qPick: string;
  screenRef: React.RefObject<HTMLDivElement | null>;
  /**
   * 🔴 乙-②：会话壳（`.sessionWrap`）。焦点离开画面时用它判断「新焦点还在不在同
   * 一扇窗里」——在＝只暂停注入，不在＝才释放按住键。判据在 `lib/rcFocusRelease`。
   */
  wrapRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  onReconnect?: () => void;
  /** 遮罩上的「结束会话」（父级已包 confirmDialog，这里只触发）。 */
  onRequestEnd: () => void;
}) {
  const canControl = rcCanControl(session.capability);
  const {
    visible,
    hasFrame,
    statusText,
    codec,
    contentRef,
    size,
  } = frames;

  const placeholderSub =
    codec === "h264"
      ? "对方正在用 H.264 推流"
      : `对方编码中 · ${qualityLabel(qPick)}档`;
  const onKeyDown = (e: React.KeyboardEvent) => input.onKeyDown(e);
  const onKeyUp = (e: React.KeyboardEvent) => input.onKeyUp(e);

  // 审计 P1-2（2026-09-27）：F11 切换全屏——Windows/浏览器同款惯例，给会话一条
  // 键盘加速路径（鼠标主路是胶囊上的全屏键，两态同一颗）。捕获键盘或锁指针时
  // F11 属远端交互，不生效；有模态时让路。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F11" || e.ctrlKey || e.altKey || e.metaKey) return;
      if (input.kbOn || input.pointerLocked) return;
      // 下拉/⋯/ⓘ 面板展开时让路（17.6：先收面板再谈退出，口径与 Esc 一致）
      if (rcPanelOpenCount() > 0 || document.querySelector(".dialog-backdrop")) return;
      e.preventDefault();
      onToggleFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [input.kbOn, input.pointerLocked, onToggleFullscreen]);

  return (
    <div className={styles.viewShell}>
      {/* 方案 A（2026-09-28）：全屏态顶栏整条退场——身份（灯/名字/能力）与窗口键
          都在胶囊里，同屏两套只会让画面少一条 36px（「显示不全」的一半根因）。
          非全屏照旧，拖拽区与三键仍归顶栏。 */}
      {!fullscreen && <RcSessionTop session={session} linkState={link.state} />}

      <div
        ref={screenRef}
        className={input.kbOn ? `${styles.fakeScreen} ${styles.fakeScreenKb}` : styles.fakeScreen}
        tabIndex={canControl ? 0 : -1}
        onFocus={() => {
          if (canControl) input.setKbOn(true);
        }}
        onBlur={(e) => {
          if (canControl) {
            input.setKbOn(false);
            // 🔴 乙-②：焦点进浮条（还在同一会话壳里）＝**只暂停注入**，按住态留着，
            // 回到画面自然续上。只有真离开（切窗口 / 最小化 / relatedTarget 为 null）
            // 才释放——那才是「对端留着一只按下的 Ctrl」的事故源。
            if (rcBlurReleasesHeld(rcBlurTarget(e.relatedTarget, wrapRef.current))) {
              void releaseModifiers();
              // 普通键/鼠标键的按下态跟踪释放（releaseModifiers 只管修饰键+鼠标）
              input.releaseTracked();
            }
          }
        }}
        {...input.imeHandlers}
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
        {/* 方案 A（2026-09-28）：全屏态不再挂第二条控制条——会话控制在两态都是
            RcSessionView 挂的同一条 RcSessionCapsule（它挂在 .sessionWrap 里，
            全屏元素本身就是 .sessionWrap，所以全屏可见，无需挂进 fakeScreen）。 */}
        {/* 审计 P1-2（2026-09-27）：全屏态键盘捕获常驻徽标——输入正打进对方机器
            而屏幕上没有任何说明不可接受。底部居中不与顶部胶囊抢位；
            pointer-events:none 不挡画面点击。 */}
        {fullscreen && canControl && input.kbOn && (
          <div className={styles.fsKbBadge} role="status">
            <i aria-hidden="true" />
            键盘已捕获 · Esc 释放
          </div>
        )}
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
        {/* 甲-③（2026-09-29）：链路中断遮罩。挂在 fakeScreen **内部**（= 全屏元素
            .sessionWrap 的子树）——挂在 <main> 上就像 C2 一样在全屏里隐形。
            判据在 lib/rcLinkMask：没有画面时不遮（placeholder 在说话）、unstable 不遮
            （它会自愈，铺一层黑等于把「还能用」说成「已经断了」）。 */}
        <RcLinkMask
          hasFrame={hasFrame}
          state={link.state}
          busy={busy}
          peerName={rcDisplayName(session) || session.peer_name || "对方"}
          onReconnect={onReconnect}
          onRequestEnd={onRequestEnd}
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
