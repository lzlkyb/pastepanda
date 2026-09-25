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
 * 🔴 不引 `appStore`：这是**独立的 JS 上下文**，主窗口的 zustand store 一个字段都拿不到。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useIslandState, requestShow, requestDelayedHide, setStage } from "@/lib/todo/islandBridge";
import type { IslandState } from "@/lib/todo/types";
import { TodoIslandList } from "./TodoIslandList";
import styles from "./TodoIsland.module.css";

/** 进度环周长 = 2πr（r = 6.5，与 CSS 里 `circle r="6.5"` 是同一份账） */
const RING_CIRC = 2 * Math.PI * 6.5;

type Stage = "pill" | "peek" | "list" | "compose" | "clear";

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
  const [stage, setStageState] = useState<Stage>("pill");
  // goStage 会在事件回调里被读：ref 保证拿到的是最新值，不把 stage 挂进依赖链
  const stageRef = useRef<Stage>("pill");

  /** 切舞台：发一次 setStage，窗口动画由 Rust 逐帧驱动（见文件头「分工」）。 */
  const goStage = useCallback((next: Stage) => {
    if (stageRef.current === next) return;
    stageRef.current = next;
    setStageState(next);
    setStage(next);
  }, []);

  // 悬停 ↔ 收起：Rust 轮询的滞回判定驱动，只在胶囊两态间横跳，不打扰展开态
  useEffect(() => {
    if (hover && stageRef.current === "pill") goStage("peek");
    else if (!hover && stageRef.current === "peek") goStage("pill");
  }, [hover, goStage]);

  // 全清 ⇄ 复活：勾完最后一条 → 全清态 + 1500ms 收起；期间新任务到达 → 取消收起回胶囊
  useEffect(() => {
    const cur = stageRef.current;
    if (state.tasks.length === 0 && (cur === "list" || cur === "compose" || cur === "peek")) {
      goStage("clear");
      // 延迟隐藏在 Rust 侧执行（代次作废机制在那边）；这里只发起
      requestDelayedHide();
    } else if (state.tasks.length > 0 && cur === "clear") {
      requestShow(); // 递增代次 → 作废挂起的延迟隐藏
      goStage("pill");
    }
  }, [state, goStage]);

  // 两级取消（规则 17.6）：Esc 先从输入态回列表、再回胶囊；到胶囊为止
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const cur = stageRef.current;
      if (cur === "compose") goStage("list");
      else if (cur === "list" || cur === "peek") goStage("pill");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goStage]);

  const remain = Math.max(0, state.total - state.done);
  const progress = state.total > 0 ? Math.min(1, Math.max(0, state.done / state.total)) : 0;

  // 折叠态的统一内容：环 + 剩余数 + 一句话（clear 态把环换成勾）
  const collapsed =
    stage === "clear" ? (
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
  const clickable = stage === "pill" || stage === "peek" || stage === "clear";

  return (
    <div
      className={styles.root}
      data-st={stage}
      data-hover={hover && (stage === "pill" || stage === "peek") ? "1" : undefined}
      onClick={clickable ? () => goStage("list") : undefined}
      role={clickable ? "button" : undefined}
      aria-label={clickable ? "展开待办列表" : undefined}
    >
      {clickable ? (
        <>
          {collapsed}
          <span className={styles.last}>{collapsedHint}</span>
        </>
      ) : (
        <TodoIslandList
          state={state}
          compose={stage === "compose"}
          onCollapse={() => goStage("pill")}
          onComposeOpen={() => goStage("compose")}
        />
      )}
    </div>
  );
}
