/**
 * 大纲点击 → 按视图模式分派跳转。
 *
 * 从 FullscreenEditor 抽出（规则 #7：该文件已远超 300 行）：
 * 外壳只接线，策略留在本 hook，便于单测与复用。
 *
 * 失效根因回顾：旧实现只滚 CodeMirror；仅预览时编辑区是 display:none，
 * 滚动发生在看不见的节点上，用户以为「点了没反应」。
 */
import { useCallback } from "react";
import type { RefObject } from "react";
import type { ViewMode } from "./fullscreen/types";
import type { OutlineHeading } from "./fullscreen/MarkdownOutline";
import { queryByHeadingId } from "@/lib/markdown/headingSlug";
import { flashHeadingTarget } from "@/lib/markdown/headingAnchor";

/** 在预览容器里按 id 找标题；找不到再按可见文本兜底（预览 debounce 可能慢一拍） */
function findPreviewHeading(root: HTMLElement, h: OutlineHeading): HTMLElement | null {
  const byId = queryByHeadingId(root, h.slug);
  if (byId) return byId;

  const wanted = h.text.trim();
  const nodes = root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6");
  for (const el of nodes) {
    // 去掉 hover 锚点「#」和块行号后再比文本
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".md-hanchor,.md-blknum").forEach((n) => n.remove());
    const t = (clone.textContent || "").trim();
    if (t === wanted) return el;
  }
  return null;
}

export function useOutlineJump(opts: {
  viewMode: ViewMode;
  /** CodeMirror 行跳转（仅编辑 / 分屏用） */
  jumpToLine: (line: number) => void;
  previewScrollRef: RefObject<HTMLElement | null>;
  hasPreview: boolean;
  /** 两侧都找不到落点时回调（宿主 toast，规则 15） */
  onJumpFail?: (heading: OutlineHeading) => void;
}) {
  const { viewMode, jumpToLine, previewScrollRef, hasPreview, onJumpFail } = opts;

  return useCallback(
    (h: OutlineHeading) => {
      const jumpPreview = (): boolean => {
        const root = previewScrollRef.current;
        if (!root) return false;
        const target = findPreviewHeading(root, h);
        if (!target) return false;
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        flashHeadingTarget(target);
        return true;
      };

      // 无预览（text/csv 等）或仅编辑：只动编辑区
      if (viewMode === "edit" || !hasPreview) {
        jumpToLine(h.line);
        return;
      }

      if (viewMode === "preview") {
        if (!jumpPreview()) onJumpFail?.(h);
        return;
      }

      // 分屏：两侧都到同一语义标题。比例 scrollSync 在代码块高度不均时会漂，
      // 手里已有 line + slug 就各自精确定位，再靠时间窗抑制回声。
      jumpToLine(h.line);
      if (!jumpPreview()) {
        // 编辑区已动，预览缺节点只提示不打断
        onJumpFail?.(h);
      }
    },
    [viewMode, jumpToLine, previewScrollRef, hasPreview, onJumpFail],
  );
}
