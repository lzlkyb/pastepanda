/**
 * 灵动岛内容层的进出时序 —— B 方案「形体先响应、内容随后出现」的唯一控制点。
 *
 * 窗口几何由 Rust 逐帧驱动（`todo_island_stage.rs`），内容层（折叠层 / 列表层）
 * 在这个 Hook 里按节拍交接，两侧不互相猜测：
 *
 * - **展开**：折叠内容立刻退，列表**立刻挂载但不可见、不可点**——窗口一边长大，
 *   内容一边铺满新窗口；`REVEAL_AFTER_MS` 后列表才淡入并就位。中间那一小段
 *   「岛在长、还没有内容」是故意的：先看到形体响应，再看到内容。
 * - **收起**：列表先退（不可点），`COLLAPSE_AFTER_MS` 后胶囊内容回来，
 *   `UNMOUNT_AFTER_MS` 后列表才卸载——退场动画放完才拆 DOM。
 * - **快速反向**：目标一变就作废旧计时器，只保留最后一个目标。
 *   （旧实现在收起/展开两条路径上各挂一个 setTimeout，连续 hover + 点击会让
 *   旧计时器把新状态覆盖回去，表现为「岛卡在错的层」。）
 * - **减少动态效果**：直接切换，不排任何计时器（U2 的口径：信息与操作完整优先）。
 *
 * 三个常量是**节拍**（延迟），不是过渡时长——过渡时长仍在 CSS 里走 U2 四档
 * （150/200/300ms）。`REVEAL_AFTER_MS` 取 115ms 的来处：按本仓弹簧参数
 * （k=130、c=16）解析解，t=115ms 时窗口约走到全程的 45%，再早内容会被仍在
 * 运动中的窗口裁掉半个字。要改手感先改这段注释，别默默改数字。
 */
import { useEffect, useRef, useState } from "react";
import type { IslandStage } from "@/lib/todo/types";

/** 一层内容的可见性 / 可交互性（二者始终同进同退：看不见的东西不许能点）。 */
export interface ContentLayerPhase {
  mounted: boolean;
  visible: boolean;
  interactive: boolean;
}

/** 展开：等窗口开始长大后，列表才淡入并就位 */
const REVEAL_AFTER_MS = 115;
/** 收起：列表先退，胶囊内容随后回来 */
const COLLAPSE_AFTER_MS = 115;
/** 收起：列表退场动画放完才卸载（200ms = U2 允许档） */
const UNMOUNT_AFTER_MS = 200;

export function useIslandContentPhase(
  stage: IslandStage,
  reducedMotion: boolean,
): { collapsed: ContentLayerPhase; expanded: ContentLayerPhase } {
  const expandedStage = stage === "list" || stage === "compose";
  // 初值直接给终态：挂载那一刻没有「上一态」可过渡（若岛一进来就是 list，
  // 内容应当立刻在位，而不是等一个谁都不会来的计时器）。
  const [expandedOn, setExpandedOn] = useState(expandedStage);
  const [expandedMounted, setExpandedMounted] = useState(expandedStage);
  const [collapsedOn, setCollapsedOn] = useState(!expandedStage);

  // 首帧由初值给好了，再跑一遍 effect 会把「没有过渡」误判成一次收起
  //（表现：胶囊亮起来先空 115ms 才出内容）。
  const primed = useRef(false);

  useEffect(() => {
    if (!primed.current) {
      primed.current = true;
      return;
    }
    // 减少动态效果：不走节拍，目标即终态（不留半透明中间态）
    if (reducedMotion) {
      setExpandedOn(expandedStage);
      setExpandedMounted(expandedStage);
      setCollapsedOn(!expandedStage);
      return;
    }
    if (expandedStage) {
      setCollapsedOn(false);
      setExpandedMounted(true);
      const timer = window.setTimeout(() => setExpandedOn(true), REVEAL_AFTER_MS);
      return () => window.clearTimeout(timer);
    }
    setExpandedOn(false);
    setCollapsedOn(false);
    const back = window.setTimeout(() => setCollapsedOn(true), COLLAPSE_AFTER_MS);
    const unmount = window.setTimeout(() => setExpandedMounted(false), UNMOUNT_AFTER_MS);
    return () => {
      window.clearTimeout(back);
      window.clearTimeout(unmount);
    };
  }, [expandedStage, reducedMotion]);

  return {
    expanded: { mounted: expandedMounted, visible: expandedOn, interactive: expandedOn },
    // 折叠层在列表完全显形的那一刻才卸载：反向时它得在原位等着接住用户
    collapsed: { mounted: !expandedOn, visible: collapsedOn, interactive: collapsedOn },
  };
}