import { useState, useMemo, useEffect } from "react";
import { Table, Braces, ArrowRightLeft } from "lucide-react";
import { useEditorCore } from "./useEditorCore";
import { CodeTextArea } from "./CodeTextArea";
import { MetaBar, TransformToolbar, OriginalDiff, ToolBtn, FullscreenLaunchButton } from "./editorBits";
import { parseCsv, csvToMarkdown, csvToJson, convertDelimiter } from "@/lib/csv";
import { useToast } from "@/components/Toast";
import type { EditorProps } from "@/lib/editorRegistry";

/**
 * 表格专用编辑器（P4）：默认表格模式（首行表头 + 斑马纹 + 横向滚动），
 * 可切换编辑模式（CodeTextArea + 分隔符互转 + 标准变换工具栏）。
 * 解析器与 Rust 分类器规则对齐（见 src/lib/csv.ts）；
 * 结构不一致时回退提示，不阻塞编辑。
 */
export function CsvEditor({ item, registerActions }: EditorProps) {
  const { text, pushHistory, undo, redo, originalText, isModified } = useEditorCore(item, registerActions);
  const [mode, setMode] = useState<"table" | "edit">("table");
  const [showOriginal, setShowOriginal] = useState(false);
  const { toast } = useToast();
  const data = useMemo(() => parseCsv(text), [text]);

  // 切到编辑模式时聚焦编辑区（外壳的自动聚焦只在弹窗打开时执行一次）
  useEffect(() => {
    if (mode !== "edit") return;
    const t = window.setTimeout(() => document.getElementById("edit-code-textarea")?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [mode]);

  const copyAs = async (kind: "markdown" | "json") => {
    if (!data) {
      toast("表格结构不一致，无法转换", "error");
      return;
    }
    try {
      await navigator.clipboard.writeText(kind === "markdown" ? csvToMarkdown(data) : csvToJson(data));
      toast(kind === "markdown" ? "已复制为 Markdown 表格" : "已复制为 JSON", "success");
    } catch {
      toast("复制失败", "error");
    }
  };

  const transform = (fn: (s: string) => string) => pushHistory(fn(text));
  const lineCount = data ? data.rowCount : text.split("\n").length;

  return (
    <>
      <MetaBar
        lineCount={lineCount}
        charCount={text.length}
        isModified={isModified}
        badge="📊 表格"
        status={
          data ? (
            <span className="json-valid-badge">
              ✓ {data.columnCount} 列 · {data.delimiter === "\t" ? "制表符" : "逗号"}分隔
            </span>
          ) : (
            <span className="json-invalid-badge">✕ 列数不一致</span>
          )
        }
        extra={
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div className="md-mode-toggle">
              <button className={`md-mode-btn${mode === "table" ? " active" : ""}`} onClick={() => setMode("table")}>
                表格
              </button>
              <button className={`md-mode-btn${mode === "edit" ? " active" : ""}`} onClick={() => setMode("edit")}>
                编辑
              </button>
            </div>
            <FullscreenLaunchButton itemId={item.id} text={text} contentType="csv" />
          </div>
        }
      />

      {mode === "table" ? (
        data ? (
          <>
            <div className="csv-table-wrap">
              <table className="csv-table">
                <thead>
                  <tr>
                    <th className="csv-col-idx"></th>
                    {data.headers.map((h, i) => (
                      <th key={i}>{h || `列 ${i + 1}`}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r, ri) => (
                    <tr key={ri}>
                      <td className="csv-col-idx">{ri + 2}</td>
                      {r.map((c, ci) => (
                        <td key={ci}>{c}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="edit-toolbar">
              <ToolBtn accent icon={<Table size={13} />} label="复制为 Markdown" onClick={() => copyAs("markdown")} />
              <ToolBtn accent icon={<Braces size={13} />} label="复制为 JSON" onClick={() => copyAs("json")} />
            </div>
          </>
        ) : (
          <div className="csv-invalid-hint">无法解析为表格：需至少 2 行且各行列数一致（≥2 列）。可切换到编辑模式查看原文。</div>
        )
      ) : (
        <>
          <CodeTextArea value={text} onChange={pushHistory} textareaId="edit-code-textarea" />

          <TransformToolbar
            text={text}
            transform={transform}
            undo={undo}
            redo={redo}
            isModified={isModified}
            showOriginal={showOriginal}
            onToggleOriginal={() => setShowOriginal(!showOriginal)}
            isHtmlContent={false}
            prepend={
              <>
                <ToolBtn
                  accent
                  icon={<ArrowRightLeft size={13} />}
                  label="转制表符"
                  onClick={() => transform((s) => convertDelimiter(s, "\t"))}
                />
                <ToolBtn
                  accent
                  icon={<ArrowRightLeft size={13} />}
                  label="转逗号"
                  onClick={() => transform((s) => convertDelimiter(s, ","))}
                />
                <div className="tool-separator" />
              </>
            }
          />

          {showOriginal && isModified && <OriginalDiff originalText={originalText} />}
        </>
      )}
    </>
  );
}
