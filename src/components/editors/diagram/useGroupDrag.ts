/**
 * 拖区域框时带着框内节点一起走。
 *
 * 成员是按几何包含算的（groupMembers），而不是 React Flow 的 parentId，
 * 所以平移得自己做。关键是**在拖拽开始时就把成员名单与起始坐标定住**：
 * 拖动过程中框在走，如果每帧重新算包含关系，框会一路把路过的节点“扫”进来。
 *
 * 同理不能累加逐帧位移（position - lastPosition）：开了 snapToGrid 后逐帧位移会被量化成 0，
 * 累加出来的总位移会慢慢落后于框。这里每帧都从「起始位置 + 当前总位移」重算。
 */
import { useCallback, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { groupMembers, isGroup, type DNode } from "@/lib/diagram/types";

interface DragStart {
  gx: number;
  gy: number;
  members: Map<string, { x: number; y: number }>;
}

export function useGroupDrag({
  nodesRef, setNodes,
}: {
  nodesRef: RefObject<DNode[]>;
  setNodes: Dispatch<SetStateAction<DNode[]>>;
}) {
  const startRef = useRef<DragStart | null>(null);

  const onNodeDragStart = useCallback(
    (_e: unknown, node: DNode) => {
      if (!isGroup(node)) {
        startRef.current = null;
        return;
      }
      const ids = groupMembers(nodesRef.current ?? []).get(node.id) ?? [];
      const members = new Map<string, { x: number; y: number }>();
      for (const n of nodesRef.current ?? []) {
        if (ids.includes(n.id)) members.set(n.id, { x: n.position.x, y: n.position.y });
      }
      startRef.current = { gx: node.position.x, gy: node.position.y, members };
    },
    [nodesRef],
  );

  const onNodeDrag = useCallback(
    (_e: unknown, node: DNode) => {
      const s = startRef.current;
      if (!s || s.members.size === 0) return;
      const dx = node.position.x - s.gx;
      const dy = node.position.y - s.gy;
      setNodes((ns) =>
        ns.map((n) => {
          const p = s.members.get(n.id);
          return p ? { ...n, position: { x: p.x + dx, y: p.y + dy } } : n;
        }),
      );
    },
    [setNodes],
  );

  const onNodeDragStop = useCallback(() => {
    startRef.current = null;
  }, []);

  return { onNodeDragStart, onNodeDrag, onNodeDragStop };
}
