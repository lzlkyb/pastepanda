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
  useClick,
  useDismiss,
  useRole,
  useInteractions,
  FloatingArrow,
  FloatingPortal,
} from "@floating-ui/react";

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

  const detailInteractions = useInteractions([
    useClick(detailCtx),
    useDismiss(detailCtx),
  ]);

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
    <span className="help-trigger-wrap" style={{ display: "inline-flex", flexShrink: 0 }}>
      <button
        ref={(node) => {
          tooltipRefs.setReference(node);
          detailRefs.setReference(node);
        }}
        className={`help-trigger${showDetail ? " active" : ""}`}
        onClick={handleClick}
        aria-label={detailTitle || tooltip || "帮助"}
        title={!detail ? tooltip : undefined}
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
              className="help-tooltip"
              {...tooltipInteractions.getFloatingProps()}
            >
              {tooltip}
              <FloatingArrow ref={arrowRef} context={tooltipCtx} className="help-tooltip-arrow" />
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
              className="help-bubble"
              {...detailInteractions.getFloatingProps()}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="help-bubble-header">
                <span className="help-bubble-title">{detailTitle || "帮助"}</span>
                <button className="help-bubble-close" onClick={handleCloseDetail}>
                  <X size={12} />
                </button>
              </div>
              <div className="help-bubble-body">{detail}</div>
            </motion.div>
          )}
        </AnimatePresence>
      </FloatingPortal>
    </span>
  );
}
