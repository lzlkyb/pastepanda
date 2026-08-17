/**
 * 标注态主工具栏（= 微信截图「已确认选区」后那条栏）。
 *
 * 纯展示组件：不持有任何状态、不碰 ref、不发 IPC。
 *
 * V6.20 双层改版：颜色 / 粗细 / 箭头样式已移到 AttrBar（属性条）。
 * 旧实现把 21 个元素塞在一条 560px 的栏里，拥挤本身就是误点与"看不懂"的成因之一。
 *
 * 每个按钮带常驻中文标签（QQ 截图同款）：马赛克 / 模糊 / 高亮 这类概念
 * 没有公认图形，纯图标怎么画都得猜。
 */

import type { ToolId } from "@/lib/screenshot/types";
import type { TbAttach } from "@/lib/screenshot/toolbarPos";
import { Sparkles } from "lucide-react";
import { AiMark } from "@/components/ai/AiMark";
import { OCR_ICON, PIN_ICON, SAVE_ICON, TOOLS } from "./tools";

/** 取文字按钮的状态（与 ScreenshotOverlay 的 ocrStatus 同源） */
export type OcrBtnStatus = "idle" | "running" | "done" | "empty" | "failed";

interface Props {
  /** 供父组件实测主栏宽高（右对齐需要真实宽度，它随按钮文案变） */
  innerRef?: React.Ref<HTMLDivElement>;
  /** 主栏左/上位置（CSS 像素，父组件用 layoutToolbar 算好） */
  left: number;
  top: number;
  /** 附着方向：决定 tooltip 向下还是向上弹。
   *  旧实现 CSS 里写了 .top-attached 规则却从未加过这个类，是条死规则。 */
  attach: TbAttach;
  /** 正在合成/保存：整条栏变淡且不接收点击（否则点了什么都不发生） */
  busy: boolean;

  tool: ToolId;
  onSelectTool: (id: ToolId) => void;

  /** 栈空时置灰——旧实现栈空直接 return，按钮外观不变，看不出来不可用 */
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;

  /** OCR 状态：决定取文字按钮的四态外观。
   *  旧实现里 OCR 只有一个 6s 后自动收起的胶囊，收起之后标注态再无任何入口
   *  （只剩没人知道的 Ctrl+R），等于把功能做成了限时闪现。 */
  ocrStatus: OcrBtnStatus;
  /** 识别到的行数，显示为角标——它本身就回答了"这张图里有没有字" */
  ocrLines: number;
  /** 识别失败原因，进 tooltip（规则 15.3：失败不静默） */
  ocrErr: string | null;
  /** 抽屉当前是否展开（决定 tooltip 说"查看"还是"收起"） */
  ocrOpen: boolean;
  /** 点击：done → 展开/收起抽屉；failed → 重试。其余状态不可点。 */
  onOcr: () => void;

  /** 已有标注（长截图会丢弃它们） */
  hasAnnotations: boolean;
  /** 正在长截图 */
  longShotting: boolean;
  onLongShot: () => void;

  /** AI 可用（规则 16 红线）。不可用时 AI 按钮**零可见**，
   *  不能渲染出来再靠 handler 里 early return——那是“点了没反应”的静默失败。 */
  aiOk: boolean;
  /** 三个主力出口：从「更多」面板里提上来平铺。
   *  它们都需要已落盘的结果图，而标注态 resultPath 是 null，
   *  所以父组件的 handler 必须先 await ensureResultPath()。 */
  onSave: () => void;
  onPin: () => void;
  onAi: () => void;

  /** 取消：退出这次截图（关窗）。
   *  不是"退回选区" —— 按钮写着"取消"，用户读到的就是取消整件事（微信截图同款）。 */
  onCancel: () => void;
  onDone: () => void;
  onMore: () => void;
}

/** 撤销图标（与 tools.tsx 同一套描边参数） */
const IcUndo = (
  <svg viewBox="0 0 16 16">
    <path
      d="M3 6.2h7a3.4 3.4 0 1 1 0 6.8H6"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M6.4 3L3.2 6.2l3.2 3.2"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const IcRedo = (
  <svg viewBox="0 0 16 16">
    <path
      d="M13 6.2H6a3.4 3.4 0 1 0 0 6.8h4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M9.6 3l3.2 3.2-3.2 3.2"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const IcLongShot = (
  <svg viewBox="0 0 16 16">
    <rect
      x="4"
      y="1.8"
      width="8"
      height="5"
      rx="1"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinejoin="round"
    />
    <path
      d="M8 8v5.4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
    />
    <path
      d="M5.4 11l2.6 2.6L10.6 11"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export function AnnotToolbar({
  innerRef,
  left,
  top,
  attach,
  busy,
  tool,
  onSelectTool,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  ocrStatus,
  ocrLines,
  ocrErr,
  ocrOpen,
  onOcr,
  hasAnnotations,
  longShotting,
  onLongShot,
  aiOk,
  onSave,
  onPin,
  onAi,
  onCancel,
  onDone,
  onMore,
}: Props) {
  // 取文字按钮：四态共用同一个位置与尺寸。
  // ① 无文字时置灰但**不隐藏**：按钮消失会让右边的取消/完成/⋯ 整体左移，
  //    用户下一次点击就落空——位置跳动比多一个灰按钮糟得多。
  // ② 识别中用与 svg 同尺寸（17px）的转圈占位，按钮宽度不会跳。
  const ocrClickable = ocrStatus === "done" || ocrStatus === "failed";
  const ocrTip =
    ocrStatus === "running"
      ? "正在识别图中文字…"
      : ocrStatus === "failed"
        ? `文字识别失败 · 点击重试${ocrErr ? `（${ocrErr}）` : ""}`
        : ocrStatus === "done"
          ? ocrOpen
            ? "收起文字面板（Ctrl+R）"
            : `查看 ${ocrLines} 行文字（Ctrl+R）· 按 T 直接复制全文`
          : "图中未识别到文字";

  // 长截图不可用的两个原因必须分开写文案。
  // 旧实现 disabled 条件含“正在长截图”，提示词却只按“有标注”分支写，
  // 于是长截图进行中点它：按钮灰着、没反应、提示词还说它可用（违反规则 15.3）。
  const longShotDisabled = hasAnnotations || longShotting;
  const longShotTip = longShotting
    ? "正在长截图 · 请先等当前一轮结束"
    : hasAnnotations
      ? "已有标注，长截图会丢弃它们 · 先撤销或完成"
      : "滚动拼接成一张长图";

  return (
    <div
      ref={innerRef}
      className={`annot-toolbar${attach !== "below" ? " top-attached" : ""}${busy ? " busy" : ""}`}
      style={{ left, top }}
    >
      {TOOLS.map((t) => (
        <div
          key={t.id}
          className={`tool${tool === t.id ? " on" : ""}`}
          data-tip={`${t.tip ?? t.label}${t.key ? `（按 ${t.key}）` : ""}`}
          onClick={() => onSelectTool(t.id)}
        >
          <span className="ic">{t.icon}</span>
          <span className="lb">{t.label}</span>
        </div>
      ))}

      <div className="tsep" />

      <div
        className={`tool dim${canUndo ? "" : " disabled"}`}
        data-tip={canUndo ? "撤销（Ctrl+Z）" : "没有可撤销的操作"}
        onClick={() => canUndo && onUndo()}
      >
        <span className="ic">{IcUndo}</span>
        <span className="lb">撤销</span>
      </div>
      <div
        className={`tool dim${canRedo ? "" : " disabled"}`}
        data-tip={canRedo ? "重做（Ctrl+Y）" : "没有可重做的操作"}
        onClick={() => canRedo && onRedo()}
      >
        <span className="ic">{IcRedo}</span>
        <span className="lb">重做</span>
      </div>

      {/* 长截图（从 select 态移来）：输出类动作而非标注工具，靠 tsep 与标注工具分开。
          ⚠️ 已有标注时必须禁用：长截图走 finalizeCanvas，不合成 annotations，
          此时点它会把先画的标注静默丢掉。 */}
      <div
        className={`tool longshot${longShotDisabled ? " disabled" : ""}`}
        data-tip={longShotTip}
        onClick={() => {
          if (longShotDisabled) return;
          onLongShot();
        }}
      >
        <span className="ic">{IcLongShot}</span>
        <span className="lb">长截图</span>
      </div>

      {/* 取文字：与长截图同组（都是"对整张图产出别的东西"），但排在它右边：
          主栏右对齐选区右边缘，而框选后鼠标通常停在选区右下角，越靠右手越省（规则 17.2）。
          取文字高频、长截图低频。 */}
      <div
        className={`tool ocr-btn${ocrStatus === "running" ? " busy" : ""}${
          ocrStatus === "failed" ? " failed" : ""
        }${ocrStatus === "empty" || ocrStatus === "idle" ? " disabled" : ""}`}
        data-tip={ocrTip}
        onClick={() => {
          if (!ocrClickable) return;
          onOcr();
        }}
      >
        {ocrStatus === "done" && ocrLines > 0 && (
          <span className="badge">{ocrLines > 99 ? "99+" : ocrLines}</span>
        )}
        {ocrStatus === "failed" && <span className="badge warn">!</span>}
        <span className="ic">
          {ocrStatus === "running" ? <span className="ocr-spin" /> : OCR_ICON}
        </span>
        <span className="lb">取文字</span>
      </div>

      <div className="tsep" />

      {/* 取消单独成组：它是销毁动作，不能跟出口挤在一起。
          旧布局里它紧贴着「完成」，现在中间隔了三个出口按钮，误点代价低很多。 */}
      <div
        className="tool cancel-btn"
        data-tip="取消截图并关闭 · 只想重新框选按 Esc"
        onClick={onCancel}
      >
        ✕ 取消
      </div>

      <div className="tsep" />

      {/* 三个主力出口。以前全藏在那个无标签的「⋯」后面，而贴图 / AI 是本产品的主力能力。
          行业里保存/贴图一律在主栏（QQ / 微信 / PixPin），不藏二级菜单。 */}
      <div className="tool exit-save" data-tip="保存为图片文件（Ctrl+S）" onClick={onSave}>
        <span className="ic">{SAVE_ICON}</span>
        <span className="lb">保存</span>
      </div>
      <div className="tool exit-pin" data-tip="钉在屏幕最上层，可拖动可缩放" onClick={onPin}>
        <span className="ic">{PIN_ICON}</span>
        <span className="lb">贴图</span>
      </div>
      {/* 图标与文字都走全站统一的 AI 标识（AiMark / lucide Sparkles），不在这里另写一份。
          strokeWidth 2.25 是算出来的：tools.tsx 的图标是 viewBox 16 / stroke 1.5，
          渲染到 17px 后约 1.59 设备像素；lucide 是 viewBox 24，要达到同粗细
          需 1.59 ÷ (17/24) ≈ 2.25。用默认的 2 会比旁边所有图标细一截。 */}
      {aiOk && (
        <div className="tool exit-ai" data-tip="AI 处理识别文字：解释 / 翻译 / 总结" onClick={onAi}>
          <span className="ic">
            <Sparkles size={17} strokeWidth={2.25} />
          </span>
          <span className="lb">
            <AiMark shape="text" text="AI" />
          </span>
        </div>
      )}

      <div className="tsep" />

      <div
        className="tool done-btn"
        data-tip={busy ? "正在合成图片…" : "完成并复制（Enter / 双击画布）"}
        onClick={onDone}
      >
        {busy ? "处理中…" : "完成 ✓"}
      </div>
      {/* 补上中文标签：它曾是工具栏里唯一一个只有符号没有文字的按钮，
          而“⋯”本身零语义——用户不点就不知道后面是什么。 */}
      <div
        className="tool more-btn"
        data-tip="更多出口：翻译 / 送动作链 / 固定区域 / 插入文档"
        onClick={onMore}
      >
        更多 ⋯
      </div>
    </div>
  );
}
