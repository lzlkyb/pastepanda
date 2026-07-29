import { Type, Scissors, Quote, AlignLeft, CaseSensitive, Undo2, Redo2, ChevronDown, ChevronUp, Code2, Maximize2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { stripHtml } from "@/lib/utils";
import { useToast } from "@/components/Toast";

/**
 * 编辑器共享小组件（方案 A）：
 * MetaBar 元信息条 / TransformToolbar 文本变换工具栏 / OriginalDiff 原文对比 /
 * ToolBtn 工具栏按钮 / ActionBtn footer 动作按钮。
 */

/** 元信息条：行/字符/修改状态 + 校验状态(status) + 类型徽章 + 可选附加区（如 MD 模式切换） */
export function MetaBar({ lineCount, charCount, isModified, badge, status, extra }: {
  lineCount: number;
  charCount: number;
  isModified: boolean;
  badge: React.ReactNode;
  /** 类型徽章左侧的状态插槽（如 JSON 校验徽章） */
  status?: React.ReactNode;
  extra?: React.ReactNode;
}) {
  return (
    <div className="code-meta-bar">
      <div className="code-meta-left">
        <div className="code-meta-item"><span className="code-meta-label">行</span><span className="code-meta-val">{lineCount}</span></div>
        <div className="code-meta-item"><span className="code-meta-label">字符</span><span className="code-meta-val">{charCount}</span></div>
        {isModified && <div className="code-meta-item" style={{ color: "var(--accent)" }}><span className="code-meta-label">状态</span><span className="code-meta-val">已修改</span></div>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {status}
        <div className="code-type-badge">{badge}</div>
        {extra}
      </div>
    </div>
  );
}

/**
 * 全屏编辑入口按钮（各小弹窗编辑器共用）。
 * 打开独立 OS 全屏窗口（通用外壳），按 contentType 查表选择语言模式/视图形态。
 */
export function FullscreenLaunchButton({ itemId, text, contentType, language }: {
  itemId: string;
  text: string;
  contentType: string;
  /** 语言提示（自动标签派生，如 "Rust"/"YAML"），code 类型全屏编辑器据此加载语言模式 */
  language?: string | null;
}) {
  const { toast } = useToast();
  return (
    <button
      className="md-mode-btn"
      style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 8px" }}
      onClick={() => {
        invoke("open_fullscreen_editor", { sourceId: itemId, content: text, contentType, language: language ?? null }).catch((e) => {
          console.error("[全屏编辑] open_fullscreen_editor 失败:", e);
          toast("打开全屏失败: " + String(e), "error");
        });
      }}
      title="全屏编辑"
    >
      <Maximize2 size={12} />
      全屏
    </button>
  );
}

/** 文本变换工具栏（编辑模式下显示）；prepend 渲染类型专用工具（如 JSON 格式化/压缩） */
export function TransformToolbar({ text, transform, undo, redo, isModified, showOriginal, onToggleOriginal, isHtmlContent, prepend }: {
  text: string;
  transform: (fn: (s: string) => string) => void;
  undo: () => void;
  redo: () => void;
  isModified: boolean;
  showOriginal: boolean;
  onToggleOriginal: () => void;
  isHtmlContent: boolean;
  prepend?: React.ReactNode;
}) {
  return (
    <div className="edit-toolbar">
      {prepend}
      <ToolBtn icon={<CaseSensitive size={13} />} label="大写" onClick={() => transform((s) => s.toUpperCase())} />
      <ToolBtn icon={<Type size={13} />} label="小写" onClick={() => transform((s) => s.toLowerCase())} />
      <ToolBtn icon={<Scissors size={13} />} label="去空白" onClick={() => transform((s) => s.trim())} />
      <ToolBtn icon={<AlignLeft size={13} />} label="去空行" onClick={() => transform((s) => s.split("\n").filter((l) => l.trim()).join("\n"))} />
      <ToolBtn icon={<Quote size={13} />} label="加引号" onClick={() => transform((s) => `"${s}"`)} />
      {isHtmlContent && <ToolBtn icon={<Code2 size={13} />} label="去标签" onClick={() => transform((s) => stripHtml(s))} />}
      <div className="tool-separator"></div>
      <ToolBtn icon={<Undo2 size={13} />} label="撤销" onClick={undo} />
      <ToolBtn icon={<Redo2 size={13} />} label="重做" onClick={redo} />
      {isModified && (
        <button
          onClick={onToggleOriginal}
          style={{
            marginLeft: "auto", fontSize: 11, color: "var(--accent)", background: "none",
            border: "none", cursor: "pointer", fontFamily: "inherit",
          }}>
          {showOriginal ? <><ChevronUp size={12} style={{ verticalAlign: "middle" }} /> 隐藏原文</> : <>对比原文 <ChevronDown size={12} style={{ verticalAlign: "middle" }} /></>}
        </button>
      )}
    </div>
  );
}

/** 原文对比区 */
export function OriginalDiff({ originalText }: { originalText: string }) {
  return (
    <div style={{
      padding: 10, borderRadius: 8, background: "var(--section-bg)",
      border: "1px solid var(--border-color)", fontSize: 12,
      color: "var(--text-secondary)", fontFamily: "'SF Mono', Consolas, monospace",
      maxHeight: 100, overflow: "auto", lineHeight: 1.5, whiteSpace: "pre-wrap",
      wordBreak: "break-all",
    }}>
      <span style={{ fontSize: 10, color: "var(--text-muted)" }}>原文：</span>
      {originalText}
    </div>
  );
}

export function ToolBtn({ icon, label, onClick, accent }: { icon: React.ReactNode; label: string; onClick: () => void; accent?: boolean }) {
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderRadius: 6,
      border: `1px solid ${accent ? "var(--accent)" : "var(--border-color)"}`,
      background: accent ? "var(--accent-light)" : "var(--card-bg)",
      // accent 模式下 accent 压 accent-light 浅色主题下对比度不足 4.5:1，改用加深版 --accent-strong
      color: accent ? "var(--accent-strong)" : "var(--text-secondary)",
      fontSize: 11, fontWeight: 600, cursor: "pointer",
      fontFamily: "inherit", transition: "all 0.15s",
    }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.color = "var(--accent)"; }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = accent ? "var(--accent)" : "var(--border-color)";
        e.currentTarget.style.color = accent ? "var(--accent)" : "var(--text-secondary)";
      }}>
      {icon}{label}
    </button>
  );
}

export function ActionBtn({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", borderRadius: 6,
      border: "1px solid var(--border-color)", background: "var(--card-bg)",
      color: "var(--text-secondary)", fontSize: 11, fontWeight: 600, cursor: "pointer",
      fontFamily: "inherit", transition: "all 0.15s",
    }}
      // hover 态 accent 文字压在 accent-light 底上，浅色主题下对比度不足 4.5:1，改用加深版 --accent-strong
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--accent-light)"; e.currentTarget.style.color = "var(--accent-strong)"; e.currentTarget.style.borderColor = "var(--accent)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "var(--card-bg)"; e.currentTarget.style.color = "var(--text-secondary)"; e.currentTarget.style.borderColor = "var(--border-color)"; }}>
      {icon}{label}
    </button>
  );
}
