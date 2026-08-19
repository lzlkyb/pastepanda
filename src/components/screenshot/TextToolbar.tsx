/**
 * 文字标注的「附着迷你工具条」（微信截图文字工具同款）：
 * 输入框下方紧跟一个浮条，含 字号 A-/A+ 与 色板，边打字边改字号/颜色。
 *
 * 复用主属性条同一套状态（color / textSizeId），所以这里改的会即时反映到
 * 正在输入的文字预览、落字时也用同一份，不需再回主栏。
 *
 * onMouseDown 阻止默认：点色板/字号不抢输入框焦点——否则输入框 blur 触发提交、
 * 框一闪没了（与文字输入框同样的 WebView 焦点坑）。
 */
import type { CSSProperties } from "react";
import type { TextSizeId } from "./AttrBar";
import { COLORS, stepTextSize } from "./tools";

interface Props {
  color: string;
  onSelectColor: (c: string) => void;
  textSizeId: TextSizeId;
  onSelectTextSize: (id: TextSizeId) => void;
  /** 附着位置（CSS 像素），由父组件算好紧贴输入框下沿 */
  style?: CSSProperties;
}

export function TextToolbar({ color, onSelectColor, textSizeId, onSelectTextSize, style }: Props) {
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();
  return (
    <div className="text-toolbar" style={style} onMouseDown={keepFocus}>
      <button
        className="ttbtn"
        title="缩小字号"
        onClick={() => onSelectTextSize(stepTextSize(textSizeId, -1))}
      >
        A−
      </button>
      <button
        className="ttbtn"
        title="放大字号"
        onClick={() => onSelectTextSize(stepTextSize(textSizeId, 1))}
      >
        A+
      </button>
      <span className="tsep" />
      {COLORS.map((c) => (
        <span key={c} className="cwrap" data-tip={c} onClick={() => onSelectColor(c)}>
          <span className={`cp${color === c ? " on" : ""}`} style={{ background: c }} />
        </span>
      ))}
      {/* 快捷键常驻：以前写在输入框的 placeholder 里，一打字就消失，
          而“怎么换行”恰恰是打到一半才会问的问题。 */}
      <span className="tkeys">Enter 确认 · Shift+Enter 换行</span>
    </div>
  );
}
