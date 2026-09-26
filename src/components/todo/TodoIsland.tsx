/**
 * 待办灵动岛 —— 屏幕顶部居中的常驻小窗（展开态版）。
 *
 * ## 五个舞台（与 `todo_island_stage.rs::stage_size` 是同一份账）
 *
 * pill 208×32 → peek 300×40（悬停）→ list 420×240（点击）→ compose 420×280（记一条）；
 * 全清 clear 208×32 → 1500ms 后收起（epoch 可作废）。
 *
 * ## 窗口几何与动画的分工（2026-09-25 档 3a 修订）
 *
 * 窗口级材质按**窗口矩形**铺：若窗口一次切到位而 CSS 还在过渡，两者之间会露出一圈玻璃
 * （浅色主题下是用户反馈的「白板」）。所以尺寸动画的**唯一来源**改在 Rust 侧逐帧驱动
 * （`todo_island_set_stage` 内 16ms 步进插值），CSS 卡片改为**永远填满窗口**（inset:0），
 * 每帧与窗口同步——本组件只负责切 `data-st` 与发一次 `setStage`，不再管 resize 时机。
 *
 * ## 内容层与形体分拍（B 方案：形体先响应、内容随后出现）
 *
 * 两层内容（折叠层 / 列表层）都绝对定位铺满窗口，交接节拍由 `useIslandContentPhase`
 * 单一控制：展开时折叠内容先退、列表延后淡入；收起时列表先退、胶囊内容后回。
 * 快速反向只保留最后目标（旧计时器会被作废），见那个 Hook 的注释。
 *
 * ## 收起的三条路（2026-09-25 审计修复后）
 *
 * - **点外闲置自收**：岛不抢焦点、窗外点击穿透，展开态若不自动收就只能手动关
 *   （审计「没有点外收起」）。鼠标离开岛 6s 自动收回胶囊；compose 里有没提交的
 *   文字时不收——不能把用户打了一半的话收没了。
 * - **全清自动收**只在胶囊两态（pill/peek）生效：用户正在 list/compose 里操作时
 *   不许把岛从手底下抽走（原来勾完最后一条列表会被强制收走，审计修复）；
 *   用户收起那一刻才按「还剩 0 条」补走 clear + 延迟隐藏。
 * - **Rust 舞台复位**：hide 时 Rust 广播 stage-reset，前端同步回胶囊（否则下次
 *   点亮窗口按旧展开尺寸出现）。
 *
 * 🔴 不引 `appStore`：这是**独立的 JS 上下文**，主窗口的 zustand store 一个字段都拿不到。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useIslandState, requestShow, requestDelayedHide, setStage } from "@/lib/todo/islandBridge";
import type { IslandState, IslandStage } from "@/lib/todo/types";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useIslandContentPhase } from "./useIslandContentPhase";
import { TodoIslandList } from "./TodoIslandList";
import styles from "./TodoIsland.module.css";

/** 进度环周长 = 2πr（r = 6.5，与 CSS 里 `circle r="6.5"` 是同一份账） */
const RING_CIRC = 2 * Math.PI * 6.5;
/** 展开态鼠标离开多久后自动收起。读列表需要时间，给足；比胶囊 2.5s 宽一倍多。 */
const AUTO_COLLAPSE_MS = 6000;
/** 失败提示的自退场时长：够读完一句话，又不常驻挡列表 */
const NOTICE_MS = 3200;

/** hover 视觉：由 Rust 的光标轮询广播（60ms 滞回判定），**不是 CSS :hover**——窗口默认穿透。 */
function useHoverVisual(): boolean {
  const [hover, setHover] = useState(false);
  useEffect(() => {
    const off = listen<boolean>("todo-island-hover", (e) => setHover(e.payload));
    return () => void off.then((f) => f());
  }, []);
  return hover;
}

export function TodoIsland() {
  const state: IslandState = useIslandState();
  const hover = useHoverVisual();
  const [stage, setStageState] = useState<IslandStage>("pill");
  // goStage 会在事件回调里被读：ref 保证拿到的是最新值，不把 stage 挂进依赖链
  const stageRef = useRef<IslandStage>("pill");
  // state 的 ref：collapseToPill 要在回调里判断「还剩几条」，不能把 state 挂依赖
  const stateRef = useRef(state);
  stateRef.current = state;
  // compose 草稿挂在岛层：自动收起要判断「有没打完的字」，收起不销毁草稿
  const [composeText, setComposeText] = useState("");
  const composeTextRef = useRef("");
  composeTextRef.current = composeText;
  // 失败提示提在**岛层**：勾选/输入的失败可能发生在列表正要收起的那一刻，
  // 提示必须留在触发它的那个可见域里（规则 §15.1 / §15.3），不能随列表一起被卸载。
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  const flashNotice = useCallback((msg: string | null) => {
    window.clearTimeout(noticeTimer.current);
    if (!msg) {
      setNotice(null);
      return;
    }
    setNotice(msg);
    noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  // 内容层交接节拍（右）与系统「减少动态效果」（左）分开喂：Hook 只管时序，
  // 不自己探环境，无环境也能被单测。
  const reducedMotion = usePrefersReducedMotion();
  const phase = useIslandContentPhase(stage, reducedMotion);

  /** 切舞台：发一次 setStage，窗口动画由 Rust 逐帧驱动（见文件头「分工」）。 */
  const goStage = useCallback((next: IslandStage) => {
    if (stageRef.current === next) return;
    stageRef.current = next;
    setStageState(next);
    setStage(next);
  }, []);

  /**
   * 收回胶囊 = 通用出口（手动收起 / Esc / 闲置自收共用）。全清口径收在这里：
   * 收回那一刻还剩 0 条 → 走 clear + 延迟隐藏，让「全清」的庆祝态只在
   * 用户真的离开列表时出现。
   */
  const collapseToPill = useCallback(() => {
    goStage("pill");
    if (stateRef.current.tasks.length === 0) {
      goStage("clear");
      requestDelayedHide();
    }
  }, [goStage]);

  // 悬停 ↔ 收起：Rust 轮询的滞回判定驱动，只在胶囊两态间横跳，不打扰展开态
  useEffect(() => {
    if (hover && stageRef.current === "pill") goStage("peek");
    else if (!hover && stageRef.current === "peek") collapseToPill();
  }, [hover, goStage, collapseToPill]);

  // 全清 ⇄ 复活：clear 态只从「用户收起且剩 0 条」（collapseToPill）进入——
  // 数据清空时**不许**把展开中的列表从用户手底下抽走（审计：勾完最后一条
  // 列表被强制收走）。复活：全清收起期间新任务到达 → 取消收起回胶囊。
  useEffect(() => {
    if (state.tasks.length > 0 && stageRef.current === "clear") {
      requestShow(); // 递增代次 → 作废挂起的延迟隐藏
      goStage("pill");
    }
  }, [state, goStage]);

  // 展开态点外闲置自收（规则 18.3「一键可推翻」）：鼠标离开 6s 收回。
  // hover 事件由 Rust 轮询在进/出沿广播——hover=false 期间挂计时器，
  // 回到岛上即清理。compose 有草稿时不收（见 collapseToPill 上方说明）。
  useEffect(() => {
    if (hover || (stage !== "list" && stage !== "compose")) return;
    const timer = window.setTimeout(() => {
      if (stageRef.current === "compose" && composeTextRef.current.trim().length > 0) return;
      collapseToPill();
    }, AUTO_COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [hover, stage, collapseToPill]);

  // Rust hide() 会广播舞台复位（窗口被收起时前端可能停在任意舞台），
  // 不同步的话下次点亮窗口按旧展开尺寸出现。已在胶囊/全清态时是幂等空转。
  useEffect(() => {
    const off = listen("todo-island-stage-reset", () => goStage("pill"));
    return () => void off.then((f) => f());
  }, [goStage]);

  // 两级取消（规则 17.6）：Esc 先从输入态回列表、再收回胶囊；到胶囊为止
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const cur = stageRef.current;
      if (cur === "compose") goStage("list");
      else if (cur === "list" || cur === "peek") collapseToPill();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goStage, collapseToPill]);

  const remain = Math.max(0, state.total - state.done);
  const progress = state.total > 0 ? Math.min(1, Math.max(0, state.done / state.total)) : 0;

  // 提醒态（二期甲案：岛即提醒）：到点的那条占住胶囊——铃 + 红「到点了」+ 任务文字。
  // 数字环退位（信息让位给事件）；只在收起两态接管，展开列表用 chip 呈现同一条。
  // 横幅 30s 由 Rust 清账收回；点击（去列表）或勾掉该条也会立即结束。
  // 🔴 提醒态**只显示这一条的文字**：胶囊 32px 高装不下两句话，把下一条待办
  //    也拼上来就是两条任务文字并排（设计稿明令禁止）。
  const alert = state.dueAlert ?? null;
  const reminding = alert !== null && (stage === "pill" || stage === "peek");
  const collapsedStage = stage !== "list" && stage !== "compose";

  // peek 比 pill 只多露一件事：下一条待办的**真实**到期时间。没有就不显示——
  // 宁可少说一句，也不编一个演示时间替用户编日程。
  const nextDue = !reminding && stage === "peek" ? state.tasks[0] : undefined;
  const nextDueLabel = nextDue?.dueLabel ?? "";
  const nextDueOver =
    nextDue !== undefined &&
    !nextDue.done &&
    typeof nextDue.dueMs === "number" &&
    nextDue.dueMs < Date.now();

  // 折叠态的统一内容：环 + 剩余数 + 一句话（clear 态把环换成勾；提醒态整段换掉）
  const collapsed = reminding ? (
    <>
      <svg className={styles.bell} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M8 2.5a3.5 3.5 0 0 0-3.5 3.5c0 3-1.5 4-1.5 4h10s-1.5-1-1.5-4A3.5 3.5 0 0 0 8 2.5z" />
        <path d="M6.8 12.5a1.3 1.3 0 0 0 2.4 0" />
      </svg>
      <span className={styles.remindWord}>到点了</span>
      <span className={styles.sepdot} />
    </>
  ) : stage === "clear" ? (
      <span className={styles.okmark} aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="M3 8.5l3.4 3.4L13 5" />
        </svg>
      </span>
    ) : (
      <>
        <svg className={styles.ring} viewBox="0 0 16 16" aria-hidden="true">
          <circle className={styles.tk2} cx="8" cy="8" r="6.5" />
          <circle
            className={styles.arc}
            cx="8"
            cy="8"
            r="6.5"
            strokeDasharray={RING_CIRC}
            strokeDashoffset={RING_CIRC * (1 - progress)}
          />
        </svg>
        <span className={styles.cnt}>{remain}</span>
        <span className={styles.sepdot} />
      </>
    );

  const collapsedHint = stage === "clear" ? "今天没有待办了" : state.hint || "今天没有待办";

  return (
    <div
      className={styles.root}
      data-st={stage}
      data-hover={hover && (stage === "pill" || stage === "peek") ? "1" : undefined}
      onClick={collapsedStage ? () => goStage("list") : undefined}
      role={collapsedStage ? "button" : undefined}
      aria-label={collapsedStage ? "展开待办列表" : undefined}
    >
      {phase.collapsed.mounted ? (
        <div className={styles.collapsedLayer} data-on={phase.collapsed.visible ? "1" : undefined}>
          {collapsed}
          {nextDueLabel ? (
            <>
              <span className={styles.sepdot} />
              <span className={nextDueOver ? styles.peekDueOver : styles.peekDue}>{nextDueLabel}</span>
            </>
          ) : null}
          {/* 这一格在三者之间轮换：失败提示（就地替换提示文字）/ 提醒的那条 / 下一条待办。
              pill 只有 32px 高且 overflow:hidden，浮层会被裁掉，所以错误也只能占这一格。 */}
          <span
            className={notice ? styles.noticeInline : styles.last}
            role={notice ? "alert" : undefined}
          >
            {notice ?? (reminding ? alert?.text : collapsedHint)}
          </span>
        </div>
      ) : null}

      {phase.expanded.mounted ? (
        <div className={styles.expandedLayer} data-on={phase.expanded.visible ? "1" : undefined}>
          <TodoIslandList
            state={state}
            compose={stage === "compose"}
            composeText={composeText}
            onComposeText={(s) => setComposeText(s)}
            onCollapse={collapseToPill}
            onComposeOpen={() => goStage("compose")}
            onNotice={flashNotice}
          />
        </div>
      ) : null}

      {/* 列表态的失败提示：浮在列表底部（勾选/输入的触发点就在列表里）。
         折叠态改由 collapsedLayer 内的 noticeInline 承担，二者互斥不会同时出现。 */}
      {notice && !collapsedStage ? (
        <div className={styles.notice} role="alert">
          {notice}
        </div>
      ) : null}
    </div>
  );
}