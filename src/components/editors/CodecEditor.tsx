import { useState, useEffect } from "react";
import { X, Copy } from "lucide-react";
import { getTransform } from "@/lib/transforms";
import { MetaBar, ActionBtn } from "./editorBits";
import { useToast } from "@/components/Toast";

/**
 * 编解码工作台（Tier1 · 复用 codecTransforms.ts）：
 * 独立工具弹窗（不走 editorRegistry 的 content_type 路由，从变换枢纽入口打开）。
 * 双栏「原文 ↔ 结果」实时互转：Base64 / URL / Unicode / HTML 实体 / JWT / 时间戳，
 * 每个格式可选编码/解码方向，结果一键复制。
 */
interface CodecDir {
  id: string;
  label: string;
  transformId: string;
}
interface CodecFormat {
  label: string;
  dirs: CodecDir[];
}

const FORMATS: Record<string, CodecFormat> = {
  base64: { label: "Base64", dirs: [
    { id: "enc", label: "编码", transformId: "base64_encode" },
    { id: "dec", label: "解码", transformId: "base64_decode" },
  ]},
  url: { label: "URL", dirs: [
    { id: "enc", label: "编码", transformId: "url_encode" },
    { id: "dec", label: "解码", transformId: "url_decode" },
  ]},
  unicode: { label: "Unicode", dirs: [
    { id: "enc", label: "编码", transformId: "unicode_encode" },
    { id: "dec", label: "解码", transformId: "unicode_decode" },
  ]},
  html: { label: "HTML 实体", dirs: [
    { id: "enc", label: "编码", transformId: "html_encode" },
    { id: "dec", label: "解码", transformId: "html_decode" },
  ]},
  jwt: { label: "JWT", dirs: [
    { id: "dec", label: "解析", transformId: "jwt_decode" },
  ]},
  timestamp: { label: "时间戳", dirs: [
    { id: "d2t", label: "日期→时间戳", transformId: "date_to_timestamp" },
    { id: "t2d", label: "时间戳→日期", transformId: "timestamp_to_date" },
  ]},
};

interface CodecResult {
  ok: boolean;
  output?: string;
  message?: string;
}

export function CodecEditor({ initialText, onClose }: { initialText: string; onClose: () => void }) {
  const [format, setFormat] = useState<string>("base64");
  const [dirId, setDirId] = useState<string>(FORMATS.base64.dirs[0].id);
  const [source, setSource] = useState(initialText);
  const [result, setResult] = useState<CodecResult | null>(null);
  const { toast } = useToast();

  const dirs = FORMATS[format].dirs;
  const currentDir = dirs.find((d) => d.id === dirId) ?? dirs[0];

  // 切换格式时若当前方向不存在（如 JWT 只有一个方向），回退到第一个
  useEffect(() => {
    if (!dirs.some((d) => d.id === dirId)) setDirId(dirs[0].id);
  }, [format, dirs, dirId]);

  // 实时转换（codecTransforms 均为纯前端同步逻辑；统一按 Promise 处理）
  useEffect(() => {
    const t = getTransform(currentDir.transformId);
    if (!t) { setResult({ ok: false, message: "变换未注册" }); return; }
    let cancelled = false;
    Promise.resolve(t.run(source))
      .then((r) => { if (!cancelled) setResult(r); })
      .catch((e) => { if (!cancelled) setResult({ ok: false, message: String(e) }); });
    return () => { cancelled = true; };
  }, [source, currentDir.transformId]);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const statusBadge = result?.ok
    ? <span className="json-valid-badge">✓ {format === "jwt" ? "JWT 已解析" : "有效"}</span>
    : result ? <span className="json-invalid-badge">✕ 无效</span> : null;

  const copyResult = async () => {
    if (!result?.ok || !result.output) return;
    try {
      await navigator.clipboard.writeText(result.output);
      toast("已复制结果", "success");
    } catch {
      toast("复制失败", "error");
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog-box dialog-solid w460"
        onClick={(e) => e.stopPropagation()}
        style={{ maxHeight: "82vh" }}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">🔐 编解码工作台</h2>
          <button className="dialog-close" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="dialog-body" style={{ gap: 12 }}>
          <MetaBar
            lineCount={source.split("\n").length}
            charCount={source.length}
            isModified={source !== initialText}
            badge="🔐 编解码"
            status={statusBadge}
          />

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {Object.entries(FORMATS).map(([key, f]) => (
              <button
                key={key}
                onClick={() => setFormat(key)}
                style={{
                  fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 6,
                  border: `1px solid ${format === key ? "var(--accent)" : "var(--border-color)"}`,
                  background: format === key ? "var(--accent-light)" : "var(--card-bg)",
                  color: format === key ? "var(--accent-strong)" : "var(--text-secondary)",
                  cursor: "pointer", fontFamily: "inherit",
                }}
              >
                {f.label}
              </button>
            ))}
          </div>

          {dirs.length > 1 && (
            <div style={{ display: "inline-flex", border: "1px solid var(--border-color)", borderRadius: 6, overflow: "hidden", alignSelf: "flex-start" }}>
              {dirs.map((d) => (
                <button
                  key={d.id}
                  onClick={() => setDirId(d.id)}
                  style={{
                    border: "none",
                    background: dirId === d.id ? "var(--accent)" : "var(--card-bg)",
                    color: dirId === d.id ? "#fff" : "var(--text-secondary)",
                    padding: "4px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                  }}
                >
                  {d.label}
                </button>
              ))}
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>原文</div>
              <textarea
                value={source}
                onChange={(e) => setSource(e.target.value)}
                style={{
                  width: "100%", minHeight: 160, margin: 0, padding: "10px 12px", borderRadius: 10,
                  border: "1px solid var(--border-color)", background: "var(--card-bg)",
                  fontFamily: "'SF Mono', Consolas, monospace", fontSize: 13, lineHeight: 1.6,
                  color: "var(--text-primary)", resize: "vertical", whiteSpace: "pre-wrap", wordBreak: "break-all",
                }}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ fontSize: 11, color: "var(--text-muted)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>结果</span>
                <button
                  onClick={copyResult}
                  disabled={!result?.ok}
                  style={{
                    fontSize: 11, fontWeight: 600,
                    color: result?.ok ? "var(--accent-strong)" : "var(--text-muted)",
                    background: result?.ok ? "var(--accent-light)" : "transparent",
                    border: `1px solid ${result?.ok ? "var(--accent)" : "var(--border-color)"}`,
                    borderRadius: 5, padding: "2px 8px", cursor: result?.ok ? "pointer" : "default", fontFamily: "inherit",
                  }}
                >
                  复制结果
                </button>
              </div>
              <pre style={{
                flex: 1, margin: 0, padding: "10px 12px", borderRadius: 10,
                border: "1px solid var(--border-color)", background: "var(--card-bg)",
                minHeight: 160, maxHeight: 220, overflow: "auto",
                fontFamily: "'SF Mono', Consolas, monospace", fontSize: 13, lineHeight: 1.6,
                color: result?.ok ? "var(--text-secondary)" : "var(--danger)",
                whiteSpace: "pre-wrap", wordBreak: "break-all",
              }}>
                {result?.ok ? result.output : (result?.message ?? "等待输入…")}
              </pre>
            </div>
          </div>
        </div>

        <div className="dialog-footer">
          <span>实时转换 · Esc 关闭</span>
          <div className="right">
            <ActionBtn icon={<Copy size={13} />} label="复制结果" onClick={copyResult} />
            <ActionBtn icon={<X size={13} />} label="关闭" onClick={onClose} />
          </div>
        </div>
      </div>
    </div>
  );
}
