/**
 * 标注属性条（V6.20 双层工具栏的第二层）。
 *
 * 为什么拆出来：旧实现把 11 个工具 + 5 个颜色 + 箭头样式 + 撤销重做 + 长截图
 * + 完成 + ⋯ 共 21 个元素塞在一条栏里，颜色块只有 14px 直径、点偏就落在容器
 * 空白上没任何反应。拆成两层后每个颜色都有 24px 的方形热区。
 *
 * 只在选中绘制类工具时渲染（橡皮擦 / 马赛克 / 模糊 不需要颜色与粗细），
 * 属性记忆上次选择，所以实际不增加点击次数。
 *
 * 纯展示组件：不持有状态、不碰 ref、不发 IPC。
 */

import type { TbAttach } from "@/lib/screenshot/toolbarPos";
import {
  COLORS,
  PICKER_ICON,
  SHAPE_BRUSH_ICON,
  SHAPE_RECT_ICON,
  TEXT_SIZES,
  WIDTHS,
} from "./tools";

export type WidthId = (typeof WIDTHS)[number]["id"];
export type TextSizeId = (typeof TEXT_SIZES)[number]["id"];
export type MaskShape = "rect" | "brush";

interface Props {
  left: number;
  top: number;
  attach: TbAttach;

  /** 马赛克 / 模糊不用颜色，那两个工具下隐藏整个颜色组（含吸管） */
  showColor: boolean;
  color: string;
  onSelectColor: (c: string) => void;

  /** 吸管当前是否激活（tool === "picker"） */
  pickerOn: boolean;
  onPicker: () => void;

  /** 粗细：文字/序号用的是字号不是线宽，那两个工具下不显示 */
  showWidth: boolean;
  widthId: WidthId;
  onSelectWidth: (id: WidthId) => void;

  /** 箭头样式：只在箭头工具下显示（旧实现无论选什么工具都占着一格） */
  showArrow: boolean;
  arrowStyle: "single" | "double";
  onSelectArrowStyle: (s: "single" | "double") => void;

  /** 遮罩类工具（马赛克 / 模糊 / 高亮）的形状；不传 = 不显示这一组。
   *
   *  默认涂抹（跟 QQ / 微信一致）：遮三处不应该拖三次框，
   *  而且矩形必然连带遮住不该遮的内容。 */
  maskShape?: MaskShape;
  onSelectMaskShape?: (s: MaskShape) => void;

  /** 字号三档（文字 / 序号）；不传 = 不显示。
   *
   *  旧实现这两个工具下把“粗细”整组隐了，于是**没任何路径能改字号**。 */
  textSizeId?: TextSizeId;
  onSelectTextSize?: (id: TextSizeId) => void;

  /** 去水印模式：平铺·自动（一键整屏）/ 手动（涂抹或矩形）。不传 = 不显示模式分段。 */
  dewarpMode?: "manual" | "tile";
  onSelectDewarpMode?: (m: "manual" | "tile") => void;

  /** 遮罩类「模式」分段：马赛克 / 模糊 / 自动打码 收进同一把工具。
   *   - 马赛克 / 模糊 共用形状 + 强度（各自记忆）；点选 = 切换 tool；
   *   - 自动打码是动作型（点击执行、不切换工具），高亮永远不在它身上；
   *   - 有值才渲染分段；预览确认条打开期间父组件会强制保持分段可见（锚点不消失）。
   *  模式状态复用 tool 本身，不另设状态。 */
  maskMode?: "mosaic" | "blur" | "automask";
  onSelectMaskMode?: (m: "mosaic" | "blur" | "automask") => void;
  /** 自动打码首用引导（B 方案 discover 脉冲）：未用过的用户在分段上看到脉冲 */
  discoverAutomask?: boolean;
  /** 自动打码「预览式」确认条：锚定「自动打码」分段下方（反馈与触发同可见性域）。
   *  纯展示：只拿数量与回调，不碰 MaskBox 结构（类型在父组件私有）。 */
  maskOn?: boolean;
  maskActive?: number;
  onApplyMasks?: () => void;
  onCancelMasks?: () => void;

  /** 强度档位（马赛克色块 / 模糊半径）。
   *  旧实现只能滚轮调，而界面上没任何提示说可以滚，基本不可发现。 */
  strengthLevels?: { id: string; label: string; v: number }[];
  /** 当前强度值（物理像素），显示在档位旁边，滚轮微调时能看到变化 */
  strengthValue?: number;
  onSelectStrength?: (v: number) => void;
}

const IcArrowSingle = (
  <svg viewBox="0 0 16 16">
    <path d="M2.5 8h9" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
    <path d="M13.4 8L9.6 5.9v4.2Z" fill="currentColor" />
  </svg>
);
const IcArrowDouble = (
  <svg viewBox="0 0 16 16">
    <path d="M4.5 8h7" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
    <path d="M13.4 8L9.6 5.9v4.2Z" fill="currentColor" />
    <path d="M2.6 8L6.4 5.9v4.2Z" fill="currentColor" />
  </svg>
);

export function AttrBar({
  left,
  top,
  attach,
  showColor,
  color,
  onSelectColor,
  pickerOn,
  onPicker,
  showWidth,
  widthId,
  onSelectWidth,
  showArrow,
  arrowStyle,
  onSelectArrowStyle,
  maskShape,
  onSelectMaskShape,
  textSizeId,
  onSelectTextSize,
  strengthLevels,
  strengthValue,
  onSelectStrength,
  dewarpMode,
  onSelectDewarpMode,
  maskMode,
  onSelectMaskMode,
  discoverAutomask,
  maskOn,
  maskActive,
  onApplyMasks,
  onCancelMasks,
}: Props) {
  return (
    <div className={`attr-bar${attach !== "below" ? " top-attached" : ""}`} style={{ left, top }}>
      {showColor && (
        <>
          <span className="albl">颜色</span>
          {COLORS.map((c) => (
            // 外层 .cwrap 是 24px 热区，内层 .cp 才是 14px 色点。
            // 旧实现直接把 onClick 挂在 14px 色点上，点偏一两像素就没反应。
            <span key={c} className="cwrap" data-tip={c} onClick={() => onSelectColor(c)}>
              <span className={`cp${color === c && !pickerOn ? " on" : ""}`} style={{ background: c }} />
            </span>
          ))}
          <span
            className={`cwrap picker${pickerOn ? " on" : ""}`}
            data-tip="吸管取色 · 点画布取色并复制色值"
            onClick={onPicker}
          >
            {PICKER_ICON}
          </span>
        </>
      )}

      {showWidth && (
        <>
          <span className="asep" />
          <span className="albl">粗细</span>
          {WIDTHS.map((w) => (
            <span
              key={w.id}
              className={`wpick${widthId === w.id ? " on" : ""}`}
              data-tip={`${w.label}（${w.w}px）`}
              onClick={() => onSelectWidth(w.id)}
            >
              <span className="wdot" style={{ width: w.dot, height: w.dot }} />
            </span>
          ))}
        </>
      )}

      {/* 遮罩类「模式」分段：马赛克 / 模糊 / 自动打码。
       *  马赛克与模糊共用一把刷子（形状 + 强度各自记忆），收进同一工具；
       *  自动打码是动作型——点击直接执行（OCR 检测 → 预览确认），不切换工具，
       *  所以它永远没有高亮。确认条锚定「自动打码」分段下方。 */}
      {maskMode && onSelectMaskMode && (
        <>
          <span className="albl">模式</span>
          <span
            className={`wpick txt${maskMode === "mosaic" ? " on" : ""}`}
            data-tip="马赛克·色块遮档"
            onClick={() => onSelectMaskMode("mosaic")}
          >
            马赛克
          </span>
          <span
            className={`wpick txt${maskMode === "blur" ? " on" : ""}`}
            data-tip="模糊·柔化遮档（水滴）"
            onClick={() => onSelectMaskMode("blur")}
          >
            模糊
          </span>
          <span className="attr-anchor">
            <span
              className={`wpick txt${discoverAutomask ? " discover" : ""}`}
              data-tip="自动打码·一键遮蔽图中手机/身份证/邮箱等隐私文字（OCR 检测，可逐个排除）"
              onClick={() => onSelectMaskMode("automask")}
            >
              自动打码
            </span>
            {maskOn && (
              <div className="mask-bar" onMouseDown={(e) => e.stopPropagation()}>
                <div className="mask-title">🔒 识别到 {maskActive} 处隐私</div>
                <div className="mask-actions">
                  <button
                    className="mask-confirm"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onApplyMasks?.();
                    }}
                  >
                    ✓ 打码 {maskActive} 处
                  </button>
                  <button
                    className="mask-cancel"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onCancelMasks?.();
                    }}
                  >
                    放弃
                  </button>
                </div>
              </div>
            )}
          </span>
          <span className="asep" />
        </>
      )}

      {/* 去水印模式：平铺·自动（一键整屏检测）/ 手动（涂抹或矩形选区）。
       *  只有去水印工具下才出现（dewarpMode 有值时渲染）。平铺模式隐藏形状组，
       *  因为全自动无需形状；手动模式才需要形状选涂抹/矩形。 */}
      {dewarpMode && onSelectDewarpMode && (
        <>
          <span className="albl">模式</span>
          <span
            className={`wpick txt${dewarpMode === "manual" ? " on" : ""}`}
            data-tip="手动·涂抹或矩形选区局部去水印"
            onClick={() => onSelectDewarpMode("manual")}
          >
            手动
          </span>
          <span
            className={`wpick txt${dewarpMode === "tile" ? " on" : ""}`}
            data-tip="平铺·自动检测整屏平铺水印并批量去除"
            onClick={() => onSelectDewarpMode("tile")}
          >
            平铺·自动
          </span>
          <span className="asep" />
        </>
      )}

      {/* 形状：排在强度**前面**——先选“怎么遮”再调“遮多粗”，与操作顺序一致。
          样式直接复用 .wpick（粗细/强度/箭头三组已经在用它），不新发明一套。 */}
      {maskShape && onSelectMaskShape && (
        <>
          <span className="albl">形状</span>
          <span
            className={`wpick${maskShape === "brush" ? " on" : ""}`}
            data-tip="涂抹·像画笔一样刷过要遮的地方"
            onClick={() => onSelectMaskShape("brush")}
          >
            {SHAPE_BRUSH_ICON}
          </span>
          <span
            className={`wpick${maskShape === "rect" ? " on" : ""}`}
            data-tip="矩形·拖出一块区域"
            onClick={() => onSelectMaskShape("rect")}
          >
            {SHAPE_RECT_ICON}
          </span>
          <span className="asep" />
        </>
      )}

      {/* 字号：文字 / 序号专用。单位是 CSS 像素（见 TEXT_SIZES 的注释）。 */}
      {textSizeId && onSelectTextSize && (
        <>
          <span className="asep" />
          <span className="albl">字号</span>
          {TEXT_SIZES.map((t) => (
            <span
              key={t.id}
              className={`wpick txt${textSizeId === t.id ? " on" : ""}`}
              data-tip={`${t.label}（${t.css}px）`}
              onClick={() => onSelectTextSize(t.id)}
            >
              {t.label}
            </span>
          ))}
        </>
      )}

      {strengthLevels && onSelectStrength && (
        <>
          <span className="albl">强度</span>
          {strengthLevels.map((s) => (
            <span
              key={s.id}
              className={`wpick txt${strengthValue === s.v ? " on" : ""}`}
              data-tip={`${s.label}（${s.v}px）`}
              onClick={() => onSelectStrength(s.v)}
            >
              {s.label}
            </span>
          ))}
          {/* 当前值：滚轮微调后不在整档位上也能看到具体数字 */}
          <span className="aval">{strengthValue}px</span>
        </>
      )}

      {showArrow && (
        <>
          <span className="asep" />
          <span className="albl">箭头</span>
          <span
            className={`wpick${arrowStyle === "single" ? " on" : ""}`}
            data-tip="单箭头"
            onClick={() => onSelectArrowStyle("single")}
          >
            {IcArrowSingle}
          </span>
          <span
            className={`wpick${arrowStyle === "double" ? " on" : ""}`}
            data-tip="双箭头"
            onClick={() => onSelectArrowStyle("double")}
          >
            {IcArrowDouble}
          </span>
        </>
      )}
    </div>
  );
}
