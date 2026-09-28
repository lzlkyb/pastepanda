/**
 * 岛的**内容活性三动效**（design/待办灵动岛-内容活性三动效-设计稿.html）：
 *
 * ① 实时递减——peek 态临近到期（<1h）的 dueMs 现算 mm:ss 走字；跨 0 线触发一次脉冲。
 * ② 事件脉冲——新待办到达 / 提醒点火 / 全清进入，分别给果冻脉冲 / 铃 shake / 勾描画。
 * ③ glow 跟随光标——拦截期 pointermove 直写 `--glow-x` CSS 变量（合成友好，不触发 layout）。
 *
 * 🔴 规则 8 总红线：三者全部**事件驱动、放完即停**——
 *    - 递减 interval 只在 peek 激活期存在（active 值由调用方随舞台切换重算，离开即清）；
 *    - 脉冲是挂 class + animationend 摘除的一次性动画，平时零合成层；
 *    - glow 监听挂在 JSX 上，穿透期光标事件根本到不了窗口，天然零开销。
 *    系统「减少动态效果」开启时全部短路（信息不变，只去掉运动）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { IslandState, IslandStage } from "@/lib/todo/types";

/** 递减视野：剩余 <1h 才走字；>1h 保持静态 dueLabel（设计稿 §1） */
const LIVE_DUE_HORIZON_MS = 3_600_000;
/** 「新待办」静默窗：挂载后这段时间内的 tasks 增长视为初始化/批量灌入，不是事件（设计稿 §2） */
const MOUNT_QUIET_MS = 1000;
/** glow 几何缓存的有效期：见动效三注释（窗口逐帧动画期间避免每拍强制布局） */
const GLOW_RECT_TTL_MS = 120;

/** 纯函数：剩余毫秒 → mm:ss（负值钳到 00:00；视野 1h 内 mm ≤ 59）。 */
export function formatMmSs(remainMs: number): string {
  const clamped = Math.max(0, remainMs);
  const m = Math.floor(clamped / 60_000);
  const s = Math.floor((clamped % 60_000) / 1000);
  return `${m < 10 ? "0" + m : m}:${s < 10 ? "0" + s : s}`;
}

export interface IslandVitalityInput {
  state: IslandState;
  stage: IslandStage;
  reducedMotion: boolean;
  hover: boolean;
  intent: boolean;
}

export function useIslandVitality(input: IslandVitalityInput) {
  const { state, stage, reducedMotion, hover, intent } = input;

  // ===== 动效一：实时递减 =====
  // peek 那条的 dueMs 在这里闭包判定（stage/提醒态/全天任务/1h 视野），组件只拿 label。
  // ❗ 视野判定随渲染发生：若 peek 长挂到任务跨入 1h 而期间无任何渲染，会晚一拍才开始走字——
  //   可接受（peek 通常由 hover 驱动进出，期间 state 推送也会触发重算）。
  const reminding = state.dueAlert != null && (stage === "pill" || stage === "peek");
  const nextDue = !reminding && stage === "peek" ? state.tasks[0] : undefined;
  const liveDueMs =
    nextDue?.dueHasTime !== false &&
    typeof nextDue?.dueMs === "number" &&
    nextDue.dueMs - Date.now() < LIVE_DUE_HORIZON_MS
      ? nextDue.dueMs
      : undefined;

  const [dueLabel, setDueLabel] = useState<string | null>(null);
  // 「观察到过正数才报跨线」：用户点开 peek 时任务已过期的，不算事件、不脉冲
  const seenPositive = useRef(false);
  useEffect(() => {
    if (liveDueMs === undefined) {
      setDueLabel(null);
      seenPositive.current = false;
      return;
    }
    // eslint-disable-next-line prefer-const -- tick() 的跨 0 分支要读 timer 停表，只能先声明后赋值
    let timer: number | undefined;
    const tick = () => {
      const remain = liveDueMs - Date.now();
      if (remain > 0) {
        seenPositive.current = true;
        setDueLabel(formatMmSs(remain));
        return;
      }
      setDueLabel(null);
      if (timer !== undefined) window.clearInterval(timer); // 跨线即停表：00:00 不是稳态，交给静态红 label
      if (seenPositive.current && !reducedMotion) setPulsing(true); // 跨 0：翻红（既有 peekDueOver 路径）+ 一次脉冲
    };
    tick();
    timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [liveDueMs, reducedMotion]);

  // ===== 动效二：事件脉冲（优先级：提醒 > 新待办 > 全清；同一拍只各自触发一次） =====
  const [pulsing, setPulsing] = useState(false);
  const [shaking, setShaking] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const prevTasks = useRef<number | null>(null);
  const prevAlert = useRef(false);
  const mountedAt = useRef(Date.now());
  useEffect(() => {
    if (reducedMotion) return;
    const n = state.tasks.length;
    const alertOn = state.dueAlert != null;
    // 首轮只记基线：挂载时已存在的提醒/待办不是「事件」（岛重建不集体跳舞）
    if (prevTasks.current === null) {
      prevTasks.current = n;
      prevAlert.current = alertOn;
      return;
    }
    if (alertOn && !prevAlert.current) {
      setPulsing(true);
      setShaking(true); // 只有提醒点火摇铃；新待办到达不摇
    } else if (
      n > prevTasks.current &&
      Date.now() - mountedAt.current > MOUNT_QUIET_MS
    ) {
      setPulsing(true);
    }
    prevTasks.current = n;
    prevAlert.current = alertOn;
  }, [state, reducedMotion]);
  useEffect(() => {
    if (reducedMotion) return;
    if (stage === "clear") setDrawing(true);
  }, [stage, reducedMotion]);

  const endPulse = useCallback(() => setPulsing(false), []);
  const endShake = useCallback(() => setShaking(false), []);
  const endDraw = useCallback(() => setDrawing(false), []);

  // ===== 动效三：glow 跟随光标 =====
  // 拦截生效后 webview 才收得到 pointermove（Rust 收事件 ⇔ hover/intent），监听天然对齐；
  // 穿透期该处理器根本不会被调用。拒绝 Rust 60ms emit 坐标的方案（跨进程事件风暴，收益为零）。
  // 🔴 rect 不每拍读：getBoundingClientRect 会强制布局，而窗口尺寸正由 Rust 逐帧动画给出，
  //   两者在同一帧里互相触发。缓存 120ms 有效——一次舞台动画约 300ms，期间最多读 3 次，
  //   圆心误差在动画结束后立刻归零（glow 是受光装饰，不是指针跟随精度要求）。
  const glowRect = useRef<{ at: number; left: number; width: number } | null>(null);
  useEffect(() => {
    glowRect.current = null; // 舞台/悬停沿变了，旧几何作废
  }, [stage, hover, intent]);

  const onGlowMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (reducedMotion || (!hover && !intent)) return;
      const now = performance.now();
      if (!glowRect.current || now - glowRect.current.at > GLOW_RECT_TTL_MS) {
        const r = e.currentTarget.getBoundingClientRect();
        glowRect.current = { at: now, left: r.left, width: r.width };
      }
      const { left, width } = glowRect.current;
      if (width <= 0) return;
      const x = ((e.clientX - left) / width) * 100;
      e.currentTarget.style.setProperty("--glow-x", `${x.toFixed(1)}%`);
    },
    [hover, intent, reducedMotion]
  );

  return {
    /** 临近到期的走字文案；null = 走既有静态 dueLabel */
    liveDue: dueLabel,
    pulsing,
    shaking,
    drawing,
    onGlowMove,
    endPulse,
    endShake,
    endDraw,
  };
}
