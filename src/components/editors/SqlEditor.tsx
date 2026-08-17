/**
 * SQL 专用编辑器（编辑器增量 P1 · A1）：
 * CodeTextArea 高亮（hljs 自动检测 sql）+ 实时语法校验（后端 SQLite :memory: EXPLAIN 只读）
 * + 错误行标红 + 校验结果条。骨架完全复刻 JsonEditor（useEditorCore + editorBits）。
 */
import { useState, useMemo, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ShieldCheck, Package } from "lucide-react";
import { useEditorCore } from "./useEditorCore";
import { CodeTextArea } from "./CodeTextArea";
import { MetaBar, TransformToolbar, ToolBtn, FullscreenLaunchButton, OriginalDiff } from "./editorBits";
import { useToast } from "@/components/Toast";
import type { EditorProps } from "@/lib/editorRegistry";

/** sql_validate 后端返回（与 Rust 端 SqlValidateResult 对应） */
interface SqlValidation {
  ok: boolean;
  line?: number | null;
  message?: string | null;
  stmt_count?: number;
}

/** 校验状态：null = 校验中 */
type CheckState = SqlValidation | null | "pending";

/**
 * SQL 语法校验（防抖 400ms）：
 * 空内容直接通过；调用后端只读校验（:memory: + EXPLAIN），写语句会被后端拦截。
 */
function useSqlCheck(text: string): CheckState {
  const [state, setState] = useState<CheckState>(null);
  useEffect(() => {
    if (!text.trim()) {
      setState({ ok: true, stmt_count: 0 });
      return;
    }
    setState("pending");
    let cancelled = false;
    const t = setTimeout(() => {
      invoke<SqlValidation>("sql_validate", { sql: text })
        .then((res) => { if (!cancelled) setState(res); })
        .catch(() => { if (!cancelled) setState(null); }); // 命令失败静默（不阻塞编辑）
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [text]);
  return state;
}

export function SqlEditor({ item, registerActions }: EditorProps) {
  const { text, pushHistory, undo, redo, originalText, isModified } = useEditorCore(item, registerActions);
  const [showOriginal, setShowOriginal] = useState(false);
  const { toast } = useToast();
  const check = useSqlCheck(text);

  const charCount = text.length;
  const lineCount = text.split("\n").length;

  /** 校验结果行（红色/绿色结果条） */
  const checkBar = useMemo(() => {
    if (check === null || check === "pending") {
      return check === "pending"
        ? <div className="sql-check-bar pending">⟳ 校验中…</div>
        : null;
    }
    if (check.ok) {
      const n = check.stmt_count ?? 0;
      return (
        <div className="sql-check-bar ok">
          <ShieldCheck size={13} />
          ✓ 语法校验通过{n > 0 ? `（${n} 条语句）` : ""} · 仅只读校验，不保证可执行
        </div>
      );
    }
    return (
      <div className="sql-check-bar err">
        ✗ {check.message ?? "语法错误"}
        {check.line ? `（第 ${check.line} 行附近）` : ""}
      </div>
    );
  }, [check]);

  /** MetaBar 状态徽章（复用全局 json-valid-badge / json-invalid-badge） */
  const statusBadge = useMemo(() => {
    if (check === "pending") return <span className="json-valid-badge">⟳ 校验中</span>;
    if (check && check.ok) return <span className="json-valid-badge">✓ 语法通过</span>;
    if (check && !check.ok) return <span className="json-invalid-badge">✕ 第 {check.line ?? "?"} 行附近错误</span>;
    return null;
  }, [check]);

  // 只有一条语句时提供「格式化」：简单地把多余空白压缩（保守，不做语义改写）
  const handleCompact = () => {
    if (typeof check !== "string" && check && !check.ok) {
      toast("SQL 有语法错误，无法压缩", "error");
      return;
    }
    const compact = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join("\n");
    if (compact !== text) pushHistory(compact);
  };

  return (
    <>
      <MetaBar
        lineCount={lineCount}
        charCount={charCount}
        isModified={isModified}
        status={statusBadge}
        badge="🗄 SQL"
        extra={<FullscreenLaunchButton itemId={item.id} text={text} contentType="sql" />}
      />

      {checkBar}

      <CodeTextArea
        value={text}
        onChange={pushHistory}
        textareaId="edit-code-textarea"
        errorLine={typeof check !== "string" && check && !check.ok ? check.line ?? undefined : undefined}
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
            <ToolBtn accent icon={<Package size={13} />} label="压缩空白" onClick={handleCompact} />
            <div className="tool-separator"></div>
          </>
        }
      />

      {showOriginal && isModified && <OriginalDiff originalText={originalText} />}
    </>
  );
}
