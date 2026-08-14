/**
 * 把选中节点的位置从 flow 坐标换算成**容器坐标**，供浮岛定位与抽屉翻面使用。
 *
 * 为何不把浮岛直接放进 .react-flow__viewport：那一层带 transform，浮岛会跟缩放一起
 * 缩小，缩到 0.2 倍时根本点不到。所以浮岛是 .root 的子元素，自己算位置。
 *
 * useViewport() 会在平移/缩放的**每一帧**触发重渲。这个 hook 只在组件层面使用（浮岛 /
 * 抽屉），而它们只在有选中时才挂载，重渲范围就一个小组件——
 * **不能把它提到 DiagramCanvas 里**，那会让整张图在平移时逐帧重渲。
 */
import { useEffect, useState, type RefObject } from "react";
import { useViewport } from "@xyflow/react";
import type { DNode } from "@/lib/diagram/types";
import type { Rect, Size } from "./place";

/** 节点尺寸的兜底：React Flow 首帧还没量完时 measured 为空，拿不到尺寸不能就不画 */
const FALLBACK_NODE = { width: 120, height: 44 };

export interface Anchor {
  /** 节点在容器坐标系里的矩形 */
  rect: Rect;
  /** 容器（.root）自身尺寸 */
  container: Size;
}

export function useNodeAnchor(rootRef: RefObject<HTMLElement | null>, node: DNode | null): Anchor | null {
  const { x: vx, y: vy, zoom } = useViewport();
  // 容器尺寸变了也要重算（窗口缩放 / 弹窗入场动画）
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setBox({ width: r.width, height: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [rootRef]);

  if (!node || box.width === 0) return null;

  const w = node.measured?.width ?? FALLBACK_NODE.width;
  const h = node.measured?.height ?? FALLBACK_NODE.height;
  // flow → 容器：乘缩放再加视口偏移。等价于 flowToScreenPosition() 减容器原点，
  // 直接算可以不读 getBoundingClientRect（那是同步布局，每帧读会掉帧）。
  return {
    rect: {
      left: node.position.x * zoom + vx,
      top: node.position.y * zoom + vy,
      width: w * zoom,
      height: h * zoom,
    },
    container: box,
  };
}
