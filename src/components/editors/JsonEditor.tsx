import { useState, useMemo } from "react";
import { Zap, Package } from "lucide-react";
import { useEditorCore } from "./useEditorCore";
import { CodeTextArea } from "./CodeTextArea";
import { MetaBar, TransformToolbar, OriginalDiff, ToolBtn } from "./editorBits";
import { useToast } from "@/components/Toast";
import type { EditorProps } from "@/lib/editorRegistry";

interface JsonValidation {
  valid: boolean;
  /** 错误行号（1 起，解析失败时尽力提取） */
  line?: number;
  message?: string;
  value?: unknown;
}

/** 校验 JSON 并从错误消息提取行号（WebView2: "... at position 42 (line 4 column 5)"） */
function validateJson(text: string): JsonValidation {
  try {
    return { valid: true, value: JSON.parse(text) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const lineMatch = msg.match(/\(line (\d+)/);
    let line: number | undefined;
    if (lineMatch) {
      line = Number(lineMatch[1]);
    } else {
      // 旧格式兜底："... at position 42" → 按换行数推算行号
      const posMatch = msg.match(/position (\d+)/);
      if (posMatch) line = text.slice(0, Number(posMatch[1])).split("\n").length;
    }
    return { valid: false, line, message: msg };
  }
}

/**
 * JSON 专用编辑器（P2）：
 * 实时校验徽章（✓ 有效 / ✕ 第 N 行错误）+ 错误行号标红 + 格式化/压缩工具。
 */
export function JsonEditor({ item, registerActions }: EditorProps) {
  const { text, pushHistory, undo, redo, originalText, isModified } = useEditorCore(item, registerActions);
  const [showOriginal, setShowOriginal] = useState(false);
  const { toast } = useToast();

  const validation = useMemo(() => validateJson(text), [text]);

  const handleFormat = () => {
    const r = validateJson(text);
    if (!r.valid) {
      toast(`JSON 无效${r.line ? `（第 ${r.line} 行）` : ""}，无法格式化`, "error");
      return;
    }
    pushHistory(JSON.stringify(r.value, null, 2));
  };

  const handleCompress = () => {
    const r = validateJson(text);
    if (!r.valid) {
      toast(`JSON 无效${r.line ? `（第 ${r.line} 行）` : ""}，无法压缩`, "error");
      return;
    }
    pushHistory(JSON.stringify(r.value));
  };

  const charCount = text.length;
  const lineCount = text.split("\n").length;

  return (
    <>
      <MetaBar
        lineCount={lineCount}
        charCount={charCount}
        isModified={isModified}
        status={
          validation.valid
            ? <span className="json-valid-badge">✓ 有效</span>
            : <span className="json-invalid-badge">✕ 第 {validation.line ?? "?"} 行错误</span>
        }
        badge="🔧 JSON"
      />

      <CodeTextArea
        value={text}
        onChange={pushHistory}
        textareaId="edit-code-textarea"
        errorLine={validation.valid ? undefined : validation.line}
      />

      <TransformToolbar
        text={text}
        transform={(fn) => pushHistory(fn(text))}
        undo={undo}
        redo={redo}
        isModified={isModified}
        showOriginal={showOriginal}
        onToggleOriginal={() => setShowOriginal(!showOriginal)}
        isHtmlContent={false}
        prepend={
          <>
            <ToolBtn accent icon={<Zap size={13} />} label="格式化" onClick={handleFormat} />
            <ToolBtn accent icon={<Package size={13} />} label="压缩" onClick={handleCompress} />
            <div className="tool-separator"></div>
          </>
        }
      />

      {showOriginal && isModified && <OriginalDiff originalText={originalText} />}
    </>
  );
}
