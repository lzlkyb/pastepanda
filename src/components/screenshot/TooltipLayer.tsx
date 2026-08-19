/**
 * TooltipLayer — 截图标注悬浮提示的 Portal 浮层。
 *
 * 替代旧版 `.tool:hover::after` 伪元素方案。旧方案有两个致命问题：
 *  1. tooltip 是 `.annot-toolbar`(z-index:30) 的 ::after，被困在该层叠上下文里，
 *     同级独立层 `.attr-bar`(z-index:31) 会压住它 —— 工具栏在选区下方时 tooltip 向下弹
 *     正好撞上属性条，被挡得看不见。
 *  2. `.annot-toolbar.top-attached` 翻转规则从未生效（JSX 没加过这个类），工具栏在选区
 *     上方时 tooltip 仍向下弹、压在画布上。
 *
 * 本组件用事件委托监听 #root 内的 [data-tip]，把提示渲染到 document.body 的 Portal 浮层
 * （position:fixed、z-index:950，高于一切截图层），并从层叠上下文里彻底逃逸；上弹/下弹
 * 由 tipPlacement 按元素位置智能决定，一并根治上面两个 bug。
 *
 * 各组件（AnnotToolbar / AttrBar / TextToolbar / ModePill）只保留 data-tip 属性，无需改动。
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { tipPlacement } from "@/lib/screenshot/tooltipPos";

interface TipState {
  text: string;
  x: number; // 视口水平中心
  y: number; // 视口顶/底贴合点
  below: boolean;
}

const GAP = 8;

export function TooltipLayer() {
  const [tip, setTip] = useState<TipState | null>(null);

  useEffect(() => {
    const root = document.getElementById("root") ?? document.body;

    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.("[data-tip]") as HTMLElement | null;
      if (!el) return;
      const text = el.getAttribute("data-tip");
      if (!text) return;
      const r = el.getBoundingClientRect();
      const below = tipPlacement(r, window.innerHeight);
      setTip({
        text,
        x: r.left + r.width / 2,
        y: below ? r.bottom + GAP : r.top - GAP,
        below,
      });
    };

    // 离开 data-tip 元素、且没移入另一个 data-tip 时才清除（移到相邻按钮由 onOver 直接更新）
    const onOut = (e: MouseEvent) => {
      const to = (e.relatedTarget as HTMLElement | null)?.closest?.("[data-tip]");
      if (!to) setTip(null);
    };

    root.addEventListener("mouseover", onOver);
    root.addEventListener("mouseout", onOut);
    return () => {
      root.removeEventListener("mouseover", onOver);
      root.removeEventListener("mouseout", onOut);
    };
  }, []);

  if (!tip) return null;

  return createPortal(
    <div
      className="shot-tip"
      style={{
        left: tip.x,
        top: tip.y,
        transform: `translate(-50%, ${tip.below ? "0" : "-100%"})`,
      }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
