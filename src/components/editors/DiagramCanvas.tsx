/**
 * DiagramCanvas —— 流程图画布内核。
 *
 * 设计红线：
 *  - 节点严禁玻璃拟态 / backdrop-filter（规则 8.3：重复元素叠加 = N 个合成层，
 *    卡顿且糊）；节点用「实底 + 柔和阴影」，玻璃只用在工具栏 / 属性面板等浮层。
 *  - 6 套主题自适应：节点 / 连线 / 画布底色全部走 theme.css 里的 --diagram-* 令牌。
 *
 * 本文件只做「状态 + 装配」：模型层（撤销栈与增删改）、AI 增强、快捷键在 ./diagram/* 下，
 * 外围 UI 在 ./diagram/chrome/* 下（规则 #7：单个 .tsx 组件不超 300 行）。
 * 持久化（写入 DB）与导出文件 / AI 生成图由外层壳（DiagramEditor /
 * DiagramFullscreen）通过 ref 调 getDoc / markSaved 完成。
 *
 * chrome 分两套布局，按**画布容器实际宽度**而不是按壳切（见 useCompactChrome）。
 */
import { forwardRef, useCallback, useMemo, useRef, useState } from "react";
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
import { serializeDiagram, routeAutoEdges, isGroup, type DiagramDoc, type DNode } from "@/lib/diagram/types";
import { EditCtx, nodeTypes, type EditCtxValue } from "./diagram/DiagramNode";
import { useDiagramModel } from "./diagram/useDiagramModel";
import { useDiagramAi } from "./diagram/useDiagramAi";
import { useDiagramLayout } from "./diagram/useDiagramLayout";
import { useDiagramShortcuts } from "./diagram/useDiagramShortcuts";
import { useCompactChrome } from "./diagram/useCompactChrome";
import { useCanvasInteractions } from "./diagram/useCanvasInteractions";
import { useGroupDrag } from "./diagram/useGroupDrag";
import { useDisplayEdges } from "./diagram/useDisplayEdges";
import { useCanvasHandle, type DiagramCanvasHandle } from "./diagram/useCanvasHandle";
import { CULL_THRESHOLD, MINIMAP_THRESHOLD, SNAP_GRID, EDGE_MARKER } from "./diagram/flowOptions";
import { RoomyChrome } from "./diagram/chrome/RoomyChrome";
import { CompactChrome } from "./diagram/chrome/CompactChrome";
import { CanvasOverlays } from "./diagram/chrome/CanvasOverlays";
import type { ChromeActions } from "./diagram/chrome/types";
import { DiagramEmptyState } from "./diagram/DiagramEmptyState";
import { MermaidImportModal } from "./diagram/MermaidImportModal";
import styles from "./DiagramCanvas.module.css";

// 外部一直从本文件 import DiagramCanvasHandle，类型搬去 useCanvasHandle 后在这里转出，
// 不动 DiagramEditor / DiagramFullscreen 的 import。
export type { DiagramCanvasHandle };

interface DiagramCanvasProps {
  initialDoc: DiagramDoc;
  onChange?: (doc: DiagramDoc, dirty: boolean) => void;
}


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
  // 「未保存」按「当前文档 vs 基线（打开时 / 上次保存后）」判定，而不是「动过没」：
  // 否则撤销回初始状态后，未保存小红点仍然亮着。基线由 markSaved() 推进。
  const baselineRef = useRef(serializeDiagram(initialDoc));
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 按画布容器实际宽度选布局：默认 480px 窗口下弹窗画布 402 / 全屏 448，两者都该走紧凑档
  const compact = useCompactChrome(rootRef);

  // 用 ref 镜像 nodes/edges，让 emit 始终读取最新值（避免 setTimeout 里捕获陈旧闭包）。
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  const selectedNode = useMemo(() => nodes.find((n) => n.id === selectedId) || null, [nodes, selectedId]);
  const selectedEdge = useMemo(() => edges.find((e) => e.id === selectedEdgeId) || null, [edges, selectedEdgeId]);

  const displayEdges = useDisplayEdges(nodes, edges);

  const emit = useCallback(() => {
    const doc: DiagramDoc = { version: 1, nodes: nodesRef.current, edges: edgesRef.current };
    dirtyRef.current = serializeDiagram(doc) !== baselineRef.current;
    onChangeRef.current?.(doc, dirtyRef.current);
  }, []);

  const {
    past, future, pushHistory, resetHistory, undo, redo,
    onConnect, addNode, addNodeAt, addGroup, addGroupAt, commitLabel, setEdgeLabel, setEdgeLine,
    deleteNode, deleteEdge, deleteTarget, deleteSelected,
    duplicateNode, copySelected, pasteClipboard, hasClipboard,
    setNodeColor, setNodeShape, setNodeFontSize, setNodeStroke, setNodeTextColor, setNodeFocal,
  } = useDiagramModel({
    nodes, edges, setNodes, setEdges, emit,
    selectedId, setSelectedId, selectedEdgeId, setSelectedEdgeId, setEditingId,
    screenToFlowPosition, rootRef,
  });

  const { aiOn, aiBusy, aiPolish, aiExpand } = useDiagramAi({
    // 区域框不参与 AI：它没有“步骤文案”可润色，展开子流程也会把边接到一个没有 Handle 的框上。
    // 两套 chrome 已经不给框渲染 AI 入口，这里再堵一道（右键菜单也走同一个回调）。
    selectedNode: selectedNode && isGroup(selectedNode) ? null : selectedNode,
    setNodes, setEdges, pushHistory, commitLabel, emit,
  });

  // 拖区域框时带着框内节点一起走（成员按几何包含算，不是 React Flow 的 parentId）。
  // 必须声明在 onNodeDragStop 之前：那个回调要调 onGroupDragStop。
  // 拆开拿而不是整个对象进依赖：hook 每次渲染返回新对象字面量，把它写进 useCallback 依赖
  // 等于让 onNodeDragStop 每渲染一次就换一个身份，memo 彻底失效（改之前它是稳定的）。
  const {
    onNodeDragStart: onGroupDragStart,
    onNodeDrag: onGroupDrag,
    onNodeDragStop: onGroupDragStop,
  } = useGroupDrag({ nodesRef, setNodes });

  const doFitView = useCallback(() => { void fitView({ padding: 0.2 }); }, [fitView]);

  // 拖完节点要重算自动边的锚点（回边可能从“往上”变成“往下”）。
  // 放宏任务里等 React 把新位置提交完，nodesRef 才是新的；
  // 历史已在 onNodeDragStart 压过栈，这里不重复压。
  const onNodeDragStop = useCallback(() => {
    onGroupDragStop();
    setTimeout(() => {
      setEdges((es) => routeAutoEdges(nodesRef.current, es));
      emit();
    }, 0);
  }, [onGroupDragStop, setEdges, emit]);

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

  useCanvasHandle(ref, {
    nodes, edges, nodesRef, edgesRef, baselineRef, dirtyRef, past, future,
    fitView: doFitView, undo, redo, addNode, applyDoc,
  });

  const {
    menu, closeMenu, flowMenuProps,
    dragShape, setDragShape, dropAt, dragProps,
  } = useCanvasInteractions({ rootRef, setNodes, setEdges, addNodeAt, addGroupAt, screenToFlowPosition });

  // 两套布局拿同一份契约。不做 useMemo：selectedNode 在 nodes 一变就换引用，
  // 依赖数组永远命不中，包一层 memo 只是白花开销。
  const chrome: ChromeActions = {
    addNode: () => addNode(),
    addShape: (s) => addNode(s),
    addGroup,
    onDragShape: setDragShape,
    openImport: () => setImportOpen(true),
    undo, redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    layoutEngine, setLayoutEngine, runLayout, layouting,
    // 计数不算区域框（它不是“节点”），与 diagramTitle 的口径一致
    nodeCount: nodes.filter((n) => !isGroup(n)).length,
    edgeCount: edges.length,
    zoom,
    selectedNode, selectedEdge,
    aiOn, aiBusy,
    onLabel: commitLabel,
    onColor: setNodeColor,
    onStroke: setNodeStroke,
    onTextColor: setNodeTextColor,
    onShape: setNodeShape,
    onFontSize: setNodeFontSize,
    onFocal: setNodeFocal,
    onPolish: aiPolish,
    onExpand: aiExpand,
    onDeleteNode: deleteSelected,
    onEdgeLabel: setEdgeLabel,
    onEdgeLine: setEdgeLine,
    onDeleteEdge: deleteEdge,
  };

  return (
    <EditCtx.Provider value={editCtxValue}>
      <div
        className={styles.root}
        ref={rootRef}
        onDoubleClick={onPaneDoubleClick}
        {...dragProps}
      >
        {compact ? (
          <CompactChrome a={chrome} rootRef={rootRef} />
        ) : (
          <RoomyChrome a={chrome} rootRef={rootRef} />
        )}

        <CanvasOverlays
          dragShape={dragShape}
          dropAt={dropAt}
          menu={menu}
          onCloseMenu={closeMenu}
          menuActions={{
            duplicateNode, copySelected, pasteClipboard, hasClipboard, aiOn, aiBusy,
            polish: aiPolish, expand: aiExpand, setFocal: setNodeFocal,
            deleteNode, setEdgeLine, deleteEdge,
            addNodeAt: (p) => addNodeAt(p),
            layout: runLayout, fitView: doFitView,
            openImport: () => setImportOpen(true),
          }}
        />

        {importOpen && <MermaidImportModal onImport={importMermaid} onClose={() => setImportOpen(false)} />}

        {nodes.length === 0 && (
          <DiagramEmptyState onImport={() => setImportOpen(true)} onAddNode={() => addNode()} />
        )}

        <ReactFlow
          nodes={nodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          connectionMode={ConnectionMode.Loose}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStart={(e, n) => {
            pushHistory();
            onGroupDragStart(e, n as DNode);
          }}
          onNodeDrag={(e, n) => onGroupDrag(e, n as DNode)}
          onNodeDragStop={onNodeDragStop}
          onSelectionChange={({ nodes: sn, edges: se }) => {
            setSelectedId(sn.length === 1 && se.length === 0 ? sn[0].id : null);
            setSelectedEdgeId(se.length === 1 && sn.length === 0 ? se[0].id : null);
          }}
          onPaneClick={() => {
            setSelectedId(null);
            setSelectedEdgeId(null);
          }}
          onNodeContextMenu={(e, n) => flowMenuProps.onNodeContextMenu(e, n as DNode)}
          onEdgeContextMenu={flowMenuProps.onEdgeContextMenu}
          onPaneContextMenu={flowMenuProps.onPaneContextMenu}
          fitView
          minZoom={0.2}
          maxZoom={2}
          deleteKeyCode={null}
          onlyRenderVisibleElements={nodes.length > CULL_THRESHOLD}
          snapToGrid
          snapGrid={[SNAP_GRID, SNAP_GRID]}
          defaultEdgeOptions={{ type: "smoothstep", markerEnd: EDGE_MARKER }}
          proOptions={{ hideAttribution: true }}
          onMove={(_, vp) => setZoom(vp.zoom)}
        >
          {/* 点阵间距与点径向设计稿对齐（颜色在 CSS 里覆盖成 accent 混色） */}
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
          <Controls showInteractive={false} />
          {/* 紧凑档不渲染 MiniMap：132px 小地图在 402px 画布上没意义，
              而且它在右下、正好被贴底的属性抽屉盖住 */}
          {/* 不给 className：原先写的 styles.minimap 在 CSS 里根本没声明过，取到 undefined、
              一直是句死代码；真正生效的是 .root :global(.react-flow__minimap) 那组规则 */}
          {!compact && nodes.length > MINIMAP_THRESHOLD && <MiniMap pannable zoomable />}
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
