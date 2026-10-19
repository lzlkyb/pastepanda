import { memo, useCallback, useContext, useRef, useEffect } from "react";
import { AnimatePresence } from "framer-motion";
import { useAppStore } from "@/stores/appStore";
import { relativeTime, parseFilePaths, resolveImageCardDisplay, getImageBarcodes, barcodeBadgeLabel } from "@/lib/utils";
import { detectColor } from "@/lib/color";
import { maskSecretText } from "@/lib/secret";
import { parseDiagram, diagramTitle } from "@/lib/diagram/types";
import { openNoteForCard } from "@/lib/notes/open";
import { useDialogStore } from "@/stores/dialogStore";
import SourceBadge from "@/components/SourceBadge";
import { CtxMenuCtx } from "@/components/ContextMenu";
import { TagRow } from "@/components/TagBadge";
import { Pin, Check } from "lucide-react";
import styles from "../CardList.module.css";
import { CardIcon } from "./CardIcon";
import { HighlightText } from "./HighlightText";
import { CardHoverPopover } from "./CardHoverPopover";
import { InlineCardActions } from "./InlineCardActions";
import { useCardHover } from "@/hooks/useCardHover";
import { usePinFlash } from "@/hooks/usePinFlash";
import type { CardProps } from "./cardTypes";

export const Card = memo(function Card({ item, selected, current = selected, checked = false, onClick, onDoubleClick, index, imageState, searchKeyword, onRetryImage, pasting, menuItems, onEdit, disablePreview, stackOrder, stackDone, ocrState, barcodeState }: CardProps) {
  const config = useAppStore((s) => s.config);
  // 已转笔记？只读 store 里那个全量 Set（一屏几十张卡片，逐张发 IPC 不可接受）
  const hasNote = useAppStore((s) => s.noteHistoryIds.has(item.id));
  const clickTimerRef = useRef<number | null>(null);
  const pinFlash = usePinFlash(item.pinned);
  const subType = item.content_type || item.type;
  const isMd = item.type === "text" && subType === "markdown";
  const parsedColor = subType === "color" ? detectColor(item.text || "") : null;
  const time = relativeTime(item.time);
  // 图片卡片显示决策（OCR 文本 / 识别中 / 无文字 / 文件名回退 + 尺寸/OCR 徽标），
  // 纯函数放 lib/utils.ts 便于单测；这里只消费结果。
  const imgDisplay = item.type === "image" ? resolveImageCardDisplay(item, ocrState) : null;
  // 二维码/条码徽章（设计稿）：仅 image 类型；无码或结论未出不渲染。
  const codeHits = item.type === "image" ? getImageBarcodes(item, barcodeState) : null;
  const codeBadge = barcodeBadgeLabel(codeHits);
  // MB 级文本先截断再扁平化，避免整块进 DOM / 高亮 split 拖垮列表（M24）
  const title = (() => {
    if (item.type === "file") {
      // 修复 U19：不再显示原始 JSON，解析为友好文件名（"a.txt 等 3 个文件"）
      const paths = parseFilePaths(item.content || "");
      if (paths.length === 0) return "文件";
      const firstName = paths[0].split(/[/\\]/).pop() || paths[0];
      return paths.length > 1 ? `${firstName} 等 ${paths.length} 个文件` : firstName;
    }
    // 流程图：标题取节点标签拼接，空则回退「流程图（N 节点）」
    if (item.type === "diagram") {
      return diagramTitle(parseDiagram(item.content));
    }
    // 图片：OCR 文字 / 识别中 / 未识别到文字 / 文件名（见 resolveImageCardDisplay）
    if (imgDisplay) return imgDisplay.title;
    // P4：密钥脱敏 — 卡片标题不展示明文，前 8 字符 + 遮罩（复制操作不受影响，仍取真实值）
    if (subType === "secret") return maskSecretText(item.text || "");
    const flat = (item.text || "").slice(0, 501).replace(/\r?\n/g, " ").trim() || "(空)";
    return flat.length > 500 ? flat.slice(0, 500) + "…" : flat;
  })();

  // 原来这里是一条按类型分支的链，但 cardImage/cardFile/cardCode/cardText 四个类
  // 在 CSS 里并不存在（只有 cardPinned 是真的），实际效果等价于下面这行。
  // 顺带修掉一个副作用：这些未定义类返回 undefined，拼进模板字符串后会在
  // DOM 里真的落下一个名为 "undefined" 的 class。
  // 图片/文件类型不加 📌 角标——保持原有行为，它们的置顶状态由下面
  // cardSub 里的「置顶」徽标体现。
  const typeClass =
    item.pinned && item.type !== "image" && item.type !== "file" ? styles.cardPinned : "";

  // ★ 通过 Context 获取 ContextMenu 的 trigger 函数，用原生 DOM 事件调用，
  //   完全不依赖 DOM 事件冒泡、dispatchEvent、React 合成事件。
  const ctxTrigger = useContext(CtxMenuCtx);
  const cardRef = useRef<HTMLDivElement>(null);
  const { hovered, popoverFlipDown, enterHover, scheduleClose, onFocus, onBlur, onMouseDownCapture, onKeyDownCapture, onCopyFeedbackChange } = useCardHover(item.id, disablePreview && config.hover_mode === "popover" ? "off" : config.hover_mode, cardRef);
  useEffect(() => {
    const el = cardRef.current;
    if (!el || !ctxTrigger) return;
    const onCtxMenu = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      ctxTrigger(e.clientX, e.clientY, menuItems || []);
    };
    el.addEventListener("contextmenu", onCtxMenu);
    return () => {
      el.removeEventListener("contextmenu", onCtxMenu);
    };
  }, [ctxTrigger, menuItems]);

  // 清理定时器，防止组件卸载后回调执行
  useEffect(() => {
    return () => {
      if (clickTimerRef.current !== null) {
        clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
    };
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // 只处理左键，右键留给 onContextMenu
    if (e.button !== 0) return;
    // 当前项本身立即反馈选中，不另建延迟点击底色，避免移走后残留。
    // 修复 U18：单击立即执行选中，消除 200ms 延迟；
    // 定时器仅作为"双击窗口"标记——窗口期内的第二次点击触发双击动作
    // （首次点击的选中保留，符合桌面端双击先选中的惯例）
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      onDoubleClick();
    } else {
      onClick(e);
      clickTimerRef.current = window.setTimeout(() => {
        clickTimerRef.current = null;
      }, 250);
    }
  }, [onClick, onDoubleClick]);

  return (
    <div
      className={styles.cardWrap}
      onMouseEnter={enterHover}
      onMouseLeave={scheduleClose}
      onFocus={onFocus}
      onBlur={onBlur}
      onMouseDownCapture={onMouseDownCapture}
      onKeyDownCapture={onKeyDownCapture}
    >
      <div
        ref={cardRef}
        onMouseDown={handleMouseDown}
        className={`${styles.card} ${typeClass}${checked ? ` ${styles.selected}` : ""}${current ? ` ${styles.current}` : ""}${stackOrder ? ` ${styles.cardInStack}${stackOrder === 1 ? ` ${styles.cardStackNext}` : ""}` : ""}${stackDone ? ` ${styles.cardStackDone}` : ""}${pinFlash ? ` ${styles.cardJustPinned}` : ""}`}
        role="option"
        aria-selected={selected}
        aria-label={title.length > 80 ? title.slice(0, 80) + "…" : title}
        aria-posinset={index + 1}
        tabIndex={current ? 0 : -1}>

        <div className={styles.cardIconSlot}>
          <CardIcon item={item} imageState={imageState} onRetryImage={onRetryImage} />
          {checked && <span className={styles.multiCheck} role="img" aria-label="已多选"><Check size={12} /></span>}
        </div>

        {/* 内容 */}
        <div className={styles.cardContent}>
          <p className={styles.cardTitle}>
            <HighlightText text={title} highlight={item.type === "text" ? (searchKeyword ?? "") : ""} />
          </p>
          {/* 徽标顺序：置顶（状态）→ 来源应用 → 图片尺寸 → OCR → 颜色格式 → 标签。
              来源排在最前（除状态）：用户看卡片时先关心“从哪来的”。
              ❗ 这里**没有**「内容类型」徽标（代码/文本/图片之类）。类型已由左侧图标表达，
                再挂一枚文字徽标是重复信息。旧注释写过「→ 内容类型 →」，但代码里从来没有，
                手册的界面复刻照那句注释臆造了一枚徽标出来，删注释连坐。
              注：图文混排不在这里画专用徽标——它走「图文」自动标签，由下方 TagRow
              渲染，这样才能点击筛选、也才会出现在筛选标签列表里。 */}
          <div className={styles.cardSub}>
            {item.pinned && (
              <span className={styles.cardPin}>
                {config.theme === "blossom" ? "🎀" : <Pin size={7} />} 置顶
              </span>
            )}
            {item.source && <SourceBadge source={item.source} sourceIcon={item.source_icon} size="small" />}
            {/* 图片卡片：尺寸徽标（从占位 [图片] WxH 提取）+ OCR 徽标（有识别文字时） */}
            {imgDisplay?.sizeText && <span className={styles.cardSizeTag}>{imgDisplay.sizeText}</span>}
            {imgDisplay?.ocrLabel && <span className={styles.cardOcrBadge}>{imgDisplay.ocrLabel}</span>}
            {/* 条码徽章：点击打开预览并展开结果抽屉（预览侧「识别到码自动展开一次」与 OCR 同纪律）。
                stopPropagation：不拦就会同时触发卡片 onClick（选中/复制）。 */}
            {codeBadge && (
              <button
                type="button"
                className={styles.cardCodeBadge}
                title="查看二维码/条码内容"
                onClick={(e) => {
                  e.stopPropagation();
                  useDialogStore.getState().openEditor(item);
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                {codeBadge}
              </button>
            )}
            {parsedColor && (
              <span className={styles.colorFormatTag}>{parsedColor.format.toUpperCase()}</span>
            )}
            <TagRow tags={item.tags || []} />
          </div>
        </div>

        {/* 时间 / 复制中指示器 */}
        <span className={styles.cardTime}>
          {pasting ? <span className={styles.cardPasting}><Check size={10} />已复制</span> : time}
        </span>
      </div>

      {/* 栈序号角标（渲染在 cardWrap 层，避免被卡片 overflow:hidden 裁剪） */}
      {stackOrder ? <span className={`${styles.stackBadge}${stackOrder === 1 ? ` ${styles.stackBadgeNext}` : ""}`}>{stackOrder}</span> : null}
      {stackDone ? <span className={`${styles.stackBadge} ${styles.stackBadgeDone}`}>✓</span> : null}

      {/* 已转笔记角标（知识库 A 阶段）。同样画在 cardWrap 层，否则被卡片 overflow:hidden 裁掉。
          可点：直接打开那条笔记编辑。stopPropagation 是必需的——不阻止就会同时触发
          卡片的 onClick（选中/复制），变成“点角标顺手把卡片内容复制了”。 */}
      {hasNote ? (
        <button
          type="button"
          className={styles.noteBadge}
          title="已转为笔记 · 点击编辑"
          aria-label="编辑笔记"
          onClick={(e) => {
            e.stopPropagation();
            void openNoteForCard(item, ocrState);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          📝
        </button>
      ) : null}

      {/* ★ 悬停 Popover 气泡弹窗（移到卡片外部，避免被 card overflow:hidden 裁剪） */}
      <AnimatePresence key={`${item.id}:${config.hover_mode}`}>
        {hovered && config.hover_mode === "popover" && !disablePreview && (
          <CardHoverPopover key={item.id} item={item} imageState={imageState} subType={subType} isMd={isMd} onEdit={onEdit} onMouseEnter={enterHover} onMouseLeave={scheduleClose} flipDown={popoverFlipDown} ocrState={ocrState} onCopyFeedbackChange={onCopyFeedbackChange} />
        )}
      </AnimatePresence>

      {/* ★ 按钮模式：卡片内嵌操作按钮 */}
      {config.hover_mode === "inline" && (
        <InlineCardActions item={item} hovered={hovered} onEdit={onEdit} ocrState={ocrState} onCopyFeedbackChange={onCopyFeedbackChange} />
      )}
    </div>
  );
});
