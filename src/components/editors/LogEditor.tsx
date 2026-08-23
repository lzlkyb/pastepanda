import { useState, useMemo, type ReactNode } from "react";
import { useEditorCore } from "./useEditorCore";
import { MetaBar, TransformToolbar, FullscreenLaunchButton, OriginalDiff } from "./editorBits";
import { CodeTextArea } from "./CodeTextArea";
import { parseLog, filterEntries, LEVEL_ORDER, type LogLevel } from "@/lib/logParser";
import type { EditorProps } from "@/lib/editorRegistry";

/**
 * 日志专用编辑器（Tier1 · 复用 logParser.ts）：
 * 「分析」模式 = 级别芯片过滤 + 关键字高亮 + 错误/警告行着色 + 续行自动归属；
 * 「编辑原文」模式 = 与 TextEditor 相同的高亮编辑区 + 变换工具栏（保持可保存）。
 * 日志样式全部内联（着色逻辑动态），仅复用 editorBits 的 MetaBar / Toolbar / 全屏入口。
 */
const LEVEL_COLOR: Record<LogLevel, string> = {
  TRACE: "#64748B", DEBUG: "#0284C7", INFO: "#11813A",
  WARN: "#C54A0A", ERROR: "#D82525", FATAL: "#7F1D1D",
};
const LEVEL_BG: Partial<Record<LogLevel, string>> = {
  WARN: "var(--orange-bg)", ERROR: "var(--red-bg)", FATAL: "#FBE5E5",
};

/**
 * 分析模式一次最多渲染多少条。
 *
 * 每条日志至少一个带内联样式的 div（有堆栈续行就更多），而剪贴板里粘进来一份
 * 几万行的日志完全正常 —— 全量渲染就是几万个合成节点，配上「关键字每变一次
 * highlight() 就把每行重建一遍 ReactNode」，输入框会直接卡住（规则 #8）。
 * 超出部分不静默丢弃：底部固定显示"仅渲染前 N 条"，让用户知道要靠级别/关键字收窄。
 */
const MAX_RENDER_ROWS = 2000;

/** 关键字命中处包裹 <mark>（大小写不敏感，支持重复命中） */
function highlight(text: string, kw: string): ReactNode {
  const k = kw.trim();
  if (!k) return text;
  const lower = text.toLowerCase();
  const kl = k.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;
  while (i < text.length) {
    const idx = lower.indexOf(kl, i);
    if (idx === -1) { out.push(text.slice(i)); break; }
    if (idx > i) out.push(text.slice(i, idx));
    out.push(
      <mark key={n++} style={{ background: "#FEF08A", color: "#000", borderRadius: 2 }}>
        {text.slice(idx, idx + k.length)}
      </mark>,
    );
    i = idx + k.length;
  }
  return out;
}

export function LogEditor({ item, registerActions }: EditorProps) {
  const { text, pushHistory, undo, redo, originalText, isModified } =
    useEditorCore(item, registerActions);
  const [mode, setMode] = useState<"analyze" | "edit">("analyze");
  const [showOriginal, setShowOriginal] = useState(false);
  const [selected, setSelected] = useState<Set<LogLevel>>(new Set(LEVEL_ORDER));
  const [keyword, setKeyword] = useState("");

  const parsed = useMemo(() => parseLog(text), [text]);
  const activeLevels = selected.size === LEVEL_ORDER.length ? null : selected;
  const filtered = useMemo(
    () => filterEntries(parsed.entries, activeLevels, keyword),
    [parsed, activeLevels, keyword],
  );

  const charCount = text.length;
  const lineCount = text.split("\n").length;

  const toggleLevel = (lv: LogLevel) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(lv)) next.delete(lv);
      else next.add(lv);
      return next;
    });
  };

  const renderRow = (e: ReturnType<typeof parseLog>["entries"][number], idx: number) => {
    const color = e.level ? LEVEL_COLOR[e.level] : "var(--text-muted)";
    const bg = e.level ? LEVEL_BG[e.level] : undefined;
    return (
      <div key={idx}>
        <div style={{
          display: "flex", gap: 8, padding: "1px 12px", whiteSpace: "pre-wrap",
          wordBreak: "break-all", background: bg,
          fontFamily: "'SF Mono', Consolas, monospace", fontSize: 12.5, lineHeight: 1.7,
        }}>
          {e.time && <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>{e.time}</span>}
          <span style={{ fontWeight: 700, flexShrink: 0, width: 44, color }}>{e.level ?? ""}</span>
          <span style={{ color: "var(--text-primary)" }}>{highlight(e.msg, keyword)}</span>
        </div>
        {e.cont.map((c, ci) => (
          <div key={ci} style={{
            display: "flex", gap: 8, padding: "1px 12px 1px 56px", whiteSpace: "pre-wrap",
            wordBreak: "break-all", background: bg,
            fontFamily: "'SF Mono', Consolas, monospace", fontSize: 12.5, lineHeight: 1.7,
            color: "var(--text-muted)",
          }}>
            <span>{highlight(c, keyword)}</span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <>
      <MetaBar
        lineCount={lineCount}
        charCount={charCount}
        isModified={isModified}
        badge="📜 日志"
        extra={
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div className="md-mode-toggle">
              <button className={`md-mode-btn${mode === "analyze" ? " active" : ""}`} onClick={() => setMode("analyze")}>分析</button>
              <button className={`md-mode-btn${mode === "edit" ? " active" : ""}`} onClick={() => setMode("edit")}>编辑原文</button>
            </div>
            <FullscreenLaunchButton itemId={item.id} text={text} contentType="log" />
          </div>
        }
      />

      {mode === "analyze" ? (
        <>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {LEVEL_ORDER.map((lv) => {
              const on = selected.has(lv);
              return (
                <button
                  key={lv}
                  onClick={() => toggleLevel(lv)}
                  style={{
                    fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 999,
                    border: `1px solid ${on ? LEVEL_COLOR[lv] : "var(--border-color)"}`,
                    background: on ? LEVEL_COLOR[lv] : "var(--card-bg)",
                    color: on ? "#fff" : "var(--text-muted)", cursor: "pointer",
                    display: "inline-flex", gap: 4, alignItems: "center", fontFamily: "inherit",
                  }}
                >
                  {lv}
                  <span style={{ fontWeight: 600, opacity: 0.8 }}>{parsed.counts[lv] ?? 0}</span>
                </button>
              );
            })}
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="关键字过滤（实时匹配时间/消息/堆栈）"
              style={{
                flex: 1, minWidth: 120, padding: "5px 10px", borderRadius: 8,
                border: "1px solid var(--border-color)", background: "var(--card-bg)",
                fontSize: 12, fontFamily: "inherit", color: "var(--text-primary)",
              }}
            />
          </div>

          <div style={{
            flex: 1, border: "1px solid var(--border-color)", borderRadius: 10,
            background: "var(--card-bg)", overflow: "auto", maxHeight: 320, padding: "8px 0",
          }}>
            {filtered.length === 0 ? (
              <div style={{ padding: "24px 12px", textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>
                没有匹配的行（试试放宽级别或清空关键字）
              </div>
            ) : (
              filtered.slice(0, MAX_RENDER_ROWS).map((e, i) => renderRow(e, i))
            )}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
            共 {parsed.entries.length} 条 · 过滤后 {filtered.length} 条 · 续行自动归属上一条
            {filtered.length > MAX_RENDER_ROWS && (
              <span style={{ color: "var(--orange-solid, #C54A0A)", fontWeight: 700 }}>
                {" "}· 仅渲染前 {MAX_RENDER_ROWS} 条，请用级别或关键字收窄
              </span>
            )}
          </div>
        </>
      ) : (
        <>
          <CodeTextArea value={text} onChange={pushHistory} textareaId="edit-code-textarea" />
          <TransformToolbar
            text={text}
            transform={(fn) => pushHistory(fn(text))}
            undo={undo}
            redo={redo}
            isModified={isModified}
            showOriginal={showOriginal}
            onToggleOriginal={() => setShowOriginal(!showOriginal)}
            isHtmlContent={false}
          />
          {showOriginal && isModified && <OriginalDiff originalText={originalText} />}
        </>
      )}
    </>
  );
}
