/**
 * useRcCapsuleReveal — 控端浮条的**浮现状态机**（自 RcSessionCapsule 抽出，
 * 2026-09-24，`.tsx ≤ 300` 红线）。
 *
 * B 变体的策略（用户指定 + B 稿 §5）：
 * - 首显：连接成功（挂载）即显示，`INITIAL_SHOW_MS` 无交互后淡出——自解释，
 *   替代 B 原稿的零首显 + 引导卡。
 * - 唤出：顶边 `REVEAL_BAND_PX` 热区停留 `REVEAL_DWELL_MS` 才出现，或（已显示时）
 *   悬停胶囊本体；离开 2.5s 淡出。
 * - 🔴 甲方案（2026-09-29，docs/远程电脑-交互审计与方案-2026-09-29.md §8）：
 *   热区从 12px 收到 3px + dwell 180ms + 唤出后 200ms 内不参与命中测试 +
 *   **隐藏态不再以胶囊矩形为悬停目标**。
 *   起因是「顶缘唤出即遮挡」——胶囊遮挡带是画面 y 12–46，远端浏览器的标签 ✕
 *   与地址栏正好落在里面，指针从下方移过去的路上先把浮条唤出来，落点就变成了
 *   浮条按钮。四条各自堵一段：3px 让「从画面内部往上点」根本不经热区；隐藏态不认
 *   胶囊矩形堵掉「飘过 y 12–46 就弹出」；dwell 让「快速穿过顶缘」不触发；穿透窗口
 *   让「已经触发了」的那一下点击仍然落到远端。
 *   依据：Fitts 定律里屏幕边缘目标是无限大目标（顶缘本就该让给内容）；RustDesk
 *   折叠钮横向钳在 35–65% 同属「让边」思路；dwell 时长参考 Windows
 *   SM_MOUSEHOVERTIME。首显那 15s 仍会压住顶缘中央（刻意的一次性教学，F10 可立刻收起）。
 * - 🔴 乙档（2026-09-29，design/远程电脑-浮条角标化-乙-设计稿.html）把「收起态零出口」
 *   补成**顶缘常驻把手**：这个 hook 因此出两层状态——`shown`（胶囊展开，=原语义）
 *   与 `handleState`（把手外观，常驻）。四条拍板落在这里：
 *   ①`hoverReveal` 开关：关掉＝顶缘零触发，连 mousemove 都不注册，唤出只剩把手与 F10；
 *   ③微光条改挂把手层（外观在 CSS/组件，这里只出 `linkDown`）；
 *   ⑥链路异常**不再永久锁显**（见下方 locked 注释）；
 *   另有 `pendingCount`（对端文件请求）到达时自动展开一次 + 把手整枚染橙。
 *   🔴 D 项口径（2026-09-29 拍板，验收按这句判）：顶缘 dwell 覆盖的是
 *   **「除正中那一条把手之外」的全部位置**。把手与画面容器是**兄弟**（胶囊挂在
 *   `.sessionWrap`），指针停在把手上时 `fakeScreen` 收不到 mousemove，那一条不会起算
 *   dwell。这是刻意的，不去修：常驻按钮再叠一层「悬停即唤出」，等于把甲方案刚删掉的
 *   「隐形悬停目标」搬回原位——用户往上够远端标签时手上一停，胶囊就展开盖住 y 12–46，
 *   比「什么都不发生、点一下才展开」更侵人。出口是点击，且它本来就看得见。
 * - 锁显：下拉展开中（menusOpen）、⋯ 面板展开中、ⓘ 详情展开中任一为真就不淡出——
 *   portal 菜单/面板上的鼠标移动不经过画面热区，不锁会把开着的菜单晾成孤儿。
 *   🔴 乙-⑥：`linkDown` 从锁显条件里**摘掉了**。原口径（2026-09-23 拍板）等于让
 *   遮挡带 y 12–46 一直留到会话结束，正是甲方案要修的原点；现在告知职责由把手
 *   （染红 + 微光条常显）承担，异常发生那一刻自动展开一次、2.5s 后照常收起。
 *   锁显解除时：首显窗口还开着就交给剩余首显计时，否则正常 2.5s 淡出。
 * - 🔴 指针锁定（Pointer Lock）时不唤出——锁住的指针没有真实光标，mousemove
 *   的 clientY 停在锁定前位置，靠它唤出是假象。把手同口径隐形（`handleState="dim"`）。
 * - 键盘：F10 唤出/收起（原全屏 hotbar 的热键，2026-09-28 方案 A 随浮条统一后
 *   两态通用）。捕获键盘或锁指针时 F10 属远端按键，热键让路；面板/模态展开时
 *   同样让路（与 Esc 的 17.6 口径一致）。F10 是显式意图，**不**走穿透窗口。
 *
 * 隐藏态的三重纪律（pointer-events:none + visibility:hidden + tabIndex=-1）
 * 由 CSS `.viewToolsHidden` 与组件里的 `tab` 值共同承担，这里只出状态。
 * 穿透窗口期只摘掉 pointer-events 这一层（`.capZoneThru`），淡入动画与 Tab 环不变。
 * 🔴 乙档起 `.viewToolsHidden` 挂在 `.capFloat`（胶囊 + ⋯ 面板的外层）而**不是**
 * `.capZone`：把手和微光条必须待在被 `visibility:hidden` 带走的子树之外，否则
 * 收起态又回到「异常只剩一个看不见的灯」（规则 15.1）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { isSessionEscape } from "@/lib/rcKeyGuard";
import { rcPanelOpenCount, registerRcPanel, unregisterRcPanel } from "@/lib/rcPanelFocus";

/**
 * 顶缘唤出热区（甲方案 2026-09-29 从 12px 收到 3px）：只有把指针**故意顶进画面
 * 上边缘**才算唤出意图。从画面内部往上够远端的标签 ✕ / 地址栏（y≈10–46）时，
 * 路径不再经过热区，浮条就不会先弹出来吃掉这一击。
 */
const REVEAL_BAND_PX = 3;
/** 进热区后要停留这么久才真的唤出——快速穿过顶缘不算意图（参考 Windows SM_MOUSEHOVERTIME）。 */
const REVEAL_DWELL_MS = 180;
/** 唤出后这么久内浮条不参与命中测试：那一下点击落到远端，而不是刚弹出来的按钮。 */
const REVEAL_THROUGH_MS = 200;
/** 无交互这么久后淡出。 */
const AUTO_HIDE_MS = 2500;
/** 连接成功后的首显时长（用户指定：15s 再隐藏）。 */
export const INITIAL_SHOW_MS = 15000;

/** 一次 mousemove 该对浮条做什么——纯判断，守卫单测钉住（规则 11.1）。 */
export type RcRevealGesture = "hold" | "keep" | "dwell" | "idle";

export function rcRevealGestureOf(p: {
  /** 指针在胶囊本体矩形（外扩 4px）上——**仅在已显示时**才算悬停目标。 */
  overCap: boolean;
  /** 指针在顶缘唤出带内。 */
  inBand: boolean;
  /** 浮条当前是否已显示。 */
  shown: boolean;
}): RcRevealGesture {
  if (p.shown) {
    // 看得见：悬停本体保持（正在去点按钮，不计时）；沿顶缘移动只续淡出计时。
    if (p.overCap) return "hold";
    return p.inBand ? "keep" : "idle";
  }
  // 🔴 隐藏态：看不见的胶囊矩形**不构成悬停目标**——它压着远端浏览器的标签栏
  //（y 12–46），原先「飘过就弹出且立刻可点」正是用户报的遮挡根因。只有故意顶进
  // 画面最上缘 3px 并停住（dwell）才算唤出意图，F10 是另一条明路。
  return p.inBand ? "dwell" : "idle";
}

/**
 * 锁显判据（纯函数，守卫单测钉住——规则 11.1）。
 *
 * 🔴 乙-⑥：链路异常不在列。这三项的共同点是「浮条收起会把用户正用的东西一起
 * 卸载」（portal 菜单在 body 上、⋯ 面板与 ⓘ 浮层在胶囊子树里），而「链路断了」
 * 是一条**告知**，告知已由常驻把手承担，不该拿遮挡带换。
 */
export function rcCapsuleLockOf(p: { menusOpen: number; moreOpen: boolean; detailOpen: boolean }): boolean {
  return p.moreOpen || p.menusOpen > 0 || p.detailOpen;
}

/** 把手外观档（纯函数）。优先级：隐形 > 染红 > 染橙 > 常态。 */
export type RcHandleState = "dim" | "bad" | "ask" | "idle";

export function rcHandleStateOf(p: {
  /** 系统指针已捕获——本地没有光标，常驻把手只会白吃像素（沿用甲「锁指针不唤出」口径）。 */
  pointerLocked: boolean;
  /** 链路死/未连通。 */
  linkDown: boolean;
  /** 有等你处理的（对端文件请求）。 */
  attention: boolean;
}): RcHandleState {
  if (p.pointerLocked) return "dim";
  if (p.linkDown) return "bad";
  if (p.attention) return "ask";
  return "idle";
}

export function useRcCapsuleReveal({
  rootRef,
  capRef,
  stageRef,
  pointerLocked,
  kbOn,
  linkDown,
  detailOpen = false,
  hoverReveal = true,
  pendingCount = 0,
}: {
  /** 浮条根（.capZone）——⋯ 面板「点外收起」的 contains 边界。 */
  rootRef: React.RefObject<HTMLDivElement | null>;
  /** 胶囊本体（.capCapsule）——「悬停胶囊保持显示」的命中矩形。
   *  2026-09-27 审查修正：capZone 是全宽容器（left/right:0），原来拿它当悬停
   *  命中矩形 ⇒ 热区是整窗宽的顶部横带——鼠标停在横带内任意处浮条弹出且
   *  永不计时隐藏。改用胶囊自身矩形，热区贴住可见胶囊。 */
  capRef: React.RefObject<HTMLDivElement | null>;
  /** 画面容器（fakeScreen）——mousemove 挂它不挂 window（P2-12）。 */
  stageRef: React.RefObject<HTMLDivElement | null>;
  pointerLocked: boolean;
  /** 键盘已捕获给远端——F10 属远端按键，本条热键让路（见文件头）。 */
  kbOn: boolean;
  /** 链路死/未连通。🔴 乙-⑥ 起**不**参与锁显，只决定把手染红 + 异常那一刻展开一次。 */
  linkDown: boolean;
  /** ⓘ 连接详情面板展开中——与下拉/⋯面板同口径锁显（2026-09-27 审查补），
   *  否则面板随浮条 2.5s 淡出一起被带走。 */
  detailOpen?: boolean;
  /** 🔴 乙-①：顶缘 hover 唤出开关（config.rc_hover_reveal，默认开）。
   *  关掉＝不注册 mousemove，顶缘零触发，唤出只剩常驻把手与 F10。 */
  hoverReveal?: boolean;
  /** 🔴 乙：等你处理的条数（对端文件请求）。增多即自动展开一次，>0 则把手整枚染橙。
   *  增量判据与 RcControlBanner 的 prevAsks 同口径：并发第二条不重复弹首显。 */
  pendingCount?: number;
}) {
  const [shown, setShown] = useState(true);
  /** 🔴 甲方案：顶缘唤出后的「不参与命中测试」窗口期（F10 / 悬停本体唤出不走它）。 */
  const [thru, setThru] = useState(false);
  /** 展开中的下拉数（画质/画面/码率，经 RcDropdown.onOpenChange 汇报）。 */
  const [menusOpen, setMenusOpen] = useState(0);
  /** ⋯ 面板展开中。面板 DOM 在浮条 root 内，但开合是组件状态，一并收在这里。 */
  const [moreOpen, setMoreOpen] = useState(false);
  const hideTimer = useRef<number | null>(null);
  /** 顶缘 dwell 计时（离开热区即取消，穿过就不唤出）。 */
  const dwellTimer = useRef<number | null>(null);
  const thruTimer = useRef<number | null>(null);
  /** 首显 15s 计时是否还在跑（决定异常恢复后走剩余首显还是 2.5s 淡出）。 */
  const initialPendingRef = useRef(true);
  /**
   * 🔴 再审计 B11（2026-09-25）：首显的**截止时刻**（挂载时刻 + INITIAL_SHOW_MS）。
   * 挂载即锁显（乙-⑥ 前是 connecting，现在是 ⋯ 面板/下拉/ⓘ 详情）会让锁显
   * effect 清掉首显计时，此前没有
   * 这个记录，解锁分支无从知道「还剩多久」，首显就永远不淡出了。
   */
  const initialDeadlineRef = useRef(0);
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
    // 2026-09-27 审查修正：到点时若指针仍悬停在胶囊上就不隐藏——「悬停保持」
    // 原先完全靠 mousemove 驱动，光标静止在胶囊上时（无 mousemove）浮条会
    // 从光标正下方淡出，正是「要点的时候它消失」的来源。
    hideTimer.current = window.setTimeout(() => {
      if (!capRef.current?.matches(":hover")) setShown(false);
    }, AUTO_HIDE_MS);
  }, [capRef, clearTimer]);

  const cancelDwell = useCallback(() => {
    if (dwellTimer.current != null) {
      window.clearTimeout(dwellTimer.current);
      dwellTimer.current = null;
    }
  }, []);

  /**
   * 顶缘唤出的那一下：浮条出现，但先让开命中测试 200ms——用户这一击是冲远端
   * 顶缘的内容（标签 ✕ / 地址栏）去的，不是冲浮条来的。
   */
  const revealThrough = useCallback(() => {
    dwellTimer.current = null;
    setShown(true);
    scheduleHide();
    setThru(true);
    if (thruTimer.current != null) window.clearTimeout(thruTimer.current);
    thruTimer.current = window.setTimeout(() => {
      thruTimer.current = null;
      setThru(false);
    }, REVEAL_THROUGH_MS);
  }, [scheduleHide]);

  // 卸载收口：两个计时器都不该在组件死后还写 state。
  useEffect(
    () => () => {
      cancelDwell();
      if (thruTimer.current != null) window.clearTimeout(thruTimer.current);
    },
    [cancelDwell],
  );

  // 首显：挂载即显示，15s 无交互后淡出。
  // 🔴 B11：同时记下截止时刻——锁显（connecting 等）会清掉这个计时，解锁后
  // 要按剩余时长重排，没有它首显永远不淡出。
  useEffect(() => {
    initialDeadlineRef.current = Date.now() + INITIAL_SHOW_MS;
    hideTimer.current = window.setTimeout(() => {
      initialPendingRef.current = false;
      if (!capRef.current?.matches(":hover")) setShown(false);
    }, INITIAL_SHOW_MS);
    return clearTimer;
  }, [capRef, clearTimer]);

  const locked = rcCapsuleLockOf({ menusOpen, moreOpen, detailOpen });

  useEffect(() => {
    lockRef.current = locked;
    if (locked) {
      clearTimer();
      setShown(true);
      return;
    }
    // 🔴 再审计 B11（2026-09-25）：解锁瞬间首显窗口还开着时，原实现只调
    // scheduleHide 的判据写反了场景——挂载即锁显时 initialPending 仍为 true，
    // 这里什么都不排，shown 恒 true。现在：
    // 按首显截止时刻算剩余，>0 按剩余时长重排「到期淡出」，≤0 说明首显
    // 窗口实际已过，走正常 2.5s 淡出。清旧排新，锁显期间不会被反复重排。
    // ⚠️ 乙-⑥ 起「挂载即锁显」的触发者从 connecting 变成 ⋯ 面板/下拉/ⓘ 详情
    //（链路异常不再锁显了），机制本身原样保留。
    clearTimer();
    if (initialPendingRef.current) {
      const remain = initialDeadlineRef.current - Date.now();
      if (remain > 0) {
        hideTimer.current = window.setTimeout(() => {
          initialPendingRef.current = false;
          if (!capRef.current?.matches(":hover")) setShown(false);
        }, remain);
      } else {
        scheduleHide();
      }
      return;
    }
    // 解锁瞬间：首显窗口已过（期间有过交互）→ 正常 2.5s 淡出
    scheduleHide();
  }, [locked, clearTimer, scheduleHide, capRef]);

  /**
   * 🔴 乙-⑥（2026-09-29）：链路异常不再永久锁显，改成「异常发生的那一刻自动展开
   * 一次」+ 把手常驻染红。告知职责已经由不被卸载的那一层接走（design 稿 §0 R3），
   * 再拿 12–46 的遮挡带换告知就是回到甲方案要修的原点。
   * prev 三态：null = 挂载（首显 15s 正在跑，不该被 2.5s 收起抢掉）；只有
   * false→true 才是「新异常」，true→true 不重复打扰。
   */
  const prevLinkDownRef = useRef<boolean | null>(null);
  useEffect(() => {
    const prev = prevLinkDownRef.current;
    prevLinkDownRef.current = linkDown;
    if (linkDown && prev === false) {
      setShown(true);
      scheduleHide();
    }
  }, [linkDown, scheduleHide]);

  /** 同上口径：对端文件请求增多＝有新东西等你处理，自动展开一次，染橙常驻。 */
  const prevPendingRef = useRef<number | null>(null);
  useEffect(() => {
    const prev = prevPendingRef.current;
    prevPendingRef.current = pendingCount;
    if (pendingCount > 0 && prev != null && pendingCount > prev) {
      setShown(true);
      scheduleHide();
    }
  }, [pendingCount, scheduleHide]);

  // 唤出监听挂在画面容器上（不挂 window，P2-12）
  // 🔴 乙-①：hoverReveal 关掉时**整条 effect 不注册**——「顶缘零触发」必须是
  // 真的没有监听，而不是监听了但忽略，否则 dwell 计时器还在偷偷跑。
  // 代价说清楚：关掉后「悬停胶囊保持显示」也不再由 mousemove 驱动，靠
  // scheduleHide 到点时的 `:hover` 复检兜底（光标停在胶囊上就不会收起）。
  useEffect(() => {
    if (!hoverReveal) return;
    const stage = stageRef.current;
    if (!stage) return;
    const onMove = (e: MouseEvent) => {
      if (pointerLocked) return; // 锁定指针时假光标唤不出（见文件头 🔴）
      const r = capRef.current?.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      const inStage =
        e.clientX >= s.left && e.clientX <= s.right && e.clientY >= s.top && e.clientY <= s.bottom;
      if (!inStage || !r) return;
      const overCap =
        e.clientX >= r.left - 4 && e.clientX <= r.right + 4 && e.clientY >= r.top - 4 && e.clientY <= r.bottom + 4;
      const inBand = e.clientY - s.top <= REVEAL_BAND_PX;
      // 四档判断收口在 rcRevealGestureOf（纯函数，守卫单测钉住——规则 11.1）。
      switch (rcRevealGestureOf({ overCap, inBand, shown })) {
        case "hold":
          // 悬停在胶囊上：保持可见，不计时（正在去点按钮）；dwell 白排了，取消。
          cancelDwell();
          setShown(true);
          clearTimer();
          break;
        case "keep":
          // 已显示且沿顶缘移动：续淡出计时，不该把它抽走。
          cancelDwell();
          scheduleHide();
          break;
        case "dwell":
          // 甲方案②：进带先站住 180ms 才算唤出意图，快速穿过顶缘不弹。
          // 到点走 revealThrough——甲方案③：弹出后 200ms 不参与命中测试。
          if (dwellTimer.current == null) {
            dwellTimer.current = window.setTimeout(revealThrough, REVEAL_DWELL_MS);
          }
          break;
        case "idle":
          // 离开热区：未及期的 dwell 直接作废（这正是「穿过不弹」的机制）。
          cancelDwell();
          break;
      }
    };
    stage.addEventListener("mousemove", onMove);
    // 指针离开画面 ⇒ dwell 意图作废：人都走了还弹出浮条是凭空冒 UI。
    const onLeave = () => cancelDwell();
    stage.addEventListener("mouseleave", onLeave);
    return () => {
      // 🔴 重挂（shown / pointerLocked / hoverReveal 变了都会）时必须连在飞的
      // dwell 一起作废：只摘监听的话，那 180ms 的计时器还活着，到点照样
      // revealThrough——「关掉顶缘唤出之后浮条又自己弹出来」就是这一条。
      cancelDwell();
      stage.removeEventListener("mousemove", onMove);
      stage.removeEventListener("mouseleave", onLeave);
    };
  }, [capRef, stageRef, pointerLocked, shown, hoverReveal, clearTimer, scheduleHide, cancelDwell, revealThrough]);

  /**
   * 🔴 乙的主入口：点把手 ⇄ 展开/收起胶囊（F10 是同一条，两者共用避免口径分叉）。
   * 收起时清掉在飞的淡出计时——留着它只是再写一次 false，但会把「重新展开」
   * 的下一次淡出时机算进上一次点击，读数与手感不一致。
   */
  const toggle = useCallback(() => {
    setShown((v) => {
      const next = !v;
      if (next) scheduleHide();
      else clearTimer();
      return next;
    });
  }, [scheduleHide, clearTimer]);

  // 方案 A（2026-09-28）：F10 唤出/收起——原 RcFullscreenHotbar 的热键随浮条统一
  // 上收到这里，窗口态与全屏态同一条键（规则 17：键盘是加速器，鼠标全流程可达）。
  // 捕获键盘（kbOn）或锁指针时 F10 属远端交互，热键不生效；面板/模态展开时让路
  // （口径与 Esc 一致，见 17.6）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F10" || e.ctrlKey || e.altKey || e.metaKey) return;
      if (kbOn || pointerLocked) return;
      if (rcPanelOpenCount() > 0 || document.querySelector(".dialog-backdrop")) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kbOn, pointerLocked, toggle]);

  const menuDelta = useCallback((o: boolean) => {
    setMenusOpen((c) => Math.max(0, c + (o ? 1 : -1)));
  }, []);

  // 🔴 再审计（Esc 两级取消，2026-09-25）：⋯ 面板展开期间向 rcPanelFocus 登记，
  // useRcInput 的 window 级 Esc 兜底据此让路，不再直落「结束会话」确认（规则
  // 17.6：Esc 先回上一步）；同时补「Esc 收起自己」——监听挂 document（冒泡先于
  // window 上的兜底），stopPropagation 防穿透。register/unregister 在 effect 与
  // cleanup 里严格配对，StrictMode 双挂载也平衡。
  useEffect(() => {
    if (!moreOpen) return;
    registerRcPanel();
    const onEsc = (e: KeyboardEvent) => {
      if (!isSessionEscape(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setMoreOpen(false);
    };
    document.addEventListener("keydown", onEsc);
    return () => {
      unregisterRcPanel();
      document.removeEventListener("keydown", onEsc);
    };
  }, [moreOpen]);

  // ⋯ 面板：点外面收（同 RcHud 口径）
  useEffect(() => {
    if (!moreOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Element | null;
      // 再审计 A9（2026-09-25）：RcDropdown 的菜单 portal 在 document.body 上，
      // 不在 rootRef 里——不豁免的话，点菜单项的 mousedown 被判「点在外面」，
      // 面板连同菜单在 click 派发前被整体卸载，onPick 永远不执行
      //（码率下拉曾是会话内唯一改档入口，整个坏死）。
      if (t?.closest?.("[data-rc-portal-menu]")) return;
      if (!rootRef.current?.contains(t as Node)) setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [moreOpen, rootRef]);

  const handleState = rcHandleStateOf({
    pointerLocked,
    linkDown,
    attention: pendingCount > 0,
  });

  return { shown, thru, moreOpen, setMoreOpen, menuDelta, scheduleHide, toggle, handleState };
}
