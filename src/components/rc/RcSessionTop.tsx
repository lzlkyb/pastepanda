/**
 * RcSessionTop — 会话顶栏：谁 / 能力 / 链路 / 旧版提示 / ⋯ / 结束。
 *
 * 🔴 连接灯只由 `linkState` 驱动（对端 pong 的新鲜度），**不再看画面停滞**。
 * 案 A 瘦身：释放键盘 / 重连收进「⋯」——结束会话保持常驻（破坏性操作可达性）。
 * R3：可控且对端未声明 dgram_input 时显示「对方版本偏旧」。
 */
import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { fingerprintOf } from "@/lib/fingerprint";
import { rcDisplayName } from "@/lib/rcDevice";
import type { RcSession } from "@/lib/api/rc";
import { linkStateHint, linkStateLabel, type RcLinkState } from "@/lib/rcSessionStats";
import { RcCloseButton } from "./RcWindowControls";
import styles from "./RemoteComputer.module.css";

export function RcSessionTop({
  session,
  canControl,
  kbOn,
  linkState,
  unansweredSec,
  busy,
  peerDgramInput,
  onReleaseKb,
  onReconnect,
  onRequestEnd,
}: {
  session: RcSession;
  canControl: boolean;
  kbOn: boolean;
  linkState: RcLinkState;
  /** 操作后未响应秒数；0 = 不提示。 */
  unansweredSec: number;
  busy: boolean;
  /**
   * R3：对端 caps 是否声明能读鼠标数据报。false = 旧版（7.2.1 及更早）
   * 或尚未收到 caps——可控会话下提示升级对端；true = 不提示。
   */
  peerDgramInput?: boolean;
  onReleaseKb: () => void;
  onReconnect?: () => void;
  onRequestEnd: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const hasOverflow = (canControl && kbOn) || !!onReconnect;

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  const dotCls =
    linkState === "connected"
      ? styles.live
      : linkState === "failed"
        ? styles.liveBad
        : styles.liveOff;
  return (
    /* 批7：会话态整条工作台标题栏被 `hidesWorkbenchTitleBar` 收掉（画面铺满），
       而没有标题栏的窗口既拖不动也关不掉——本条兼作拖拽区。`deep` 让整个子树可拖，
       条内的胶囊 / 按钮由 Tauri 自动豁免（可点击元素不带该属性即阻断拖动）。 */
    <div className={styles.viewTop} data-tauri-drag-region="deep">
      <span className={dotCls} />
      <span>
        正在查看 <b>{rcDisplayName(session, fingerprintOf(session.peer))}</b>
      </span>
      <span className={canControl ? styles.pillOn : styles.pill}>
        {canControl ? "可控" : "只看"}
      </span>
      {/* R3：可控 + 对端未声明 dgram_input = 旧版被控端。常驻胶囊，与链路警示同级可见性。 */}
      {canControl && peerDgramInput === false && (
        <span
          className={styles.pillWarn}
          title="远程鼠标移动走数据报通道，官方 7.2.1 及更早的被控端收不到。请对方升级 PastePanda 到最新版后重新连接；按键/点击仍可尝试。"
        >
          对方版本偏旧
        </span>
      )}
      {linkState === "failed" && (
        <span className={styles.pillDanger} title={linkStateHint(linkState)}>
          {linkStateLabel(linkState)}
        </span>
      )}
      {(linkState === "unstable" || linkState === "reconnecting") && (
        <span className={styles.pillWarn} title={linkStateHint(linkState)}>
          {linkStateLabel(linkState)}
        </span>
      )}
      {unansweredSec > 0 && (
        <span className={styles.pillWarn} title="操作已发往对方，但画面尚未变化">
          操作后 {unansweredSec}s 无画面
        </span>
      )}
      <span className={styles.sp} />
      {hasOverflow && (
        <div className={styles.topMoreWrap} ref={menuRef}>
          <button
            type="button"
            className={styles.miniBtn}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            title="更多会话操作"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <MoreHorizontal size={14} aria-hidden />
            <span className={styles.topMoreLabel}>更多</span>
          </button>
          {menuOpen && (
            <div className={styles.topMoreMenu} role="menu">
              {canControl && kbOn && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onReleaseKb();
                  }}
                >
                  释放键盘
                </button>
              )}
              {onReconnect && (
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => {
                    setMenuOpen(false);
                    onReconnect();
                  }}
                >
                  重连
                </button>
              )}
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        className={styles.dangerBtn}
        disabled={busy}
        onClick={onRequestEnd}
      >
        结束会话
      </button>
      {/* 批7：窗口没有系统标题栏了，这里是**会话态唯一能关掉窗口的地方**——
          少了它，用户只能去杀进程。只补关闭：最小化 / 最大化另有系统替代
          （任务栏、双击本条、Win+方向键），不必再占顶条宽度。 */}
      <div className={styles.winControlsFlush} data-tauri-drag-region="false">
        <RcCloseButton />
      </div>
    </div>
  );
}
