import { useState, useEffect } from "react";
import Editor from "react-simple-code-editor";
import { highlightCode, highlightCodeForced } from "@/lib/utils";

// 高亮函数：接受代码字符串，返回 React 节点
async function highlightFn(code: string): Promise<React.ReactNode> {
  if (!code) return "";
  if (code.length > 5000) return code;
  try {
    const r = await highlightCode(code);
    // 如果无高亮结果（纯文本），返回原始文本，确保可见
    if (!r.html) return code;
    // 包装 shiki class 让 CSS 变量切换生效
    return <span className="shiki" dangerouslySetInnerHTML={{ __html: r.html }} />;
  } catch {
    return code;
  }
}

// 同步高亮包装器（用缓存避免闪烁）
// forceLang 非空时强制用该语言高亮（编辑器内手动锁定语言）
export function useHighlight(code: string, forceLang?: string) {
  const [highlighted, setHighlighted] = useState<React.ReactNode>(code);
  useEffect(() => {
    let cancelled = false;
    const p = forceLang
      ? highlightCodeForced(code, forceLang).then((r) =>
          r.html ? <span className="shiki" dangerouslySetInnerHTML={{ __html: r.html }} /> : code
        )
      : highlightFn(code);
    p.then((r) => {
      if (!cancelled) setHighlighted(r);
    });
    return () => { cancelled = true; };
  }, [code, forceLang]);
  return highlighted;
}

/**
 * 共享代码编辑区：行号 + react-simple-code-editor + shiki 语法高亮。
 * TextEditor / MarkdownEditor（编辑模式）复用，P2 的 code/json 编辑器同样基于此。
 */
export function CodeTextArea({ value, onChange, textareaId, errorLine, forceLang }: {
  value: string;
  onChange: (v: string) => void;
  /** 传给内部 textarea 的 id（外壳据此自动聚焦 edit-code-textarea） */
  textareaId?: string;
  /** 错误行号（1 起）：该行行号标红，供 JSON 校验定位 */
  errorLine?: number;
  /** 强制语法高亮语言（小写 lang key，如 "python"/"sql"）；为空则自动检测 */
  forceLang?: string;
}) {
  const highlighted = useHighlight(value, forceLang);
  return (
    <div className="edit-code-area">
      <div className="code-lines">
        {value.split("\n").map((_, i) => (
          <span key={i} className={`code-ln${errorLine === i + 1 ? " code-ln-err" : ""}`}>{i + 1}</span>
        ))}
      </div>
      <div className="edit-highlight-wrapper">
        <Editor
          value={value}
          onValueChange={onChange}
          highlight={() => highlighted}
          padding={0}
          className="edit-highlight-editor"
          textareaId={textareaId}
          style={{
            fontFamily: "'SF Mono', Consolas, monospace",
            fontSize: 13,
            lineHeight: 1.7,
          }}
        />
      </div>
    </div>
  );
}
