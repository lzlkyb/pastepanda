/**
 * DiagramCanvas —— 流程图画布内核（Phase 1 主线）。
 *
 * 设计红线：
 *  - 节点严禁玻璃拟态 / backdrop-filter（规则 8.3：重复元素叠加 = N 个合成层，
 *    卡顿且糊）；节点用「实底 + 柔和阴影」，玻璃只用在工具栏 / 属性面板等浮层。
 *  - 6 套主题自适应：节点 / 连线 / 画布底色全部走 theme.css 里的 --diagram-* 令牌。
 *
 * 本文件只做「状态 + 装配」；模型层（撤销栈与增删改）、AI 增强、快捷键、
 * 各面板都在 ./diagram/* 下（规则 #7：单个 .tsx 组件不超过 300 行）。
 * 持久化（写入 DB）与导出文件 / AI 生成图由外层壳（DiagramEditor /
 * DiagramFullscreen）通过 ref 调 getDoc / markSaved 完成。
 */
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ConnectionMode,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { serializeDiagram, routeAutoEdges, type DiagramDoc, type DNode } from "@/lib/diagram/types";
import { EditCtx, nodeTypes, type EditCtxValue } from "./diagram/DiagramNode";
import { useDiagramModel } from "./diagram/useDiagramModel";
import { useDiagramAi } from "./diagram/useDiagramAi";
import { useDiagramLayout } from "./diagram/useDiagramLayout";
import { useDiagramShortcuts } from "./diagram/useDiagramShortcuts";
import { DiagramToolbar, DiagramShapeLibrary, DiagramStatusBar } from "./diagram/DiagramToolbar";
import { NodePropPanel, EdgePropPanel } from "./diagram/DiagramPropPanel";
import { DiagramEmptyState } from "./diagram/DiagramEmptyState";
import { MermaidImportModal } from "./diagram/MermaidImportModal";
import styles from "./DiagramCanvas.module.css";

export interface DiagramCanvasHandle {
  getDoc: () => DiagramDoc;
  getViewportEl: () => HTMLElement | null;
  fitView: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  addNode: () => void;
  applyDoc: (doc: DiagramDoc) => void;
  /** 外层壳保存成功后调用，把「未保存」基线推到当前文档 */
  markSaved: () => void;
}

interface DiagramCanvasProps {
  initialDoc: DiagramDoc;
  onChange?: (doc: DiagramDoc, dirty: boolean) => void;
}

/** 节点数超过此阈值才开启视口裁剪（onlyRenderVisibleElements），小图下是无谓开销 */
const CULL_THRESHOLD = 200;

const CanvasInner = forwardRef<DiagramCanvasHandle, DiagramCanvasProps>(function CanvasInner(
  { initialDoc, onChange },
  ref,
) {
  const [nodes, setNodes, onNodesChange] = useNodesState<DNode>(initialDoc.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialDoc.edges);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const rootRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, fitView } = useReactFlow();
  const dirtyRef = useRef(false);
  // 「未保存」按「当前文档 vs 基线（打开时 / 上次保存后）」判定，而不是「动过没有」：
  // 否则撤销回初始状态后，未保存小红点仍然亮着。基线由 markSaved() 推进。
  const baselineRef = useRef(serializeDiagram(initialDoc));
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 用 ref 镜像 nodes/edges，让 emit 始终读取最新值（避免 setTimeout 里捕获陈旧闭包）。
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  const selectedNode = useMemo(() => nodes.find((n) => n.id === selectedId) || null, [nodes, selectedId]);
  const selectedEdge = useMemo(() => edges.find((e) => e.id === selectedEdgeId) || null, [edges, selectedEdgeId]);

  // 焦点路径的边加流动虚线（设计稿 .edge.key）：**任一端是焦点节点**就算。
  // 不能要求两端都是——设计稿里只有一个节点带 focal，两条 key 边都是接到它身上的；
  // 写成「两端都是」的话除非用户把一条链整条标成焦点，否则永远不会生效。
  // 用「焦点 id 拼串」而不是 nodes 做依赖：nodes 在拖拽时每帧都变，
  // 直接依赖会每帧重建一批新的 edge 对象，把整张图的边都重渲一遍。
  const focalKey = nodes.filter((n) => n.data.focal).map((n) => n.id).sort().join(",");
  const displayEdges = useMemo(() => {
    if (!focalKey) return edges;
    const focal = new Set(focalKey.split(","));
    return edges.map((e) =>
      focal.has(e.source) || focal.has(e.target)
        ? { ...e, className: [e.className, styles.edgeKey].filter(Boolean).join(" ") }
        : e,
    );
  }, [focalKey, edges]);

  const emit = useCallback(() => {
    const doc: DiagramDoc = { version: 1, nodes: nodesRef.current, edges: edgesRef.current };
    dirtyRef.current = serializeDiagram(doc) !== baselineRef.current;
    onChangeRef.current?.(doc, dirtyRef.current);
  }, []);

  const {
    past, future, pushHistory, resetHistory, undo, redo,
    onConnect, addNode, addNodeAt, commitLabel, setEdgeLabel,
    deleteEdge, deleteTarget, deleteSelected,
    duplicateNode, copySelected, pasteClipboard, hasClipboard,
    setNodeColor, setNodeShape, setNodeFontSize, setNodeStroke, setNodeFocal,
  } = useDiagramModel({
    nodes, edges, setNodes, setEdges, emit,
    selectedId, setSelectedId, selectedEdgeId, setSelectedEdgeId, setEditingId,
    screenToFlowPosition, rootRef,
  });

  const { aiOn, aiBusy, aiPolish, aiExpand } = useDiagramAi({
    selectedNode, setNodes, setEdges, pushHistory, commitLabel, emit,
  });

  const doFitView = useCallback(() => { void fitView({ padding: 0.2 }); }, [fitView]);

  // 拖完节点要重算自动边的锚点（回边可能从“往上”变成“往下”）。
  // 放宏任务里等 React 把新位置提交完，nodesRef 才是新的；
  // 历史已在 onNodeDragStart 压过栈，这里不重复压。
  const onNodeDragStop = useCallback(() => {
    setTimeout(() => {
      setEdges((es) => routeAutoEdges(nodesRef.current, es));
      emit();
    }, 0);
  }, [setEdges, emit]);

  const { layoutEngine, setLayoutEngine, layouting, applyDoc, runLayout, importMermaid } = useDiagramLayout({
    nodes, edges, setNodes, setEdges, emit, pushHistory, resetHistory,
    fitView: doFitView,
    onImported: () => setImportOpen(false),
  });

  const onPaneDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (importOpen) return;
      const target = e.target as HTMLElement;
      if (!target.classList.contains("react-flow__pane")) return;
      addNodeAt(screenToFlowPosition({ x: e.clientX, y: e.clientY }));
    },
    [importOpen, addNodeAt, screenToFlowPosition],
  );

  const editCtxValue = useMemo<EditCtxValue>(
    () => ({ editingId, setEditingId, commitLabel }),
    [editingId, commitLabel],
  );

  useDiagramShortcuts({
    enabled: !importOpen, rootRef, selectedId, selectedEdgeId, hasClipboard,
    undo, redo, deleteTarget, duplicateNode, copySelected, pasteClipboard,
    fitView: doFitView, layout: runLayout,
  });

  useImperativeHandle(
    ref,
    () => ({
      getDoc: () => ({ version: 1, nodes, edges }),
      getViewportEl: () => document.querySelector<HTMLElement>(".react-flow__viewport"),
      fitView: doFitView,
      undo,
      redo,
      canUndo: () => past.current.length > 0,
      canRedo: () => future.current.length > 0,
      addNode,
      applyDoc,
      markSaved: () => {
        baselineRef.current = serializeDiagram({ version: 1, nodes: nodesRef.current, edges: edgesRef.current });
        dirtyRef.current = false;
      },
    }),
    [nodes, edges, doFitView, undo, redo, addNode, applyDoc, past, future],
  );

  return (
    <EditCtx.Provider value={editCtxValue}>
      <div className={styles.root} ref={rootRef} onDoubleClick={onPaneDoubleClick}>
        <DiagramToolbar
          onAddNode={() => addNode()}
          onOpenImport={() => setImportOpen(true)}
          onUndo={undo}
          onRedo={redo}
          canUndo={past.current.length > 0}
          canRedo={future.current.length > 0}
          layoutEngine={layoutEngine}
          onLayoutEngineChange={setLayoutEngine}
          onLayout={runLayout}
          layouting={layouting}
          nodeCount={nodes.length}
        />

        <DiagramShapeLibrary onAddShape={addNode} />

        {importOpen && <MermaidImportModal onImport={importMermaid} onClose={() => setImportOpen(false)} />}

        {selectedNode && (
          <NodePropPanel
            node={selectedNode}
            aiOn={aiOn}
            aiBusy={aiBusy}
            onLabel={commitLabel}
            onColor={setNodeColor}
            onStroke={setNodeStroke}
            onShape={setNodeShape}
            onFontSize={setNodeFontSize}
            onFocal={setNodeFocal}
            onPolish={aiPolish}
            onExpand={aiExpand}
            onDelete={deleteSelected}
          />
        )}

        {selectedEdge && !selectedNode && (
          <EdgePropPanel edge={selectedEdge} onLabel={setEdgeLabel} onDelete={deleteEdge} />
        )}

        {nodes.length === 0 && (
          <DiagramEmptyState onImport={() => setImportOpen(true)} onAddNode={() => addNode()} />
        )}

        <DiagramStatusBar nodeCount={nodes.length} edgeCount={edges.length} layoutEngine={layoutEngine} zoom={zoom} />

        <ReactFlow
          nodes={nodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          connectionMode={ConnectionMode.Loose}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStart={pushHistory}
          onNodeDragStop={onNodeDragStop}
          onSelectionChange={({ nodes: sn, edges: se }) => {
            setSelectedId(sn.length === 1 && se.length === 0 ? sn[0].id : null);
            setSelectedEdgeId(se.length === 1 && sn.length === 0 ? se[0].id : null);
          }}
          onPaneClick={() => {
            setSelectedId(null);
            setSelectedEdgeId(null);
          }}
          fitView
          minZoom={0.2}
          maxZoom={2}
          deleteKeyCode={null}
          onlyRenderVisibleElements={nodes.length > CULL_THRESHOLD}
          defaultEdgeOptions={{ type: "smoothstep" }}
          proOptions={{ hideAttribution: true }}
          onMove={(_, vp) => setZoom(vp.zoom)}
        >
          {/* 点阵间距与点径向设计稿对齐（颜色在 CSS 里覆盖成 accent 混色） */}
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
          <Controls showInteractive={false} />
          {nodes.length > 10 && <MiniMap pannable zoomable className={styles.minimap} />}
        </ReactFlow>
      </div>
    </EditCtx.Provider>
  );
});

export const DiagramCanvas = forwardRef<DiagramCanvasHandle, DiagramCanvasProps>(function DiagramCanvas(props, ref) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} ref={ref} />
    </ReactFlowProvider>
  );
});
