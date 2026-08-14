/**
 * 画布上的指针交互：右键菜单 + 形状拖拽落点（从 DiagramCanvas 拆出，规则 #7）。
 *
 * 两件事放在一起是因为它们共用同一个前提：都要把屏幕坐标换成**容器坐标**
 * （减 .root 的原点），并且都要防着 getBoundingClientRect 的同步布局开销。
 */
import { useCallback, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { Edge } from "@xyflow/react";
import { asShape, edgeLineOf, isGroup, type DNode, type NodeShape } from "@/lib/diagram/types";
import { SHAPE_DRAG_MIME, GROUP_DRAG_KEY, type DragKind } from "./chrome/types";
import type { MenuState } from "./chrome/ContextMenu";

interface Args {
  rootRef: RefObject<HTMLElement | null>;
  setNodes: Dispatch<SetStateAction<DNode[]>>;
  setEdges: Dispatch<SetStateAction<Edge[]>>;
  addNodeAt: (pos: { x: number; y: number }, shape?: NodeShape) => void;
  addGroupAt: (pos: { x: number; y: number }) => void;
  screenToFlowPosition: (p: { x: number; y: number }) => { x: number; y: number };
}

export function useCanvasInteractions({
  rootRef, setNodes, setEdges, addNodeAt, addGroupAt, screenToFlowPosition,
}: Args) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  // 拖拽中的形状 / 区域框与落点（仅用于预览虚框）。dragover 阶段读不到 dataTransfer 内容，
  // 所以名字靠形状库在 dragStart 时往上报。
  const [dragShape, setDragShape] = useState<DragKind | null>(null);
  const [dropAt, setDropAt] = useState<{ x: number; y: number } | null>(null);
  // 一次拖拽期间容器不会动，量一次就够——每个 dragover 都读 getBoundingClientRect
  // 会在大图上掉帧。
  const dragRectRef = useRef<DOMRect | null>(null);

  /**
   * 只选中指定对象（右键时先选中，再弹菜单）。
   *
   * React Flow 的 onNodeContextMenu **不会**自动选中，而菜单里的「复制 / AI 润色 /
   * 设为焦点」那几项都是对“当前选中”生效的——不先选中就会作用到别的节点上。
   * 改 selected 字段而不是直接设 selectedId：后者不会让 React Flow 加上 .selected 类，
   * 看上去没选中；改字段则会走到 onSelectionChange，两边状态自然对齐。
   */
  const selectOnly = useCallback(
    (kind: "node" | "edge", id: string) => {
      setNodes((ns) => ns.map((n) => ({ ...n, selected: kind === "node" && n.id === id })));
      setEdges((es) => es.map((e) => ({ ...e, selected: kind === "edge" && e.id === id })));
    },
    [setNodes, setEdges],
  );

  /** 右键弹菜单。坐标转成容器坐标，并把容器尺寸一并量好交给菜单做边界钳制 */
  const openMenu = useCallback(
    (e: React.MouseEvent, target: MenuState["target"]) => {
      e.preventDefault();
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenu({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        target,
        container: { width: rect.width, height: rect.height },
      });
    },
    [rootRef],
  );

  const closeMenu = useCallback(() => setMenu(null), []);

  /**
   * 直接括给 <ReactFlow> 的三个右键回调。
   * 放在这里而不是写在画布 JSX 里：它们全都只用 selectOnly + openMenu，
   * 两者本来就住在本 hook。
   */
  const flowMenuProps = {
    onNodeContextMenu: (e: React.MouseEvent, n: DNode) => {
      selectOnly("node", n.id);
      openMenu(e, { kind: "node", id: n.id, focal: n.data.focal === true, group: isGroup(n) });
    },
    onEdgeContextMenu: (e: React.MouseEvent, ed: Edge) => {
      selectOnly("edge", ed.id);
      openMenu(e, { kind: "edge", id: ed.id, line: edgeLineOf(ed) });
    },
    onPaneContextMenu: (e: React.MouseEvent | MouseEvent) => {
      const me = e as React.MouseEvent;
      openMenu(me, {
        kind: "pane",
        flowPos: screenToFlowPosition({ x: me.clientX, y: me.clientY }),
      });
    },
  };

  /** 拖拽经过画布：必须 preventDefault，否则浏览器不允许 drop */
  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(SHAPE_DRAG_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      const rect = (dragRectRef.current ??= rootRef.current?.getBoundingClientRect() ?? null);
      if (rect) setDropAt({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    },
    [rootRef],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const shape = e.dataTransfer.getData(SHAPE_DRAG_MIME);
      dragRectRef.current = null;
      setDropAt(null);
      setDragShape(null);
      if (!shape) return;
      e.preventDefault();
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      // 区域框要先比：它不是 NodeShape，asShape("group") 会静静回落成 rect，
      // 拖出来的就变成一个普通矩形节点了。
      if (shape === GROUP_DRAG_KEY) {
        addGroupAt(pos);
        return;
      }
      // 落点用鼠标位置；建出来的节点会被 snapGrid（第一批加的 22px）吸齐
      addNodeAt(pos, asShape(shape));
    },
    [addNodeAt, addGroupAt, screenToFlowPosition],
  );

  /** 拖出画布就收掉预览（否则虚框会停在最后一个位置不走） */
  const onDragLeave = useCallback((e: React.DragEvent) => {
    // 子元素之间移动也会触发 dragleave，只有真离开容器时 relatedTarget 不在里面
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropAt(null);
  }, []);

  return {
    menu, openMenu, closeMenu, selectOnly, flowMenuProps,
    dragShape, setDragShape, dropAt,
    dragProps: { onDragOver, onDrop, onDragLeave },
  };
}
