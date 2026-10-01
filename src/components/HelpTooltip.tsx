import { useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { HelpCircle, X } from "lucide-react";
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  arrow,
  useHover,
  useDismiss,
  useRole,
  useInteractions,
  FloatingArrow,
  FloatingPortal,
} from "@floating-ui/react";
import styles from "./HelpTooltip.module.css";

interface HelpTooltipProps {
  /** 悬浮时显示的简短提示（1-2句话） */
  tooltip?: string;
  /** 点击 ? 图标后弹出的详细气泡内容 */
  detail?: React.ReactNode;
  /** 气泡标题 */
  detailTitle?: string;
}

/**
 * 帮助提示组件
 * - 鼠标悬浮 → 显示 tooltip，FloatingPortal 突破 overflow 裁切
 * - 点击 ? 图标 → 弹出详细气泡
 * - 单元素 + visibility 控制：定位完成前隐藏，完成后 opacity 淡入
 *   动画只改 opacity 不改位置，避免与 Floating UI 的 transform 冲突
 *
 * 🔴 交互监听只能经 `getReferenceProps()` 挂到触发元素上：floating-ui 0.27 的
 * `useHover/useClick/useRole` 把 listener 装进这对 getter 里，不 spread 就等于没注册
 * （本文件此前只 spread 了 floating 那半，悬浮路径静默失效、只剩原生 title，
 * 而原生 title 不受主题控制、也没有 500ms 延迟）。加新交互时先确认它落在哪一半。
 */
export function HelpTooltip({ tooltip, detail, detailTitle }: HelpTooltipProps) {
  const [showTooltip, setShowTooltip] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const arrowRef = useRef<SVGSVGElement>(null);

  // Floating UI — tooltip
  const {
    refs: tooltipRefs,
    floatingStyles: tooltipStyles,
    context: tooltipCtx,
    isPositioned: tooltipPositioned,
  } = useFloating({
    open: showTooltip,
    onOpenChange: setShowTooltip,
    placement: "top",
    middleware: [
      offset(8),
      flip({ padding: 12 }),
      shift({ padding: 8 }),
      arrow({ element: arrowRef }),
    ],
    whileElementsMounted: autoUpdate,
  });

  // Floating UI — detail bubble
  const {
    refs: detailRefs,
    floatingStyles: detailStyles,
    context: detailCtx,
    isPositioned: detailPositioned,
  } = useFloating({
    open: showDetail,
    onOpenChange: setShowDetail,
    placement: "top",
    middleware: [
      offset(8),
      flip({ padding: 12 }),
      shift({ padding: 8 }),
    ],
    whileElementsMounted: autoUpdate,
  });

  const tooltipInteractions = useInteractions([
    useHover(tooltipCtx, { delay: { open: 500, close: 0 }, enabled: !showDetail }),
    useRole(tooltipCtx, { role: "tooltip" }),
    useDismiss(tooltipCtx),
  ]);

  const detailInteractions = useInteractions([useDismiss(detailCtx)]);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (detail) {
      setShowDetail(!showDetail);
      setShowTooltip(false);
    }
  };

  const handleCloseDetail = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDetail(false);
  };

  return (
    <span className={styles.triggerWrap}>
      <button
        ref={(node) => {
          tooltipRefs.setReference(node);
          detailRefs.setReference(node);
        }}
        {...tooltipInteractions.getReferenceProps()}
        className={`${styles.trigger}${showDetail ? ` ${styles.triggerActive}` : ""}`}
        onClick={handleClick}
        aria-label={detailTitle || tooltip || "帮助"}
      >
        <HelpCircle size={14} />
      </button>

      {/* 悬浮 tooltip — 单一 motion.div，visibility 控制，仅 opacity 动画 */}
      <FloatingPortal>
        <AnimatePresence>
          {showTooltip && tooltip && !showDetail && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              ref={tooltipRefs.setFloating}
              style={{
                ...tooltipStyles,
                visibility: tooltipPositioned ? "visible" : "hidden",
              }}
              className={styles.tooltip}
              {...tooltipInteractions.getFloatingProps()}
            >
              {tooltip}
              <FloatingArrow ref={arrowRef} context={tooltipCtx} className={styles.tooltipArrow} />
            </motion.div>
          )}
        </AnimatePresence>
      </FloatingPortal>

      {/* 点击弹出的详细气泡 — FloatingPortal，仅 opacity 淡入避免与 transform 冲突 */}
      <FloatingPortal>
        <AnimatePresence>
          {showDetail && detail && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              ref={detailRefs.setFloating}
              style={{
                ...detailStyles,
                visibility: detailPositioned ? "visible" : "hidden",
              }}
              className={styles.bubble}
              {...detailInteractions.getFloatingProps()}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.bubbleHeader}>
                <span className={styles.bubbleTitle}>{detailTitle || "帮助"}</span>
                <button className={styles.bubbleClose} onClick={handleCloseDetail}>
                  <X size={12} />
                </button>
              </div>
              <div className={styles.bubbleBody}>{detail}</div>
            </motion.div>
          )}
        </AnimatePresence>
      </FloatingPortal>
    </span>
  );
}
