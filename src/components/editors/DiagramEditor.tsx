/**
 * DiagramEditor —— 流程图的「内嵌」编辑器（ItemEditorDialog 的 shell 变体主体）。
 *
 * 通过 registerActions 把 保存 / 复制(mermaid) 能力上报给外壳（footer 的保存按钮
 * 与 Ctrl+Enter 由外壳驱动）。AI 生成入口（红线 #16）仅当 AI 可用（status==="on"）
 * 时才渲染，未配置时零请求、零成本、完全不可见。导出 / 全屏在自身 actionBar 完成。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sparkles, Download, Maximize2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import { useDialogStore } from "@/stores/dialogStore";
import { getAiAvailability } from "@/lib/aiAvailability";
import { errText } from "@/lib/utils";
import { generateDiagramFromPrompt } from "@/lib/diagram/aiGenerate";
import {
  parseDiagram,
  serializeDiagram,
  toMermaid,
  diagramTitle,
  type DiagramDoc,
} from "@/lib/diagram/types";
import { DiagramCanvas, type DiagramCanvasHandle } from "./DiagramCanvas";
import { DiagramAiPanel } from "./diagram/DiagramAiPanel";
import { useDiagramExport } from "./diagram/useDiagramExport";
import styles from "./DiagramEditor.module.css";

export function DiagramEditor({ item, registerActions }: { item: import("@/stores/appStore").HistoryItem; registerActions: (a: import("@/lib/editorRegistry").EditorActions) => void }) {
  const { toast } = useToast();
  const canvasRef = useRef<DiagramCanvasHandle>(null);
  const [dirty, setDirty] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const ai = getAiAvailability();
  const closeEditor = useDialogStore((s) => s.closeEditor);

  const initialDoc = useRef(parseDiagram(item.content)).current;

  const handleChange = useCallback((_doc: DiagramDoc, isDirty: boolean) => {
    setDirty(isDirty);
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    const doc = canvasRef.current?.getDoc();
    if (!doc) return false;
    const content = serializeDiagram(doc);
    try {
      // text 是 FTS 检索用的可搜索文本，口径与 insert_diagram_history 保持一致（节点标签拼接）；
      // 写 toMermaid 会把 flowchart TD / n1[...] 这类语法噪声一并塞进索引。
      await invoke("update_diagram_history", { id: item.id, content, text: diagramTitle(doc) });
      canvasRef.current?.markSaved();
      setDirty(false);
      toast("流程图已保存", "success");
      return true;
    } catch (e) {
      toast("保存失败：" + String(e), "error");
      return false;
    }
  }, [item.id, toast]);

  const copy = useCallback(() => {
    const doc = canvasRef.current?.getDoc();
    if (!doc) return;
    const m = toMermaid(doc);
    navigator.clipboard?.writeText(m).then(
      () => toast("已复制 Mermaid 源码", "success"),
      () => toast("复制失败", "error"),
    );
  }, [toast]);

  useEffect(() => {
    registerActions({ save, copy, isDirty: () => dirty });
  }, [registerActions, save, copy, dirty]);

  const launchFullscreen = useCallback(() => {
    const doc = canvasRef.current?.getDoc();
    const content = doc ? serializeDiagram(doc) : item.content || "";
    // 关闭内嵌弹窗，避免与全屏窗口双开同一记录
    closeEditor(item.id);
    invoke("open_fullscreen_editor", {
      sourceId: item.id,
      content,
      contentType: "diagram",
      language: null,
    }).catch((e) => toast("打开全屏失败：" + String(e), "error"));
  }, [item.id, item.content, closeEditor, toast]);

  const runAi = useCallback(async () => {
    if (!aiPrompt.trim()) return;
    setAiLoading(true);
    try {
      const doc = await generateDiagramFromPrompt(aiPrompt.trim());
      canvasRef.current?.applyDoc(doc);
      setDirty(true);
      setAiOpen(false);
      setAiPrompt("");
      toast("AI 已生成流程图", "success");
    } catch (e) {
      toast("AI 生成失败：" + errText(e, "未知错误"), "error");
    } finally {
      setAiLoading(false);
    }
  }, [aiPrompt, toast]);

  const exportAs = useDiagramExport(canvasRef);

  return (
    <div className={styles.editor}>
      <div className={styles.actionBar}>
        {ai.status === "on" && (
          <button className={styles.aiBtn} onClick={() => setAiOpen((v) => !v)} title="AI 生成流程图">
            <Sparkles size={14} /> AI 生成
          </button>
        )}
        <div className={styles.spacer} />
        <div className={styles.exportWrap}>
          <button className={styles.ghostBtn} onClick={() => exportAs("png")} title="导出 PNG">
            <Download size={14} /> 导出
          </button>
          <div className={styles.exportMenu}>
            <button onClick={() => exportAs("png")}>🖼 PNG 图片</button>
            <button onClick={() => exportAs("svg")}>📐 SVG 矢量</button>
            <button onClick={() => exportAs("mermaid")}>🧩 Mermaid 源码</button>
            <button onClick={() => exportAs("panda")}>💾 PastePanda 文件</button>
          </div>
        </div>
        <button className={styles.ghostBtn} onClick={launchFullscreen} title="全屏编辑">
          <Maximize2 size={14} /> 全屏
        </button>
      </div>

      {aiOpen && (
        <DiagramAiPanel
          prompt={aiPrompt}
          onPromptChange={setAiPrompt}
          loading={aiLoading}
          onRun={runAi}
          onCancel={() => setAiOpen(false)}
        />
      )}

      <div className={styles.canvasWrap}>
        <DiagramCanvas ref={canvasRef} initialDoc={initialDoc} onChange={handleChange} />
      </div>
    </div>
  );
}
