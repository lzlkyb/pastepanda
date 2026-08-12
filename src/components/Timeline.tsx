import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { MelodyEmpty } from "@/components/MelodyEmpty";
import styles from "./Timeline.module.css";

/** 时间分组类型 */
export type TimeGroup = "today" | "yesterday" | "thisWeek" | "earlier";

/** 时间分组标签 */
export const TIME_GROUP_LABELS: Record<TimeGroup, string> = {
  today: "今天",
  yesterday: "昨天",
  thisWeek: "本周",
  earlier: "更早",
};

/** 卡片类型（rich = 图文混排） */
export type CardItemType = "text" | "image" | "rich" | "file";

/** 卡片类型 → emoji 图标映射 */
export const CARD_TYPE_ICONS: Record<CardItemType, string> = {
  text: "📝",
  image: "🖼",
  rich: "🖼️",
  file: "📁",
};

/** 单个时间轴节点 — 每个卡片对应一个节点 */
export interface TimelineNode {
  group: TimeGroup;
  index: number;    // 卡片在列表中的索引
  label: string;    // 节点的 tooltip 文字（截断后的卡片标题）
  type: CardItemType; // 卡片类型，用于显示不同图标
  time: string;     // #4 卡片时间戳，用于分组标签悬停预览显示时间范围
}

interface TimelineProps {
  /** 时间轴是否可见（由父组件 CardList 统一控制） */
  visible: boolean;
  /** 卡片总高度（scrollHeight） */
  scrollHeight: number;
  /** 卡片区域 clientHeight */
  clientHeight: number;
  /** 当前 scrollTop */
  scrollTop: number;
  /** 每个卡片对应的时间轴节点 */
  nodes: TimelineNode[];
  /** 分组索引映射：group → 该分组第一个卡片的索引 */
  groupIndices: Record<TimeGroup, number>;
  /** 滚动到指定索引 */
  onScrollToIndex: (index: number) => void;
  /** 拖拽时滚动到指定 scrollTop */
  onDragScroll: (scrollTop: number) => void;
  /** 时间轴上滚轮事件 → 转发 deltaY 给父组件，由 Lenis 平滑处理 */
  onWheelScroll?: (deltaY: number) => void;
  /** triggerZone 鼠标进入回调（通知父组件显示时间轴） */
  onTriggerEnter?: () => void;
  /** timeline 区域鼠标离开回调（通知父组件隐藏时间轴） */
  onTimelineLeave?: () => void;
  /** #8 Mini 模式：展开/收回回调，通知父组件调整卡片列表 padding */
  onExpandChange?: (expanded: boolean) => void;
  /** 卡片列表的滚动容器 ref，用于滚轮事件转发 */
  scrollRef: React.RefObject<HTMLDivElement | null>;
}

export function Timeline({
  visible,
  scrollHeight,
  clientHeight,
  scrollTop,
  nodes,
  groupIndices,
  onScrollToIndex,
  onDragScroll,
  onWheelScroll,
  onTriggerEnter,
  onExpandChange,
}: TimelineProps) {
  const [dragging, setDragging] = useState(false);
  const [capsuleDragging, setCapsuleDragging] = useState(false);
  const [currentGroup, setCurrentGroup] = useState<TimeGroup>("today");
  // #8 Mini 模式：hover 展开，默认窄轨
  const [expanded, setExpanded] = useState(false);
  const isExpanded = expanded || dragging || capsuleDragging;

  // #8 展开状态变化时通知父组件调整卡片 padding
  useEffect(() => {
    onExpandChange?.(isExpanded);
    // onExpandChange 父侧传的是 setState（React 保证恒引用），列进依赖无开销
  }, [isExpanded, onExpandChange]);

  // #6 计算当前分组的卡片数量
  const currentGroupCount = useMemo(() => {
    const groupOrder: TimeGroup[] = ["today", "yesterday", "thisWeek", "earlier"];
    return getGroupCardCount(currentGroup, groupOrder, groupIndices, nodes.length);
  }, [currentGroup, groupIndices, nodes.length]);

  // #8 方案C：计算分组彩色轨道线段的高度百分比
  const groupTrackSegments = useMemo(() => {
    const groupOrder: TimeGroup[] = ["today", "yesterday", "thisWeek", "earlier"];
    // 统计每个分组的节点数
    const counts: Record<string, number> = {};
    for (const n of nodes) {
      counts[n.group] = (counts[n.group] || 0) + 1;
    }
    const total = nodes.length || 1;
    // 分组标签额外占用的高度比例（估算：每个标签约 16px = 0.22 个卡片高度）
    const labelRatio = 0.22;
    const activeGroups = groupOrder.filter(g => counts[g] && counts[g] > 0);
    const totalLabels = activeGroups.length * labelRatio;
    const nodeRatioTotal = total / (total + totalLabels);

    const segments: { group: TimeGroup; pct: number }[] = [];
    let remaining = 100;
    for (let i = 0; i < activeGroups.length; i++) {
      const g = activeGroups[i];
      const nodePct = ((counts[g] || 0) / total) * nodeRatioTotal * 100;
      const labelPct = (i < activeGroups.length - 1) ? (labelRatio / (total + totalLabels)) * 100 : 0;
      const segPct = i === activeGroups.length - 1
        ? remaining
        : nodePct + labelPct;
      segments.push({ group: g, pct: Math.max(segPct, 2) });
      remaining -= segPct;
    }
    return segments;
  }, [nodes]);

  // #4 分组标签悬停预览 — 计算每个分组的时间范围和卡片数
  const groupPreviews = useMemo(() => {
    const groupOrder: TimeGroup[] = ["today", "yesterday", "thisWeek", "earlier"];
    const result = {} as Record<TimeGroup, { count: number; timeRange: string }>;
    for (const g of groupOrder) {
      const idx = groupIndices[g];
      if (idx === undefined || idx < 0) continue;
      const count = getGroupCardCount(g, groupOrder, groupIndices, nodes.length);
      // 收集该分组所有卡片的时间
      const times = nodes.slice(idx, idx + count).map(n => n.time).filter(Boolean);
      if (times.length === 0) {
        result[g] = { count, timeRange: "" };
        continue;
      }
      // 格式化时间范围：取最早和最晚的时间，只显示 HH:MM
      const sorted = [...times].sort();
      const firstTime = sorted[0];
      const lastTime = sorted[sorted.length - 1];
      const formatHM = (t: string) => {
        try {
          const d = new Date(t.replace(" ", "T"));
          const hh = String(d.getHours()).padStart(2, "0");
          const mm = String(d.getMinutes()).padStart(2, "0");
          return `${hh}:${mm}`;
        } catch { return ""; }
      };
      const first = formatHM(firstTime);
      const last = formatHM(lastTime);
      const range = first === last ? first : `${first} → ${last}`;
      result[g] = { count, timeRange: range };
    }
    return result;
  }, [groupIndices, nodes]);

  const dragStartRef = useRef({ y: 0, scrollTop: 0 });
  const timelineRef = useRef<HTMLDivElement>(null);
  const timelineInnerRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<number | null>(null);

  // 清理 timer
  useEffect(() => {
    return () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, []);

  // #8 Mini 模式：拖拽结束后延迟收回展开状态
  const scheduleHide = useCallback((delay: number) => {
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      if (!dragging && !capsuleDragging) {
        setExpanded(false);
      }
      hideTimerRef.current = null;
    }, delay);
  }, [dragging, capsuleDragging]);

  // 同步 timeline 滚动偏移 — 纯 props 计算，不依赖 DOM ref
  const translateY = useMemo(() => {
    const cardHeight = 72;  // --card-height
    const cardGap = 10;     // --card-gap
    const nodeHeight = cardHeight + cardGap; // 82px per node
    const groupLabelHeight = 36; // 分组标签高度

    const activeGroups = ["today", "yesterday", "thisWeek", "earlier"]
      .filter(g => groupIndices[g as TimeGroup] !== undefined && groupIndices[g as TimeGroup] >= 0);
    const groupCount = activeGroups.length;
    const timelineContentHeight = nodes.length * nodeHeight + groupCount * groupLabelHeight;

    const maxTimelineScroll = timelineContentHeight - clientHeight;
    if (maxTimelineScroll <= 0) return 0;
    const ratio = scrollTop / (scrollHeight - clientHeight || 1);
    return -ratio * maxTimelineScroll;
  }, [scrollTop, scrollHeight, clientHeight, nodes.length, groupIndices]);

  // 更新吸顶胶囊文字（基于当前 scrollTop 判断可见的第一个分组）
  useEffect(() => {
    if (!visible) return;
    // #3 通过 CSS 变量动态读取卡片高度+gap，避免硬编码
    const cardListEl = document.querySelector('[class*="cardList"]');
    const cardHeightVar = cardListEl ? parseInt(getComputedStyle(cardListEl).getPropertyValue('--card-height').trim()) || 72 : 72;
    const cardGapVar = cardListEl ? parseInt(getComputedStyle(cardListEl).getPropertyValue('--card-gap').trim()) || 10 : 10;
    const cardHeight = cardHeightVar + cardGapVar;
    const sepHeight = 36;
    let acc = 0;
    const groups: { group: TimeGroup; start: number }[] = [];
    const groupOrder: TimeGroup[] = ["today", "yesterday", "thisWeek", "earlier"];
    for (const g of groupOrder) {
      const idx = groupIndices[g];
      if (idx === undefined || idx < 0) continue;
      groups.push({ group: g, start: acc });
      acc += sepHeight;
      const count = getGroupCardCount(g, groupOrder, groupIndices, nodes.length);
      acc += count * cardHeight;
    }
    for (let i = groups.length - 1; i >= 0; i--) {
      if (scrollTop >= groups[i].start) {
        setCurrentGroup(groups[i].group);
        return;
      }
    }
    setCurrentGroup(groups[0]?.group || "today");
  }, [scrollTop, visible, groupIndices, nodes.length]);

  // 计算分组之间的卡片数
  function getGroupCardCount(
    group: TimeGroup,
    order: TimeGroup[],
    indices: Record<TimeGroup, number>,
    total: number
  ): number {
    const idx = order.indexOf(group);
    if (idx === order.length - 1) {
      return total - (indices[group] || 0);
    }
    const nextGroup = order.slice(idx + 1).find((g) => indices[g] >= 0);
    if (nextGroup !== undefined && indices[nextGroup] !== undefined) {
      return indices[nextGroup] - (indices[group] || 0);
    }
    return total - (indices[group] || 0);
  }

  // 拖拽节点/分组标签
  const handleNodeMouseDown = useCallback(
    (e: React.MouseEvent, nodeIndex?: number) => {
      const node = e.currentTarget as HTMLElement;
      const isGroupLabel = node.classList.contains(styles.timelineGroupLabel);

      e.preventDefault();
      setDragging(true);
      dragStartRef.current = {
        y: e.clientY,
        scrollTop: scrollTop,
      };

      if (isGroupLabel && nodeIndex !== undefined) {
        // 点击分组标签 → 直接跳转
        onScrollToIndex(nodeIndex);
      }

      const handleMove = (ev: MouseEvent) => {
        const dy = ev.clientY - dragStartRef.current.y;
        const scaleFactor = scrollHeight / (clientHeight || 700);
        const scrollDelta = dy * scaleFactor;
        const targetScroll = Math.max(
          0,
          Math.min(
            scrollHeight - clientHeight,
            dragStartRef.current.scrollTop + scrollDelta
          )
        );
        onDragScroll(targetScroll);
      };

      const handleUp = () => {
        setDragging(false);
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
        scheduleHide(1500);
      };

      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [scrollTop, scrollHeight, clientHeight, onScrollToIndex, onDragScroll, scheduleHide]
  );

  // 吸顶胶囊拖拽（加速 1.5x）
  const handleCapsuleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setCapsuleDragging(true);
      dragStartRef.current = {
        y: e.clientY,
        scrollTop: scrollTop,
      };

      const handleMove = (ev: MouseEvent) => {
        const dy = ev.clientY - dragStartRef.current.y;
        const scaleFactor = (scrollHeight * 1.5) / (clientHeight || 700);
        const scrollDelta = dy * scaleFactor;
        const targetScroll = Math.max(
          0,
          Math.min(
            scrollHeight - clientHeight,
            dragStartRef.current.scrollTop + scrollDelta
          )
        );
        onDragScroll(targetScroll);
      };

      const handleUp = () => {
        setCapsuleDragging(false);
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
        scheduleHide(1500);
      };

      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [scrollTop, scrollHeight, clientHeight, onDragScroll, scheduleHide]
  );

  // 点击节点 → 滚动到对应卡片
  const handleNodeClick = useCallback(
    (e: React.MouseEvent, index: number) => {
      if (dragging) return;
      e.stopPropagation();
      onScrollToIndex(index);
    },
    [dragging, onScrollToIndex]
  );

  // 滚轮事件 → 转发 deltaY 给父组件，由 Lenis 平滑处理
  useEffect(() => {
    const el = timelineRef.current;
    if (!el || !onWheelScroll) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      onWheelScroll(e.deltaY);
    };

    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", handleWheel);
    };
  }, [onWheelScroll]);

  return (
    <>
      {/* 左侧感应区域 — 18px 宽，独立于 timeline */}
      <div
        className={styles.timelineTriggerZone}
        onMouseEnter={() => {
          onTriggerEnter?.();
          setExpanded(true);
          if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
        }}
      />

      {/* 时间轴容器 */}
      <div
        ref={timelineRef}
        className={`${styles.timelineContainer} ${visible ? styles.visible : ""} ${isExpanded ? styles.expanded : ""} ${dragging || capsuleDragging ? styles.dragActive : ""}`}
        onMouseEnter={() => {
          onTriggerEnter?.();
          setExpanded(true);
          if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
        }}
        onMouseLeave={() => {
          setExpanded(false);
          scheduleHide(300);
        }}
      >
        {/* 吸顶胶囊 */}
        <div
          className={`${styles.timelineCapsule} ${capsuleDragging ? styles.capsuleDragging : ""}`}
          onMouseDown={handleCapsuleMouseDown}
        >
          <div className={styles.capsuleInner}>📍 {TIME_GROUP_LABELS[currentGroup]}<span className={styles.capsuleCount}> · {currentGroupCount}</span></div>
        </div>

        {/* 滚动区 */}
        <div className={styles.timelineScroll}>
          <div className={styles.timelineTrack}>
            {/* #8 方案C：分组彩色轨道线段 */}
            {groupTrackSegments.length > 0 ? groupTrackSegments.map((seg) => (
              <div
                key={seg.group}
                className={styles.timelineTrackSegment}
                data-group={seg.group}
                style={{ height: `${seg.pct}%` }}
              />
            )) : (
              <div className={styles.timelineTrackSegment} style={{ height: "100%", background: "var(--border-color)", opacity: 0.3 }} />
            )}
          </div>
          <div
            ref={timelineInnerRef}
            className={styles.timelineInner}
            style={{ transform: `translateY(${translateY}px)` }}
          >
            {nodes.length === 0 ? (
              <div style={{ fontSize: 11, color: "var(--text-muted)", textAlign: "center", padding: "12px 0", opacity: 0.6 }}><MelodyEmpty size={48} />暂无记录</div>
            ) : nodes.map((node, i) => {
              // 判断是否需要渲染分组标签（前一个节点不是同一分组）
              const prevGroup = i > 0 ? nodes[i - 1].group : null;
              const showGroupLabel = node.group !== prevGroup;

              return (
                <div key={`node-${i}`}>
                  {showGroupLabel && (
                    <div
                      className={styles.timelineGroupLabel}
                      data-group={node.group}
                      onMouseDown={(e) => handleNodeMouseDown(e, node.index)}
                    
                    >
                      <div className={styles.timelineGroupLabelDot} />
                      <div className={styles.timelineGroupLabelText}>
                        {TIME_GROUP_LABELS[node.group]}
                      </div>
                      {/* #4 悬停预览 tooltip */}
                      <div className={styles.timelineGroupTooltip}>
                        <span className={styles.groupTooltipName}>{TIME_GROUP_LABELS[node.group]}</span>
                        <span className={styles.groupTooltipCount}>{groupPreviews[node.group]?.count || 0} 条</span>
                        {groupPreviews[node.group]?.timeRange && (
                          <span className={styles.groupTooltipTime}>{groupPreviews[node.group]?.timeRange}</span>
                        )}
                      </div>
                    </div>
                  )}
                  <div
                    className={`${styles.timelineNode} ${node.group === currentGroup ? styles.timelineNodeActive : ""}`}
                    data-idx={node.index}
                    onMouseDown={(e) => handleNodeMouseDown(e)}
                    onClick={(e) => handleNodeClick(e, node.index)}
                  
                  >
                    <div className={styles.timelineNodeIcon}>{CARD_TYPE_ICONS[node.type]}</div>
                    <div className={styles.timelineTooltip}>{node.label}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 拖拽指示器 */}
        <div className={styles.timelineDragIndicator} />
      </div>
    </>
  );
}
