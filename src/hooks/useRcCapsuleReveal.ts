/**
 * useRcCapsuleReveal — 控端浮条的**浮现状态机**（自 RcSessionCapsule 抽出，
 * 2026-09-24，`.tsx ≤ 300` 红线）。
 *
 * B 变体的策略（用户指定 + B 稿 §5）：
 * - 首显：连接成功（挂载）即显示，`INITIAL_SHOW_MS` 无交互后淡出——自解释，
 *   替代 B 原稿的零首显 + 引导卡。
 * - 唤出：顶边 `REVEAL_BAND_PX` 热区或悬停胶囊本体；离开 2.5s 淡出。
 * - 锁显：`linkLocked`（链路异常 / 操作后无画面）、下拉展开中（menusOpen）、
 *   ⋯ 面板展开中任一为真就不淡出——portal 菜单/面板上的鼠标移动不经过画面
 *   热区，不锁会把开着的菜单晾成孤儿。锁显解除时：首显窗口还开着就交给剩余
 *   首显计时，否则正常 2.5s 淡出。
 * - 🔴 指针锁定（Pointer Lock）时不唤出——锁住的指针没有真实光标，mousemove
 *   的 clientY 停在锁定前位置，靠它唤出是假象（RcFullscreenHotbar 同款守卫）。
 *
 * 隐藏态的三重纪律（pointer-events:none + visibility:hidden + tabIndex=-1）
 * 由 CSS `.viewToolsHidden` 与组件里的 `tab` 值共同承担，这里只出状态。
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** B 稿顶边热区：距画面顶缘这么近时唤出。 */
const REVEAL_BAND_PX = 12;
/** 无交互这么久后淡出。 */
const AUTO_HIDE_MS = 2500;
/** 连接成功后的首显时长（用户指定：15s 再隐藏）。 */
export const INITIAL_SHOW_MS = 15000;

export function useRcCapsuleReveal({
  rootRef,
  stageRef,
  pointerLocked,
  linkLocked,
}: {
  /** 浮条根（.capZone）——「悬停胶囊保持显示」的命中矩形。 */
  rootRef: React.RefObject<HTMLDivElement | null>;
  /** 画面容器（fakeScreen）——mousemove 挂它不挂 window（P2-12）。 */
  stageRef: React.RefObject<HTMLDivElement | null>;
  pointerLocked: boolean;
  /** 链路维度的锁显：linkState ≠ connected 或操作后无画面。 */
  linkLocked: boolean;
}) {
  const [shown, setShown] = useState(true);
  /** 展开中的下拉数（画质/画面/码率，经 RcDropdown.onOpenChange 汇报）。 */
  const [menusOpen, setMenusOpen] = useState(0);
  /** ⋯ 面板展开中。面板 DOM 在浮条 root 内，但开合是组件状态，一并收在这里。 */
  const [moreOpen, setMoreOpen] = useState(false);
  const hideTimer = useRef<number | null>(null);
  /** 首显 15s 计时是否还在跑（决定异常恢复后走剩余首显还是 2.5s 淡出）。 */
  const initialPendingRef = useRef(true);
  const lockRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (hideTimer.current != null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const scheduleHide = useCallback(() => {
    if (lockRef.current) return;
    clearTimer();
    initialPendingRef.current = false;
    hideTimer.current = window.setTimeout(() => setShown(false), AUTO_HIDE_MS);
  }, [clearTimer]);

  // 首显：挂载即显示，15s 无交互后淡出
  useEffect(() => {
    hideTimer.current = window.setTimeout(() => {
      initialPendingRef.current = false;
      setShown(false);
    }, INITIAL_SHOW_MS);
    return clearTimer;
  }, [clearTimer]);

  const locked = linkLocked || moreOpen || menusOpen > 0;

  useEffect(() => {
    lockRef.current = locked;
    if (locked) {
      clearTimer();
      setShown(true);
      return;
    }
    // 解锁瞬间：首显窗口还开着 → 交给剩余的首显计时；否则正常 2.5s 淡出
    if (!initialPendingRef.current) scheduleHide();
  }, [locked, clearTimer, scheduleHide]);

  // 唤出监听挂在画面容器上（不挂 window，P2-12）
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onMove = (e: MouseEvent) => {
      if (pointerLocked) return; // 锁定指针时假光标唤不出（见文件头 🔴）
      const r = rootRef.current?.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      const inStage =
        e.clientX >= s.left && e.clientX <= s.right && e.clientY >= s.top && e.clientY <= s.bottom;
      if (!inStage || !r) return;
      const overCap =
        e.clientX >= r.left - 4 &&
        e.clientX <= r.right + 4 &&
        e.clientY >= r.top - 4 &&
        e.clientY <= r.bottom + 4;
      const nearTop = e.clientY - s.top <= REVEAL_BAND_PX;
      if (overCap) {
        // 悬停在胶囊上：保持可见，不计时（正在去点按钮）
        setShown(true);
        clearTimer();
      } else if (nearTop) {
        setShown(true);
        scheduleHide();
      }
    };
    stage.addEventListener("mousemove", onMove);
    return () => stage.removeEventListener("mousemove", onMove);
  }, [rootRef, stageRef, pointerLocked, clearTimer, scheduleHide]);

  const menuDelta = useCallback((o: boolean) => {
    setMenusOpen((c) => Math.max(0, c + (o ? 1 : -1)));
  }, []);

  // ⋯ 面板：点外面收（同 RcHud 口径）
  useEffect(() => {
    if (!moreOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [moreOpen, rootRef]);

  return { shown, moreOpen, setMoreOpen, menuDelta, scheduleHide };
}
