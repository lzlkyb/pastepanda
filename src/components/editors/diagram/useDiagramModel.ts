/**
 * 流程图的「模型层」：撤销栈 + 节点/连线的增删改（从 DiagramCanvas 拆出，规则 #7）。
 *
 * 只碰数据，不碰渲染；画布组件负责把这些回调接到 ReactFlow 与各面板上。
 * 所有写操作统一节奏是「pushHistory() → setXxx() → setTimeout(emit, 0)」：
 * emit 走宏任务，确保 React 重渲染完成、nodesRef/edgesRef 已刷新之后才读取，
 * 否则会读到上一帧的陈旧值。
 */
import { useCallback, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { addEdge, type Connection, type Edge } from "@xyflow/react";
import {
  newId, edgeLineOf, makeGroup, GROUP_W, GROUP_H,
  type DNode, type NodeShape, type EdgeLine,
} from "@/lib/diagram/types";

interface Snap {
  nodes: DNode[];
  edges: Edge[];
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

export interface DiagramModelOpts {
  nodes: DNode[];
  edges: Edge[];
  setNodes: Dispatch<SetStateAction<DNode[]>>;
  setEdges: Dispatch<SetStateAction<Edge[]>>;
  emit: () => void;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  selectedEdgeId: string | null;
  setSelectedEdgeId: (id: string | null) => void;
  setEditingId: (id: string | null) => void;
  screenToFlowPosition: (p: { x: number; y: number }) => { x: number; y: number };
  rootRef: RefObject<HTMLDivElement | null>;
}

export function useDiagramModel(o: DiagramModelOpts) {
  const {
    nodes, edges, setNodes, setEdges, emit,
    selectedId, setSelectedId, selectedEdgeId, setSelectedEdgeId, setEditingId,
    screenToFlowPosition, rootRef,
  } = o;

  const past = useRef<Snap[]>([]);
  const future = useRef<Snap[]>([]);
  const clipboard = useRef<DNode | null>(null);

  const pushHistory = useCallback(() => {
    past.current.push(clone({ nodes, edges }));
    if (past.current.length > 100) past.current.shift();
    future.current = [];
  }, [nodes, edges]);

  /** 整篇替换文档（导入 / AI 生成）时清空撤销栈：跨文档的撤销没有意义 */
  const resetHistory = useCallback(() => {
    past.current = [];
    future.current = [];
  }, []);

  const undo = useCallback(() => {
    if (past.current.length === 0) return;
    future.current.push(clone({ nodes, edges }));
    const prev = past.current.pop()!;
    setNodes(prev.nodes);
    setEdges(prev.edges);
    setTimeout(emit, 0);
  }, [nodes, edges, setNodes, setEdges, emit]);

  const redo = useCallback(() => {
    if (future.current.length === 0) return;
    past.current.push(clone({ nodes, edges }));
    const next = future.current.pop()!;
    setNodes(next.nodes);
    setEdges(next.edges);
    setTimeout(emit, 0);
  }, [nodes, edges, setNodes, setEdges, emit]);

  const onConnect = useCallback(
    (c: Connection) => {
      pushHistory();
      setEdges((eds) => addEdge({ ...c, type: "smoothstep" }, eds));
      setTimeout(emit, 0);
    },
    [pushHistory, setEdges, emit],
  );

  /** 在指定画布坐标建节点（双击空白处走这条） */
  const addNodeAt = useCallback(
    (pos: { x: number; y: number }, shape: NodeShape = "rect") => {
      pushHistory();
      const id = newId();
      setNodes((ns) => [...ns, { id, type: "diagram", position: pos, data: { label: "新节点", shape } }]);
      setSelectedId(id);
      setTimeout(emit, 0);
    },
    [pushHistory, setNodes, setSelectedId, emit],
  );

  /** 在画布可视中心建节点，避免落到角落看不见（左侧形状库 / 顶栏「节点」共用） */
  const addNode = useCallback(
    (shape: NodeShape = "rect") => {
      const rect = rootRef.current?.getBoundingClientRect();
      const center = rect
        ? screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
        : { x: 200, y: 160 };
      addNodeAt({ x: center.x - 60, y: center.y - 24 }, shape);
    },
    [addNodeAt, screenToFlowPosition, rootRef],
  );

  /** 在指定画布坐标建区域框。插在数组**最前面**：与 zIndex:-1 一致，
   *  也让序列化结果与 Mermaid 导入的顺序一致（框在前、节点在后）。 */
  const addGroupAt = useCallback(
    (pos: { x: number; y: number }) => {
      pushHistory();
      const id = newId("g");
      const box = makeGroup(id, pos, { w: GROUP_W, h: GROUP_H }, { label: "新分组" });
      setNodes((ns) => [box, ...ns]);
      setSelectedId(id);
      setTimeout(emit, 0);
    },
    [pushHistory, setNodes, setSelectedId, emit],
  );

  const addGroup = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect();
    const center = rect
      ? screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      : { x: 200, y: 160 };
    addGroupAt({ x: center.x - GROUP_W / 2, y: center.y - GROUP_H / 2 });
  }, [addGroupAt, screenToFlowPosition, rootRef]);

  const commitLabel = useCallback(
    (id: string, label: string) => {
      setEditingId(null);
      const node = nodes.find((n) => n.id === id);
      if (node && node.data.label === label) return; // 文案没变不记历史
      pushHistory();
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, label } } : n)));
      setTimeout(emit, 0);
    },
    [nodes, pushHistory, setNodes, setEditingId, emit],
  );

  const setEdgeLabel = useCallback(
    (id: string, label: string) => {
      const edge = edges.find((e) => e.id === id);
      if (edge && (edge.label || "") === label) return; // 说明没变不记历史
      pushHistory();
      setEdges((es) => es.map((e) => (e.id === id ? { ...e, label: label || undefined } : e)));
      setTimeout(emit, 0);
    },
    [edges, pushHistory, setEdges, emit],
  );

  /** 改连线线型（实 / 虚 / 粗）。solid 是默认值，**改回 solid 时要把字段删掉**，
   *  与 parseDiagram / serializeDiagram 的约定一致（solid 不入库）；
   *  否则落盘里会多一个 line:"solid"，与直接新建的边序列化结果不等，
   *  而「未保存」是靠序列化串比对基线判的——会凭空亮红点。 */
  const setEdgeLine = useCallback(
    (id: string, line: EdgeLine) => {
      const edge = edges.find((e) => e.id === id);
      if (edge && edgeLineOf(edge) === line) return; // 线型没变不记历史
      pushHistory();
      setEdges((es) =>
        es.map((e) => {
          if (e.id !== id) return e;
          const data: Record<string, unknown> = { ...(e.data ?? {}) };
          if (line === "solid") delete data.line;
          else data.line = line;
          return { ...e, data: Object.keys(data).length > 0 ? data : undefined };
        }),
      );
      setTimeout(emit, 0);
    },
    [edges, pushHistory, setEdges, emit],
  );

  const deleteNode = useCallback(
    (id: string) => {
      pushHistory();
      setNodes((ns) => ns.filter((n) => n.id !== id));
      setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
      if (selectedId === id) setSelectedId(null);
      setTimeout(emit, 0);
    },
    [pushHistory, setNodes, setEdges, selectedId, setSelectedId, emit],
  );

  const deleteEdge = useCallback(
    (id: string) => {
      pushHistory();
      setEdges((es) => es.filter((e) => e.id !== id));
      if (selectedEdgeId === id) setSelectedEdgeId(null);
      setTimeout(emit, 0);
    },
    [pushHistory, setEdges, selectedEdgeId, setSelectedEdgeId, emit],
  );

  const deleteTarget = useCallback(() => {
    if (selectedId) deleteNode(selectedId);
    else if (selectedEdgeId) deleteEdge(selectedEdgeId);
  }, [selectedId, selectedEdgeId, deleteNode, deleteEdge]);

  const deleteSelected = useCallback(() => {
    if (selectedId) deleteNode(selectedId);
  }, [selectedId, deleteNode]);

  const insertCopy = useCallback(
    (src: DNode) => {
      pushHistory();
      const copy: DNode = { ...clone(src), id: newId(), position: { x: src.position.x + 28, y: src.position.y + 28 } };
      setNodes((ns) => [...ns, copy]);
      setSelectedId(copy.id);
      setTimeout(emit, 0);
    },
    [pushHistory, setNodes, setSelectedId, emit],
  );

  const duplicateNode = useCallback(
    (id: string) => {
      const src = nodes.find((n) => n.id === id);
      if (src) insertCopy(src);
    },
    [nodes, insertCopy],
  );

  const copySelected = useCallback(() => {
    const src = nodes.find((n) => n.id === selectedId);
    if (src) clipboard.current = clone(src);
  }, [nodes, selectedId]);

  const pasteClipboard = useCallback(() => {
    if (clipboard.current) insertCopy(clipboard.current);
  }, [insertCopy]);

  const hasClipboard = useCallback(() => clipboard.current !== null, []);

  /** 统一的「改选中节点的某个 data 字段」，颜色 / 形状 / 字号 / 描边 / 焦点共用 */
  const patchSelected = useCallback(
    (patch: Partial<DNode["data"]>) => {
      if (!selectedId) return;
      pushHistory();
      setNodes((ns) => ns.map((n) => (n.id === selectedId ? { ...n, data: { ...n.data, ...patch } } : n)));
      setTimeout(emit, 0);
    },
    [selectedId, pushHistory, setNodes, emit],
  );

  const setNodeColor = useCallback((color: string) => patchSelected({ color }), [patchSelected]);
  const setNodeShape = useCallback((shape: NodeShape) => patchSelected({ shape }), [patchSelected]);
  const setNodeFontSize = useCallback((fontSize?: number) => patchSelected({ fontSize }), [patchSelected]);
  const setNodeStroke = useCallback((stroke?: string) => patchSelected({ stroke }), [patchSelected]);
  const setNodeTextColor = useCallback((textColor?: string) => patchSelected({ textColor }), [patchSelected]);
  const setNodeFocal = useCallback((focal: boolean) => patchSelected({ focal }), [patchSelected]);

  return {
    past, future, pushHistory, resetHistory, undo, redo,
    onConnect, addNode, addNodeAt, addGroup, addGroupAt, commitLabel, setEdgeLabel, setEdgeLine,
    deleteNode, deleteEdge, deleteTarget, deleteSelected,
    duplicateNode, copySelected, pasteClipboard, hasClipboard,
    setNodeColor, setNodeShape, setNodeFontSize, setNodeStroke, setNodeTextColor, setNodeFocal,
  };
}
