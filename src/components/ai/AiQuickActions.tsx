/**
 * AiQuickActions —— AI 快捷区的动作按钮组（从 AiQuickBar 抽出，规则 #7）。
 *
 * 自己拥有拖拽排序的全部状态（order + localStorage + dragIdx）：
 * 那三个东西只有这一排按钮在用，放在父级就是白白往上提一层。
 * 排序算法本身在 lib/quickOrder.ts（纯函数、有单测）。
 */
import { useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { applyQuickOrder, reorderAction } from "@/lib/quickOrder";
import type { QuickAction } from "@/lib/aiQuick";
import { EMPTY_ACTION_STATE, type ActionState } from "./quickTypes";
import styles from "../AiQuickBar.module.css";

/** 拖拽排序的持久化 key */
const ORDER_KEY = "pastepanda_quickbar_order";

export function AiQuickActions({
  actions,
  states,
  onRun,
  onMore,
}: {
  actions: QuickAction[];
  states: Record<string, ActionState>;
  onRun: (a: QuickAction) => void;
  onMore: () => void;
}) {
  const [order, setOrder] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  // 不在记录里的排后面，保持内容驱动
  const sorted = useMemo(() => applyQuickOrder(actions, order), [actions, order]);
  const dragIdx = useRef(-1);

  const dropReorder = (from: number, to: number) => {
    const next = reorderAction(sorted.map((a) => a.id), from, to);
    if (!next) return;
    setOrder(next);
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(next));
    } catch {
      /* 忽略 */
    }
  };

  return (
    <div className={styles.acts}>
      {sorted.map((a, i) => {
        const st = states[a.id] ?? EMPTY_ACTION_STATE;
        const running = st.status === "loading";
        return (
          <button
            key={a.id}
            className={`${styles.q}${a.ai ? ` ${styles.qAi}` : ` ${styles.qLocal}`}${running ? ` ${styles.qRunning}` : ""}`}
            onClick={() => onRun(a)}
            disabled={running}
            draggable
            onDragStart={() => {
              dragIdx.current = i;
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              dropReorder(dragIdx.current, i);
              dragIdx.current = -1;
            }}
            title={
              a.ai
                ? `${a.label}（AI 服务：这条内容会发送给你配的服务商，按用量计费）· 长按拖动排序`
                : `${a.label}（本地处理，不出网、零成本）· 长按拖动排序`
            }
          >
            {running ? (
              <Loader2 size={11} className="spin" />
            ) : a.ai ? (
              // 计费动作必须在点之前就看得出来：✦ 前缀 + accent 描边；本地动作保持中性
              <span className={styles.aiMark} aria-hidden="true">✦</span>
            ) : (
              <span className={styles.locTag} aria-hidden="true">本地</span>
            )}
            {/* 本地动作不能说「AI 思考中」（反向误导：让免费动作看起来在花钱/出网） */}
            {running ? (a.ai ? "AI 思考中…" : "处理中…") : a.label}
          </button>
        );
      })}
      <button className={`${styles.q} ${styles.more}`} onClick={onMore}>
        更多…
      </button>
    </div>
  );
}
