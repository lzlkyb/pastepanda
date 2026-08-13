/**
 * DiagramFullscreen —— 流程图的全屏 OS 窗口编辑形态（与 RichFullscreen 同地位）。
 *
 * 复用 FullscreenEditor 的外层窗口壳（独立 OS 窗口 / 开关 / 拖拽 / 主题），
 * 内部完全绕开 CodeMirror 路径，对其它类型零影响。
 * 样式复用 FullscreenEditor.module.css，保证工具栏观感一致。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Save, X, Maximize2, Minimize2, Sparkles, Download, FileCode } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useToast } from "@/components/Toast";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SkinScene } from "@/components/SkinScene";
import { useAiStatus } from "@/hooks/useAiStatus";
import { generateDiagramFromPrompt } from "@/lib/diagram/aiGenerate";
import { errText } from "@/lib/utils";
import { parseDiagram, serializeDiagram, toMermaid, diagramTitle } from "@/lib/diagram/types";
import { DiagramCanvas, type DiagramCanvasHandle } from "./DiagramCanvas";
import { DiagramAiPanel } from "./diagram/DiagramAiPanel";
import { useDiagramExport } from "./diagram/useDiagramExport";
import styles from "./FullscreenEditor.module.css";
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
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showConfirmClose, setShowConfirmClose] = useState(false);
  const [isDarkTheme, setIsDarkTheme] = useState(true);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const ai = useAiStatus();
  const [isDirty, setIsDirty] = useState(false);
  // 顶栏标题跟着内容走（设计稿的 doc-title），而不是写死一个字符串。
  // diagram 没有独立的标题字段，口径与卡片一致：用 diagramTitle（节点标签拼串）。
  const [docTitle, setDocTitle] = useState(() => diagramTitle(originalDoc));

  const setDirty = useCallback((d: boolean) => { setIsDirty(d); }, []);

  useEffect(() => {
    const applyTheme = (theme: string) => {
      setIsDarkTheme(theme === "midnight" || theme === "ocean-dark" || theme === "");
    };
    invoke<Record<string, unknown>>("get_config")
      .then((cfg) => applyTheme(String(cfg?.theme ?? "")))
      .catch(() => {});
    const unsubPromise = listen<{ theme?: string }>("theme-changed", (e) => applyTheme(e.payload?.theme ?? ""));
    return () => { void unsubPromise.then((u) => u()); };
  }, []);

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

  // isDirty 必须在依赖里：漏了它的话这个回调只会创建一次，永远读到首渲染的 false，
  // 关窗按钮和 Esc 都会直接 onClose，未保存确认框永不弹出 → 编辑静默丢失。
  const guardedClose = useCallback(() => {
    if (isDirty) {
      setShowConfirmClose(true);
      return;
    }
    onClose();
  }, [isDirty, onClose]);

  const toggleFullscreen = useCallback(async () => {
    try {
      const win = getCurrentWindow();
      const next = !(await win.isFullscreen());
      await win.setFullscreen(next);
      setIsFullscreen(next);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSave();
      } else if (e.key === "Escape") {
        e.preventDefault();
        guardedClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleSave, guardedClose]);

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
    <div className={styles.overlay} data-theme-mode={isDarkTheme ? "dark" : "light"}>
      <SkinScene />
      <div className={styles.toolbar} data-tauri-drag-region="deep">
        <div className={styles.toolbarLeft}>
          <div className={styles.fileIcon}>📊</div>
          <span className={`${styles.fileName} ${editorStyles.docTitle}`} title={docTitle}>{docTitle}</span>
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
          {isDirty && <div className={styles.unsavedDot} />}
          {ai.status === "on" && (
            <button className={editorStyles.aiBtn} style={{ marginLeft: 10 }} onClick={() => setAiOpen((v) => !v)}>
              <Sparkles size={14} /> AI 生成
            </button>
          )}
          <button className={editorStyles.ghostBtn} onClick={copyMermaid} title="复制 Mermaid 源码">
            <FileCode size={14} /> Mermaid
          </button>
          <div className={editorStyles.exportWrap}>
            <button className={editorStyles.ghostBtn} onClick={() => exportAs("png")}>
              <Download size={14} /> 导出
            </button>
            <div className={editorStyles.exportMenu}>
              <button onClick={() => exportAs("png")}>🖼 PNG 图片</button>
              <button onClick={() => exportAs("svg")}>📐 SVG 矢量</button>
              <button onClick={() => exportAs("mermaid")}>🧩 Mermaid 源码</button>
              <button onClick={() => exportAs("panda")}>💾 PastePanda 文件</button>
            </div>
          </div>
        </div>
        <div className={styles.toolbarRight}>
          <button className={`${styles.tbBtn} ${styles.tbBtnPrimary}`} onClick={handleSave} title="保存 Ctrl+S">
            <Save size={14} /><span>保存</span>
          </button>
          <div className={styles.tbSep} />
          <button className={styles.tbBtnIcon} onClick={toggleFullscreen} title={isFullscreen ? "缩回窗口" : "放大到真全屏"}>
            {isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button className={`${styles.tbBtnIcon} ${styles.tbBtnClose}`} onClick={guardedClose} title="关闭 Esc">
            <X size={15} />
          </button>
        </div>
      </div>

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

      <ConfirmDialog
        open={showConfirmClose}
        title="有未保存的修改"
        message="关闭后本次编辑将丢弃，确定关闭吗？"
        confirmText="不保存关闭"
        cancelText="继续编辑"
        variant="danger"
        onConfirm={() => { setShowConfirmClose(false); onClose(); }}
        onCancel={() => setShowConfirmClose(false)}
      />
    </div>
  );
}
