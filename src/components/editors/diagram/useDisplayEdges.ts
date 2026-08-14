/**
 * 把「线型」与「焦点路径」落成边上的 className（从 DiagramCanvas 拆出，规则 #7）。
 *
 * 不用 edge.style 内联写：内联优先级最高，一写就把 hover / 选中的描边变化全盖死了。
 */
import { useMemo } from "react";
import type { Edge } from "@xyflow/react";
import { edgeLineOf, type DNode } from "@/lib/diagram/types";
import styles from "../DiagramCanvas.module.css";

export function useDisplayEdges(nodes: DNode[], edges: Edge[]): Edge[] {
  // 焦点路径的边加流动虚线（设计稿 .edge.key）：**任一端是焦点节点**就算。
  // 不能要求两端都是——设计稿里只有一个节点带 focal，两条 key 边都是接到它身上的；
  // 写成「两端都是」的话除非用户把一条链整条标成焦点，否则永远不会生效。
  //
  // 用「焦点 id 拼串」而不是 nodes 做依赖：nodes 在拖拽时每帧都变，
  // 直接依赖会每帧重建一批新的 edge 对象，把整张图的边都重渲一遍。
  const focalKey = nodes.filter((n) => n.data.focal).map((n) => n.id).sort().join(",");

  return useMemo(() => {
    const focal = focalKey ? new Set(focalKey.split(",")) : null;
    return edges.map((e) => {
      const line = edgeLineOf(e);
      const cls =
        [
          e.className,
          line === "dashed" ? styles.edgeDashed : line === "thick" ? styles.edgeThick : null,
          focal && (focal.has(e.source) || focal.has(e.target)) ? styles.edgeKey : null,
        ]
          .filter(Boolean)
          .join(" ") || undefined;
      return cls === e.className ? e : { ...e, className: cls };
    });
  }, [focalKey, edges]);
}
