/**
 * 画布内的 AI 增强（润色文案 / 展开子流程）。红线 #16：入口只在 AI 可用时渲染，
 * 未配置时零请求、零成本、完全不可见——所以 aiOn 由本 hook 一并给出。
 */
import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { Edge } from "@xyflow/react";
import { expandSubflow, polishNodeLabel } from "@/lib/diagram/aiGenerate";
import { newId, DEFAULT_EDGE_HANDLES, AUTO_ROUTE_DATA, routeAutoEdges, type DNode } from "@/lib/diagram/types";
import { errText } from "@/lib/utils";
import { useAiStatus } from "@/hooks/useAiStatus";
import { useToast } from "@/components/Toast";

export interface DiagramAiOpts {
  selectedNode: DNode | null;
  setNodes: Dispatch<SetStateAction<DNode[]>>;
  setEdges: Dispatch<SetStateAction<Edge[]>>;
  pushHistory: () => void;
  commitLabel: (id: string, label: string) => void;
  emit: () => void;
}

export function useDiagramAi(o: DiagramAiOpts) {
  const { selectedNode, setNodes, setEdges, pushHistory, commitLabel, emit } = o;
  const [aiBusy, setAiBusy] = useState(false);
  const ai = useAiStatus();
  const { toast } = useToast();

  /** AI 润色选中节点文案 */
  const aiPolish = useCallback(async () => {
    if (!selectedNode) return;
    setAiBusy(true);
    try {
      const polished = await polishNodeLabel(selectedNode.data.label);
      if (polished && polished !== selectedNode.data.label) {
        commitLabel(selectedNode.id, polished);
      } else {
        toast("AI 未能给出更好的表述", "info");
      }
    } catch (e) {
      toast("AI 润色失败：" + errText(e, "未知错误"), "error");
    } finally {
      setAiBusy(false);
    }
  }, [selectedNode, commitLabel, toast]);

  /** AI 把选中节点展开为子流程（在其下方插入子节点并连线） */
  const aiExpand = useCallback(async () => {
    if (!selectedNode) return;
    setAiBusy(true);
    try {
      const sub = await expandSubflow(selectedNode.data.label);
      pushHistory();
      const baseX = selectedNode.position.x;
      const baseY = selectedNode.position.y + 110;
      const remap = new Map<string, string>();
      const newNodes: DNode[] = sub.nodes.map((n) => {
        const id = newId();
        remap.set(n.id, id);
        return {
          ...n,
          id,
          type: "diagram",
          position: { x: baseX + (Math.random() * 160 - 80), y: baseY + Math.random() * 60 },
        };
      });
      // 锚点要显式带上：裸边会被 React Flow 画成 top→top，看着就是接错位。
      // 同时打 autoRoute 标记，下次布局 / 拖动时能跟着重算。
      const newEdges = sub.edges.map((e) => ({
        id: newId("e"),
        source: remap.get(e.source) ?? e.source,
        target: remap.get(e.target) ?? e.target,
        label: e.label,
        type: "smoothstep",
        ...DEFAULT_EDGE_HANDLES,
        data: { ...AUTO_ROUTE_DATA },
      }));
      const firstId = newNodes[0]?.id;
      const connectEdge = firstId
        ? {
            id: newId("e"),
            source: selectedNode.id,
            target: firstId,
            type: "smoothstep" as const,
            ...DEFAULT_EDGE_HANDLES,
            data: { ...AUTO_ROUTE_DATA },
          }
        : null;
      const added = [...newEdges, ...(connectEdge ? [connectEdge] : [])];
      setNodes((ns) => [...ns, ...newNodes]);
      // 子流程节点是现算位置（没走布局），当场把锚点算出来，别等下次布局
      setEdges((es) => [...es, ...routeAutoEdges([selectedNode, ...newNodes], added)]);
      setTimeout(emit, 0);
      toast("AI 已展开子流程", "success");
    } catch (e) {
      toast("AI 展开失败：" + errText(e, "未知错误"), "error");
    } finally {
      setAiBusy(false);
    }
  }, [selectedNode, pushHistory, setNodes, setEdges, emit, toast]);

  return { aiOn: ai.status === "on", aiBusy, aiPolish, aiExpand };
}
