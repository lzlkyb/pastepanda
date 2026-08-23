import { useMemo, useState, useEffect } from "react";
import { useEditorCore } from "./useEditorCore";
import { MetaBar } from "./editorBits";
import { detectColor, toHex, toRgb, toHsl, type ParsedColor } from "@/lib/color";
import { useToast } from "@/components/Toast";
import type { EditorProps } from "@/lib/editorRegistry";

/**
 * 颜色专用编辑器（P4）：大色块 + 可编辑值 + HEX/RGB/HSL 三格式互转复制。
 * 全部复用 src/lib/color.ts 的 detectColor/toHex/toRgb/toHsl（与卡片色块同源）。
 * 色块底层为棋盘格，alpha <1 时透出；输入非法时色块隐藏并提示。
 */
/** 预设调色板（点击即设为当前颜色，复用 color.ts 的 toHex 比对） */
const PALETTE = [
  "#EF4444", "#F97316", "#F59E0B", "#EAB308", "#22C55E", "#10B981",
  "#14B8A6", "#06B6D4", "#0284C7", "#3B82F6", "#6366F1", "#8B5CF6",
  "#A855F7", "#D946EF", "#EC4899", "#F43F5E", "#64748B", "#0F172A",
];

/** 基于主色派生和谐副色（复用 color.ts 内部 RGB↔HSL 算法，仅旋转色相） */
function harmonize(base: ParsedColor, hueOffset: number): ParsedColor {
  const rN = base.r / 255, gN = base.g / 255, bN = base.b / 255;
  const max = Math.max(rN, gN, bN), min = Math.min(rN, gN, bN);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rN: h = (gN - bN) / d + (gN < bN ? 6 : 0); break;
      case gN: h = (bN - rN) / d + 2; break;
      default: h = (rN - gN) / d + 4; break;
    }
    h /= 6;
  }
  let h2 = (h * 360 + hueOffset) % 360;
  if (h2 < 0) h2 += 360;
  const sN = s, lN = l;
  const k = (n: number) => (n + h2 / 30) % 12;
  const a = sN * Math.min(lN, 1 - lN);
  const f = (n: number) => lN - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255), a: base.a, format: "hex" };
}

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

  const [secondary, setSecondary] = useState<ParsedColor | null>(null);
  const [secondaryManual, setSecondaryManual] = useState(false);
  const [angle, setAngle] = useState(135);

  // 基于主色派生 6 个和谐副色候选（色相旋转）；未手动选时默认取第一个
  const harmonies = useMemo<ParsedColor[]>(() => {
    if (!parsed) return [];
    return [-60, -30, 30, 60, 120, 180].map((o) => harmonize(parsed, o));
  }, [parsed]);

  useEffect(() => {
    if (!secondaryManual && harmonies.length) setSecondary(harmonies[0]);
  }, [harmonies, secondaryManual]);

  const sub = secondary ?? harmonies[0] ?? null;

  const applySwatch = (hex: string) => setText(hex);

  const copyGradient = async () => {
    if (!parsed || !sub) return;
    const css = `linear-gradient(${angle}deg, ${toHex(parsed)}, ${toHex(sub)})`;
    try {
      await navigator.clipboard.writeText(css);
      toast("已复制 " + css, "success");
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

      {/* 调色板：点击任一色块即设为当前颜色（触发上方实时更新） */}
      <div className="color-palette">
        <div className="color-sec-title">调色板 · 点击设为当前颜色</div>
        <div className="color-palette-grid">
          {PALETTE.map((hex) => (
            <button
              key={hex}
              type="button"
              className={"color-chip" + (parsed && toHex(parsed).toLowerCase() === hex.toLowerCase() ? " sel" : "")}
              style={{ background: hex }}
              title={hex}
              onClick={() => applySwatch(hex)}
            />
          ))}
        </div>
      </div>

      {/* 渐变生成器：主色取自编辑区，副色可由和谐色板选择，角度可调，一键复制 CSS */}
      {parsed && sub && (
        <div className="grad-panel">
          <div className="color-sec-title">渐变生成器 · 主色取自上方</div>
          <div
            className="grad-preview"
            style={{ background: `linear-gradient(${angle}deg, ${toHex(parsed)}, ${toHex(sub)})` }}
          />
          <div className="grad-sub">
            <span className="grad-sub-label">副色</span>
            {harmonies.map((c) => (
              <button
                key={toHex(c)}
                type="button"
                className={"color-chip sm" + (toHex(sub).toLowerCase() === toHex(c).toLowerCase() ? " sel" : "")}
                style={{ background: toHex(c) }}
                title={toHex(c)}
                onClick={() => { setSecondary(c); setSecondaryManual(true); }}
              />
            ))}
          </div>
          <div className="grad-angle">
            <span>角度</span>
            <input type="range" min={0} max={360} value={angle} onChange={(e) => setAngle(Number(e.target.value))} />
            <span className="grad-angle-val">{angle}°</span>
          </div>
          <button type="button" className="grad-copy" onClick={copyGradient}>复制 CSS</button>
        </div>
      )}
    </>
  );
}
