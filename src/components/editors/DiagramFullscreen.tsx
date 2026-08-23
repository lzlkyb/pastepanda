/**
 * DiagramFullscreen —— 流程图的全屏 OS 窗口编辑形态（与 RichFullscreen 同地位）。
 *
 * 复用 FullscreenEditor 的外层窗口壳（独立 OS 窗口 / 开关 / 拖拽 / 主题），
 * 内部完全绕开 CodeMirror 路径，对其它类型零影响。
 * 样式复用 FullscreenEditor.module.css，保证工具栏观感一致。
 */
import { useCallback, useRef, useState } from "react";
import { Sparkles, FileCode } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useToast } from "@/components/Toast";
import { useAiStatus } from "@/hooks/useAiStatus";
import { generateDiagramFromPrompt } from "@/lib/diagram/aiGenerate";
import { errText } from "@/lib/utils";
import { parseDiagram, serializeDiagram, toMermaid, diagramTitle } from "@/lib/diagram/types";
import { DiagramCanvas, type DiagramCanvasHandle } from "./DiagramCanvas";
import { DiagramAiPanel } from "./diagram/DiagramAiPanel";
import { useDiagramExport } from "./diagram/useDiagramExport";
import { ExportMenu } from "./diagram/ExportMenu";
import { FullscreenShell } from "./FullscreenShell";
import editorStyles from "./DiagramEditor.module.css";

export function DiagramFullscreen({
  sourceId,
  initContent,
  onClose,
}: {
  sourceId: string | null;
  initContent: string | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const canvasRef = useRef<DiagramCanvasHandle>(null);
  const originalDoc = useRef(parseDiagram(initContent)).current;
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const ai = useAiStatus();
  const [isDirty, setIsDirty] = useState(false);
  // 顶栏标题跟着内容走（设计稿的 doc-title），而不是写死一个字符串。
  // diagram 没有独立的标题字段，口径与卡片一致：用 diagramTitle（节点标签拼串）。
  const [docTitle, setDocTitle] = useState(() => diagramTitle(originalDoc));

  const setDirty = useCallback((d: boolean) => { setIsDirty(d); }, []);

  const copyMermaid = useCallback(() => {
    const doc = canvasRef.current?.getDoc();
    if (!doc) return;
    const m = toMermaid(doc);
    navigator.clipboard?.writeText(m).then(
      () => toast("已复制 Mermaid 源码", "success"),
      () => toast("复制失败", "error"),
    );
  }, [toast]);

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!sourceId) {
      toast("无来源记录，无法保存", "error");
      return false;
    }
    const doc = canvasRef.current?.getDoc();
    if (!doc) return false;
    try {
      await invoke("update_diagram_history", {
        id: sourceId,
        content: serializeDiagram(doc),
        // text 是 FTS 检索用的可搜索文本，口径必须和 insert_diagram_history 一致（节点标签拼接）。
        // 写 toMermaid 会把 flowchart TD / n1[...] 这类语法噪声一并塞进索引。
        text: diagramTitle(doc),
      });
      canvasRef.current?.markSaved();
      setIsDirty(false);
      toast("已保存", "success");
      return true;
    } catch (e) {
      toast("保存失败：" + String(e), "error");
      return false;
    }
  }, [sourceId, toast]);

  const runAi = useCallback(async () => {
    if (!aiPrompt.trim()) return;
    setAiLoading(true);
    try {
      const doc = await generateDiagramFromPrompt(aiPrompt.trim());
      canvasRef.current?.applyDoc(doc);
      setIsDirty(true);
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
    <FullscreenShell
      icon="📊"
      title={docTitle}
      dirty={isDirty}
      onSave={handleSave}
      onClose={onClose}
      leftExtra={
        <>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "var(--accent, #3b9eff)",
              background: "color-mix(in srgb, var(--accent, #3b9eff) 18%, transparent)",
              padding: "2px 7px",
              borderRadius: 999,
              marginLeft: 6,
            }}
          >
            diagram
          </span>
          {ai.status === "on" && (
            <button className={editorStyles.aiBtn} style={{ marginLeft: 10 }} onClick={() => setAiOpen((v) => !v)}>
              <Sparkles size={14} /> AI 生成
            </button>
          )}
          <button className={editorStyles.ghostBtn} onClick={copyMermaid} title="复制 Mermaid 源码">
            <FileCode size={14} /> Mermaid
          </button>
          <ExportMenu onExport={exportAs} />
        </>
      }
    >
      {aiOpen && (
        <DiagramAiPanel
          prompt={aiPrompt}
          onPromptChange={setAiPrompt}
          loading={aiLoading}
          onRun={runAi}
          onCancel={() => setAiOpen(false)}
          style={{ position: "absolute", top: 52, left: 16, right: 16, zIndex: 30 }}
        />
      )}

      <div style={{ flex: 1, minHeight: 0, display: "flex", padding: "0 16px 16px" }}>
        <DiagramCanvas
          ref={canvasRef}
          initialDoc={originalDoc}
          onChange={(d, dirty) => {
            setDirty(dirty);
            setDocTitle(diagramTitle(d));
          }}
        />
      </div>
    </FullscreenShell>
  );
}
