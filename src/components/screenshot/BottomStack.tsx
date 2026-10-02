import { Fragment, type ReactNode, type Ref } from "react";

/**
 * 底部带（回执 / 取色 / 强度 / OCR 回执 / 找回 / 快捷键提示）的单一所有者。
 *
 * 抽出来的原因（审计 §3）：这一排浮层原来各写各的 `bottom` —— 16 / 64 / 16 / 16，
 * 谁让位给谁靠手写数字维持。实测结果：
 *   · 同一个状态里两条都写 16 → 直接叠在一起（120 组扫描出 30 组带内互叠）；
 *   · OCR 回执手写 `bottom: 64` 躲第一条，再加一条就没人在管了；
 *   · 快捷键条同时吃到 `top:16` 与 `bottom:16` 两条规则，被拉成满屏高。
 * 现在成员不声明定位，位置只有一个来源：父组件用 layoutBand 算出的 left/bottom。
 *
 * 上限 2 行：截图是「按一下就要走」的高频动作，底部堆三层就成了一块面板。
 * 超出的按优先级挤掉（错误 > 找回 > 进度 > 回执 > 提示），而不是折叠成可展开。
 */

/** 挤位优先级：数字小 = 越该留在屏幕上 */
export const BAND_PRIO = {
  error: 0,
  tray: 1,
  progress: 2,
  receipt: 3,
  hint: 4,
} as const;

export type BandPrio = keyof typeof BAND_PRIO;

export interface BandRow {
  key: string;
  prio: BandPrio;
  node: ReactNode;
}

/** 同屏最多几行（超出挤掉最低优先级） */
export const BAND_MAX_ROWS = 2;

/**
 * 从候选行里挑出要显示的，保持调用方给出的**上下顺序**不变。
 *
 * 顺序为什么不由优先级排：优先级决定「谁被挤掉」，数组顺序决定「谁在上面」，
 * 两件事混在一个排序键里会让行位置随内容跳变（回执从下排跳到上排）。
 */
export function pickBandRows(rows: BandRow[], max = BAND_MAX_ROWS): BandRow[] {
  const live = rows.filter((r) => r.node != null);
  if (live.length <= max) return live;
  return live
    .map((r, i) => ({ r, i }))
    .sort((a, b) => BAND_PRIO[a.r.prio] - BAND_PRIO[b.r.prio] || a.i - b.i)
    .slice(0, max)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.r);
}

export default function BottomStack({
  rows,
  left,
  bottom,
  innerRef,
}: {
  rows: BandRow[];
  /** layoutBand 算出的左边缘（CSS 像素） */
  left: number;
  /** layoutBand 算出的下边距（CSS 像素） */
  bottom: number;
  /** 父组件要量整条带的宽高，才能算 bandRect 给抽屉避让 */
  innerRef: Ref<HTMLDivElement>;
}) {
  const shown = pickBandRows(rows);
  if (shown.length === 0) return null;
  return (
    <div className="bottom-stack" ref={innerRef} style={{ left, bottom }}>
      {shown.map((r) => (
        // Fragment（带 key）不产生 DOM 节点：行元素本身才是 .bottom-stack 的直接子元素，
        // `.bottom-stack > *` 的定位作废规则才落得到它们身上。
        <Fragment key={r.key}>{r.node}</Fragment>
      ))}
    </div>
  );
}
