/**
 * useSplitDrag — 分栏手柄的拖拽逻辑（横/竖通用）。
 *
 * 知识库里现在有两个分栏：
 *   - 竖：第三栏内部的「问答 / 笔记」（`KbThirdPane`）
 *   - 横：中栏笔记列表 与 第三栏（`KnowledgeView`）
 *
 * 两边共用一份（规则 #11）。拆出来的直接原因：本次审查刚刚因为
 * `keyboardActions.ts` 是 `App.tsx` 的平行副本而出过事（测试测副本、
 * 真代码改了没人红）——不能回头又把拖拽逻辑再抄一份。
 *
 * 三个实现要点（都是从现有竖向实现里继承的、有代价的经验）：
 *   ① mousemove/mouseup 监在 **window** 而不是手柄上：拖得快时指针会跑出手柄，
 *      挂手柄上会中途断掉。
 *   ② 像素下限换算成百分比上下限：拖到完全压扁等于把一边弄没了。
 *   ③ 比例的读写与异常兜底已交给 `usePersistedState`（包括「写入必须在 effect 里」
 *      那条约束——updater 在 StrictMode 下会双调）。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { usePersistedState } from "@/hooks/usePersistedState";

interface Options {
  /** "x" = 左右分栏（拖宽度），"y" = 上下分栏（拖高度）。 */
  axis: "x" | "y";
  /** 量尺子：百分比相对的容器。 */
  containerRef: RefObject<HTMLElement | null>;
  /** 前一块（上 / 左）的像素下限。 */
  minFirstPx: number;
  /** 后一块（下 / 右）的像素下限。 */
  minSecondPx: number;
  /** 手柄自身占的像素（与 CSS 保持一致）。 */
  gripPx: number;
  /** 持久化的 key。 */
  storageKey: string;
  /** 读不到持久值时的默认百分比。 */
  defaultRatio: number;
}

export function useSplitDrag({
  axis,
  containerRef,
  minFirstPx,
  minSecondPx,
  gripPx,
  storageKey,
  defaultRatio,
}: Options) {
  // 读/写/异常兜底交给 `usePersistedState`（规则 #11）。
  // 存的是百分比数字，手写解析而不用 JSON：不合法或越界的脏值一律回默认，
  // 不能拿 NaN 去算 flex。
  const [ratio, setRatio] = usePersistedState(storageKey, defaultRatio, {
    parse: (raw) => {
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 && n < 100 ? n : defaultRatio;
    },
    serialize: (v) => String(Math.round(v)),
  });
  /** 拖动中的起点。`null` = 没在拖。 */
  const dragRef = useRef<{ pos: number; ratio: number; size: number } | null>(null);
  const [dragging, setDragging] = useState(false);


  const onGripDown = useCallback(
    (e: React.MouseEvent) => {
      const el = containerRef.current;
      if (!el) return;
      const size = axis === "x" ? el.clientWidth : el.clientHeight;
      if (size <= 0) return;
      e.preventDefault();
      dragRef.current = { pos: axis === "x" ? e.clientX : e.clientY, ratio, size };
      setDragging(true);
    },
    [axis, containerRef, ratio],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const minR = (minFirstPx / d.size) * 100;
      const maxR = ((d.size - minSecondPx - gripPx) / d.size) * 100;
      const delta = (axis === "x" ? e.clientX : e.clientY) - d.pos;
      const next = d.ratio + (delta / d.size) * 100;
      setRatio(Math.min(Math.max(next, minR), Math.max(minR, maxR)));
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      setDragging(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  // setRatio 来自 useState，引用恒定；列进来只是让 eslint 静音。
  }, [axis, gripPx, minFirstPx, minSecondPx, setRatio]);

  /** 双击手柄回默认：拖歪了不用去设置里找。 */
  const reset = useCallback(() => setRatio(defaultRatio), [defaultRatio, setRatio]);

  return { ratio, setRatio, onGripDown, dragging, reset };
}
