/**
 * result 态的出口面板（完成截图后选择去向）。
 *
 * 纯展示组件。敏感内容只在这里做**提示**，真正的拦截在父组件的各个 onXxx 里（规则 16）——
 * 展示层不能成为安全边界。
 */

import {
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  Copy,
  Crop,
  Download,
  Languages,
  Pin,
  RotateCcw,
  Sparkles,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { AiBadge } from "@/components/AiBadge";

interface Props {
  /** 供父组件实测面板尺寸（高度随出口数量变，写死算不准） */
  innerRef?: React.Ref<HTMLDivElement>;
  /** 位置（父组件用 layoutToolbar 算好）。
   *  旧实现写在 CSS 里钉死屏幕右下角，与选区无关。 */
  left: number;
  top: number;
  /** 附着方向（决定 tooltip 方向，与工具栏同一套语义） */
  attach: "below" | "above" | "inside";
  /** 命中的敏感内容类型（null = 未命中） */
  sensitiveKind: string | null;
  /** AI 可用（规则 16：必然出网的两项在不可用时不渲染） */
  aiOk: boolean;
  hasFixedRegion: boolean;
  /** 刚保存过固定区域（短暂反馈） */
  regionSaved: boolean;
  /** 当前编辑器打开的文件路径（null = 未打开，不显示插入出口） */
  editorTarget: string | null;
  /** §3：低频两组（文字 / 其它）默认收起，只留图片三行 + 一行「展开 N 项」 */
  expanded: boolean;
  onToggleExpand: () => void;
  onCopyImage: () => void;
  onSaveToGallery: () => void;
  onPinImage: () => void;
  onOpenAi: () => void;
  onTranslate: () => void;
  onOpenChains: () => void;
  /** 记住 / 清除固定区域（由 hasFixedRegion 决定语义） */
  onToggleRegion: () => void;
  onReselect: () => void;
  onInsertToEditor: () => void;
}

/**
 * 一行出口。图标位必须是 lucide 组件（与 AI 弹层 / 标注工具栏同一套语言）：
 * 这里原先画的是 ⬡ ⬇ 📌 AI 译 ⚡ 🔒 ↺ 📝 ⌄，一屏四种图标语言，
 * 而同一行的「送动作链」在点开后的弹层里已经是 <Workflow/> + 中性底。
 *
 * 尺寸 15px 与 `AiPopList.tsx` 的 `<TIcon size={15}/>` 同档，不新造尺寸。
 */
function ExitRow({
  icon: Icon,
  cls,
  label,
  sub,
  hint,
  mark,
  onClick,
}: {
  icon: LucideIcon;
  cls?: string;
  label: string;
  sub: string;
  /** 快捷键位。**只放快捷键**——翻译行原来挂在这里的是装饰性 ⚡，而它没有快捷键 */
  hint?: string;
  /** 行末云端标记（AiBadge）。只有点击即出网的行才挂；见下面「送动作链」的注释 */
  mark?: "ai";
  onClick: () => void;
}) {
  return (
    <button type="button" className={`act-row${cls ? ` ${cls}` : ""}`} onClick={onClick}>
      <span className="ic">
        <Icon size={15} />
      </span>
      <span className="tx">
        <span className="lbl">{label}</span>
        <span className="sub">{sub}</span>
      </span>
      {mark && (
        <span className="mk">
          <AiBadge size="xs" />
        </span>
      )}
      {hint && <span className="k">{hint}</span>}
    </button>
  );
}

export function ResultActions({
  innerRef,
  left,
  top,
  attach,
  sensitiveKind,
  aiOk,
  hasFixedRegion,
  regionSaved,
  editorTarget,
  expanded,
  onToggleExpand,
  onCopyImage,
  onSaveToGallery,
  onPinImage,
  onOpenAi,
  onTranslate,
  onOpenChains,
  onToggleRegion,
  onReselect,
  onInsertToEditor,
}: Props) {
  // 收起时藏起来的行 = 文字组 + 其它组。「展开 N 项」的 N 与副标名单都从这一份
  // 数据推出来，不另写一遍数字：加一行忘了同步计数是本条唯一的坏法。
  const lowLabels = [
    ...(aiOk ? ["AI 处理", "翻译"] : []),
    "送动作链",
    hasFixedRegion ? "清除固定区域" : "记住为固定区域",
    "重新截图",
    ...(editorTarget ? ["插入文档"] : []),
  ];
  return (
    <div
      ref={innerRef}
      className={`act-panel${attach === "inside" ? " inside" : ""}`}
      style={{ left, top }}
    >
      <div className="act-head">
        <span className="dot" /> 截图完成 · 选择出口
      </div>
      {sensitiveKind && (
        <div className="act-sens">
          ⚠️ 检测到疑似敏感内容（{sensitiveKind}），AI / 云端出口已拦截，需确认后才发送
        </div>
      )}
      {/* 分三组：9 行平铺时扫视没有落点。低频两组默认收起（审计 §3），
          但**不删行**——工具栏平铺的三个出口只是多给一条路，用户可能从「更多」进来后
          再选复制，那些行仍然必须能被找到，只是不再占满首屏。 */}
      {/* U7：每一行都是 `<button>`——「送动作链 / 固定区域 / 重新截图 / 插入当前文档」
          只有这个面板一条路，用 div 键盘就到不了。 */}
      <div className="act-group">图片</div>
      <ExitRow
        icon={Copy}
        label="复制图片"
        sub="写入剪贴板历史"
        hint="Ctrl+C"
        onClick={onCopyImage}
      />
      <ExitRow
        icon={Download}
        label="保存到图库"
        sub="另存为图片文件"
        hint="Ctrl+S"
        onClick={onSaveToGallery}
      />
      <ExitRow
        icon={Pin}
        cls="pin"
        label="贴图置顶"
        sub="钉在屏幕上"
        onClick={onPinImage}
      />
      {expanded ? (
        <>
          <div className="act-group">文字</div>
          {/* 规则 16：这两项必然走云端，AI 未启用时不渲染（零可见） */}
          {aiOk && (
            <ExitRow
              icon={Sparkles}
              label="AI 处理"
              sub="解释 / 翻译 / 总结"
              mark="ai"
              onClick={onOpenAi}
            />
          )}
          {aiOk && (
            <ExitRow
              icon={Languages}
              label="翻译"
              sub="识别文字翻译成中文"
              mark="ai"
              onClick={onTranslate}
            />
          )}
          {/* 这一行不挂徽标：它只打开链面板，真正出网的是面板里那条链的「运行」，
              而那里每条链按自己的步骤各挂各的（ChainPopover）。
              在这里挂「联网」等于替用户猜了一条他还没选的链。 */}
          <ExitRow
            icon={Workflow}
            label="送动作链"
            sub="对识别文字跑自定义链"
            onClick={onOpenChains}
          />
          <div className="act-group">其它</div>
          {/* 固定区域（从 select 态移来）：低频操作，不占工具栏横向空间。
              已有固定区域时变为「清除」，给它一个能被发现的出口（否则只能靠右键回退）。
              图标取 Crop（对象是「区域」）——选区预览条那颗按钮同步改，
              此前一个 🔒 一个 📌，同一功能两种长相。 */}
          <ExitRow
            icon={Crop}
            label={
              hasFixedRegion ? "清除固定区域" : regionSaved ? "✓ 已记住此区域" : "记住为固定区域"
            }
            sub={hasFixedRegion ? "恢复自动吸附" : "下次截图直接用这块区域"}
            onClick={onToggleRegion}
          />
          <ExitRow icon={RotateCcw} label="重新截图" sub="重选区域" onClick={onReselect} />
          {/* 截图插入当前编辑文档（编辑器打开时才显示） */}
          {editorTarget && (
            <ExitRow
              icon={ClipboardPaste}
              cls="insert"
              label="插入到当前文档"
              sub={editorTarget.split(/[\\/]/).pop() ?? ""}
              hint="Ctrl+Enter"
              onClick={onInsertToEditor}
            />
          )}
          {/* 展开态必须留一条回头路：此前 onToggleExpand 只绑在收起态那一行，
              面板在一次截图里只能进不能出（单向门）。 */}
          <ExitRow
            icon={ChevronUp}
            cls="expand"
            label={`收起 ${lowLabels.length} 项`}
            sub="只留图片三行"
            onClick={onToggleExpand}
          />
        </>
      ) : (
        <>
          <div className="act-group">文字 · 其它（收起）</div>
          <ExitRow
            icon={ChevronDown}
            cls="expand"
            label={`展开 ${lowLabels.length} 项`}
            sub={lowLabels.join(" / ")}
            onClick={onToggleExpand}
          />
        </>
      )}
    </div>
  );
}
