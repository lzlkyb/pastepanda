import { useState, useMemo } from "react";
import { Zap, Package, Copy, ChevronDown, ChevronUp, Settings2 } from "lucide-react";
import { useEditorCore } from "./useEditorCore";
import { CodeTextArea } from "./CodeTextArea";
import { MetaBar, TransformToolbar, OriginalDiff, ToolBtn, FullscreenLaunchButton } from "./editorBits";
import { useToast } from "@/components/Toast";
import { parseJsonArray, pickDefaultField, pluckField, toSqlIn } from "@/lib/jsonToolbox";
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
 * SQL IN 智能结果条（方案 C）：
 * 内容是 JSON 数组时常驻一条紧凑结果条 —— SQL 结果实时预览 + 一键复制；
 * 点"选项"展开字段（对象数组）/ 引号风格 / 包裹格式设置。逻辑全在 jsonToolbox。
 */
function SqlInBar({ text }: { text: string }) {
  const { toast } = useToast();
  const info = useMemo(() => parseJsonArray(text), [text]);
  const [field, setField] = useState<string | null>(null);
  const [quote, setQuote] = useState<"single" | "double" | "backtick">("single");
  const [wrap, setWrap] = useState<"in" | "paren" | "values">("in");
  const [showOpts, setShowOpts] = useState(false);

  // 对象数组的有效字段：用户选的优先，未选/失效时回退默认（id 类命名）
  const defaultField = info.elemType === "object" ? pickDefaultField(info.fields) : null;
  const effField = info.elemType === "object"
    ? (field && info.fields.includes(field) ? field : defaultField)
    : undefined;

  const sql = useMemo(() => {
    if (!info.ok) return null;
    const values = effField ? pluckField(info.values, effField) : info.values;
    return toSqlIn(values, { quote, wrap });
  }, [info, effField, quote, wrap]);

  if (!info.ok || !sql) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(sql);
      toast(`已复制 SQL IN（${info.count} 个值）`, "success");
    } catch {
      toast("复制失败", "error");
    }
  };

  return (
    <div className="sql-in-bar">
      <div className="sql-in-row">
        <span className="sql-in-tag">SQL IN</span>
        <span className="sql-in-preview" title={sql}>{sql}</span>
        <ToolBtn accent icon={<Copy size={13} />} label="复制" onClick={handleCopy} />
        <button type="button" className="sql-in-opts-toggle" onClick={() => setShowOpts(!showOpts)}>
          <Settings2 size={12} /> 选项 {showOpts ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
      </div>

      {showOpts && (
        <div className="sql-in-opts">
          {info.elemType === "object" && (
            <div className="url-row">
              <span className="url-label">字段</span>
              {info.fields.map((f) => (
                <button key={f} type="button" className={`sql-in-chip${effField === f ? " on" : ""}`} onClick={() => setField(f)}>{f}</button>
              ))}
            </div>
          )}
          <div className="url-row">
            <span className="url-label">引号</span>
            {(["single", "double", "backtick"] as const).map((q) => (
              <button key={q} type="button" className={`sql-in-chip${quote === q ? " on" : ""}`} onClick={() => setQuote(q)}>
                {q === "single" ? "' 单引号" : q === "double" ? '" 双引号' : "` 反引号"}
              </button>
            ))}
            <span className="url-label" style={{ width: "auto", marginLeft: 4 }}>包裹</span>
            {(["in", "paren", "values"] as const).map((w) => (
              <button key={w} type="button" className={`sql-in-chip${wrap === w ? " on" : ""}`} onClick={() => setWrap(w)}>
                {w === "in" ? "IN (…)" : w === "paren" ? "仅 (…)" : "仅值"}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
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
        extra={<FullscreenLaunchButton itemId={item.id} text={text} contentType="json" />}
      />

      <SqlInBar text={text} />

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
