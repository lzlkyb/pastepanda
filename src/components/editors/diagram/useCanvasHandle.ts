/**
 * 画布对外暴露的命令式接口（从 DiagramCanvas 拆出，规则 #7）。
 *
 * 外层壳（DiagramEditor / DiagramFullscreen）靠它拿文档、触发撤销重做、导出图片，
 * 以及保存成功后把「未保存」基线推到当前文档。
 */
import { useImperativeHandle, type Ref, type RefObject } from "react";
import type { Edge } from "@xyflow/react";
import { serializeDiagram, type DiagramDoc, type DNode, type NodeShape } from "@/lib/diagram/types";

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

interface Args {
  nodes: DNode[];
  edges: Edge[];
  nodesRef: RefObject<DNode[]>;
  edgesRef: RefObject<Edge[]>;
  baselineRef: RefObject<string>;
  dirtyRef: RefObject<boolean>;
  past: RefObject<unknown[]>;
  future: RefObject<unknown[]>;
  fitView: () => void;
  undo: () => void;
  redo: () => void;
  addNode: (shape?: NodeShape) => void;
  applyDoc: (doc: DiagramDoc) => void;
}

export function useCanvasHandle(ref: Ref<DiagramCanvasHandle>, a: Args) {
  useImperativeHandle(
    ref,
    () => ({
      getDoc: () => ({ version: 1, nodes: a.nodes, edges: a.edges }),
      getViewportEl: () => document.querySelector<HTMLElement>(".react-flow__viewport"),
      fitView: a.fitView,
      undo: a.undo,
      redo: a.redo,
      canUndo: () => a.past.current.length > 0,
      canRedo: () => a.future.current.length > 0,
      addNode: () => a.addNode(),
      applyDoc: a.applyDoc,
      markSaved: () => {
        a.baselineRef.current = serializeDiagram({
          version: 1,
          nodes: a.nodesRef.current,
          edges: a.edgesRef.current,
        });
        a.dirtyRef.current = false;
      },
    }),
    // a 每次渲染都是新对象，依赖得列它的字段而不是 a 本身；
    // ref 类字段（nodesRef / baselineRef / past / future）身份稳定，不入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [a.nodes, a.edges, a.fitView, a.undo, a.redo, a.addNode, a.applyDoc],
  );
}
