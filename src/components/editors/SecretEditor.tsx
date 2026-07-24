import { useState, useMemo, useEffect } from "react";
import { Eye, EyeOff, Pencil, ShieldCheck } from "lucide-react";
import { useEditorCore } from "./useEditorCore";
import { CodeTextArea } from "./CodeTextArea";
import { MetaBar, TransformToolbar, OriginalDiff, ToolBtn } from "./editorBits";
import { detectSecretKind, maskSecretText } from "@/lib/secret";
import type { EditorProps } from "@/lib/editorRegistry";

/** 明文显示后自动回脱敏的秒数 */
const REVEAL_SECONDS = 15;

/**
 * 密钥专用编辑器（P4）：打开即脱敏（••••），防肩窥。
 * - 查看模式：遮罩显示，点「显示」临时明文 + 15s 倒计时自动回脱敏；
 * - 编辑模式：明文编辑区（有意编辑时可见）+ 标准变换工具栏；
 * - 复制/粘贴始终操作真实值（useEditorCore 的 textRef）；
 * - 类型徽章：JWT / AWS / GitHub / Base64（与 Rust 分类器规则同源）。
 */
export function SecretEditor({ item, registerActions }: EditorProps) {
  const { text, pushHistory, undo, redo, originalText, isModified } = useEditorCore(item, registerActions);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [revealed, setRevealed] = useState(false);
  const [countdown, setCountdown] = useState(REVEAL_SECONDS);
  const [showOriginal, setShowOriginal] = useState(false);
  const kind = useMemo(() => detectSecretKind(text), [text]);

  // 明文显示期间每秒倒数；回脱敏时重置
  useEffect(() => {
    if (!revealed) return;
    setCountdown(REVEAL_SECONDS);
    const timer = window.setInterval(() => setCountdown((c) => c - 1), 1000);
    return () => window.clearInterval(timer);
  }, [revealed]);

  useEffect(() => {
    if (revealed && countdown <= 0) setRevealed(false);
  }, [countdown, revealed]);

  // 切到编辑模式时聚焦编辑区
  useEffect(() => {
    if (mode !== "edit") return;
    const t = window.setTimeout(() => document.getElementById("edit-code-textarea")?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [mode]);

  const transform = (fn: (s: string) => string) => pushHistory(fn(text));

  return (
    <>
      <MetaBar
        lineCount={text.split("\n").length}
        charCount={text.length}
        isModified={isModified}
        badge="🔐 密钥"
        status={<span className="secret-kind-badge">🔑 {kind}</span>}
      />

      {mode === "view" ? (
        <>
          {/* 脱敏/明文显示区 */}
          <div className={`secret-display${revealed ? " secret-revealed" : ""}`}>
            {revealed ? (
              <span className="secret-plain">{text}</span>
            ) : (
              <span className="secret-masked">{maskSecretText(text)}</span>
            )}
            <button className="secret-eye" onClick={() => setRevealed(!revealed)}>
              {revealed ? (
                <>
                  <EyeOff size={13} /> 隐藏
                </>
              ) : (
                <>
                  <Eye size={13} /> 显示
                </>
              )}
            </button>
            {revealed && <span className="secret-countdown">⏱ {countdown}s 后自动隐藏</span>}
          </div>

          <div className="secret-note">
            <ShieldCheck size={13} />
            默认脱敏显示 · 复制始终取真实值 · 关闭弹窗立即恢复脱敏
          </div>

          <div className="edit-toolbar">
            <ToolBtn accent icon={<Pencil size={13} />} label="编辑" onClick={() => setMode("edit")} />
          </div>
        </>
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
                  icon={<EyeOff size={13} />}
                  label="返回脱敏视图"
                  onClick={() => {
                    setRevealed(false);
                    setMode("view");
                  }}
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
