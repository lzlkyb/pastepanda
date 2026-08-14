/**
 * 布局与「整篇替换文档」的编排（从 DiagramCanvas 拆出，规则 #7）。
 * 自动布局（dagre / elk / 按节点数自选）、Mermaid 导入、applyDoc 都在这里。
 */
import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { Edge } from "@xyflow/react";
import { autoLayout, autoLayoutElk, parseMermaid, type DiagramDoc, type DNode } from "@/lib/diagram/types";
import type { LayoutEngine } from "./chrome/types";

/** 切换到 elk 引擎的节点数阈值（layoutEngine === "auto" 时） */
const ELK_AUTO_THRESHOLD = 30;

export interface DiagramLayoutOpts {
  nodes: DNode[];
  edges: Edge[];
  setNodes: Dispatch<SetStateAction<DNode[]>>;
  setEdges: Dispatch<SetStateAction<Edge[]>>;
  emit: () => void;
  pushHistory: () => void;
  resetHistory: () => void;
  fitView: () => void;
  /** 导入成功后的回调（画布拿来关弹窗） */
  onImported: () => void;
}

export function useDiagramLayout(o: DiagramLayoutOpts) {
  const { nodes, edges, setNodes, setEdges, emit, pushHistory, resetHistory, fitView, onImported } = o;
  const [layoutEngine, setLayoutEngine] = useState<LayoutEngine>("dagre");
  const [layouting, setLayouting] = useState(false);

  const applyDoc = useCallback(
    (doc: DiagramDoc) => {
      resetHistory();
      setNodes(doc.nodes);
      setEdges(doc.edges);
      setTimeout(fitView, 0);
      setTimeout(emit, 0);
    },
    [resetHistory, setNodes, setEdges, fitView, emit],
  );

  const runLayout = useCallback(async () => {
    const engine =
      layoutEngine === "auto" ? (nodes.length > ELK_AUTO_THRESHOLD ? "elk" : "dagre") : layoutEngine;
    pushHistory();
    // 布局函数返回的 edges 已经重算过锚点（routeAutoEdges），
    // 必须连 edges 一起写回去——只取 nodes 的话节点换了位置而回边还沿着旧方向绕。
    if (engine === "elk") {
      setLayouting(true);
      try {
        const doc = await autoLayoutElk({ version: 1, nodes, edges });
        setNodes(doc.nodes);
        setEdges(doc.edges);
      } finally {
        setLayouting(false);
      }
    } else {
      const doc = autoLayout({ version: 1, nodes, edges });
      setNodes(doc.nodes);
      setEdges(doc.edges);
    }
    setTimeout(() => {
      fitView();
      emit();
    }, 0);
  }, [layoutEngine, nodes, edges, pushHistory, setNodes, setEdges, fitView, emit]);

  /** 返回错误文案表示解析失败（留在弹窗），返回 null 表示已应用 */
  const importMermaid = useCallback(
    (text: string): string | null => {
      const doc = parseMermaid(text);
      if (doc.nodes.length === 0) {
        return "未能解析出任何节点，请检查 Mermaid 语法，例如：\nflowchart TD\n  A[开始] --> B[处理]";
      }
      applyDoc(doc);
      onImported();
      return null;
    },
    [applyDoc, onImported],
  );

  return { layoutEngine, setLayoutEngine, layouting, applyDoc, runLayout, importMermaid };
}
