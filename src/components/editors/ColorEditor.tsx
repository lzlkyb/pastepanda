import { useMemo } from "react";
import { useEditorCore } from "./useEditorCore";
import { MetaBar } from "./editorBits";
import { detectColor, toHex, toRgb, toHsl } from "@/lib/color";
import { useToast } from "@/components/Toast";
import type { EditorProps } from "@/lib/editorRegistry";

/**
 * 颜色专用编辑器（P4）：大色块 + 可编辑值 + HEX/RGB/HSL 三格式互转复制。
 * 全部复用 src/lib/color.ts 的 detectColor/toHex/toRgb/toHsl（与卡片色块同源）。
 * 色块底层为棋盘格，alpha <1 时透出；输入非法时色块隐藏并提示。
 */
export function ColorEditor({ item, registerActions }: EditorProps) {
  const { text, setText, isModified } = useEditorCore(item, registerActions);
  const { toast } = useToast();
  const parsed = useMemo(() => detectColor(text), [text]);

  const formats = useMemo(
    () =>
      parsed
        ? [
            { tag: "HEX", value: toHex(parsed) },
            { tag: "RGB", value: toRgb(parsed) },
            { tag: "HSL", value: toHsl(parsed) },
          ]
        : [],
    [parsed]
  );

  const copyFormat = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast("已复制 " + value, "success");
    } catch {
      toast("复制失败", "error");
    }
  };

  return (
    <>
      <MetaBar
        lineCount={text.split("\n").length}
        charCount={text.length}
        isModified={isModified}
        badge="🎨 颜色"
        status={
          parsed ? (
            <span className="json-valid-badge">✓ 有效</span>
          ) : (
            <span className="json-invalid-badge">✕ 非颜色值</span>
          )
        }
      />

      {/* 大色块（棋盘格底：alpha 色可透出） */}
      <div className="color-swatch-wrap">
        {parsed && <div className="color-swatch" style={{ background: toRgb(parsed) }} />}
        <span className="color-swatch-label">{parsed ? toHex(parsed) : "—"}</span>
      </div>

      {/* 可编辑值：改动实时刷新色块与三格式（id 供外壳自动聚焦） */}
      <input
        id="edit-code-textarea"
        className="color-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        placeholder="#RRGGBB / rgb(r, g, b) / hsl(h, s%, l%)"
      />

      {/* 三格式转换行，各带复制 */}
      <div className="color-format-rows">
        {formats.map((f) => (
          <div key={f.tag} className="color-format-row">
            <span className="color-format-tag">{f.tag}</span>
            <span className="color-format-val">{f.value}</span>
            <button className="color-copy-btn" onClick={() => copyFormat(f.value)}>
              复制
            </button>
          </div>
        ))}
        {!parsed && (
          <div className="color-empty-hint">输入合法的 HEX / RGB / HSL 颜色值，色块与格式转换将实时更新</div>
        )}
      </div>
    </>
  );
}
