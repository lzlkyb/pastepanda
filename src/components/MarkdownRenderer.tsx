import { memo, useMemo, useRef, useState, useEffect } from "react";
import { renderMarkdownHtml } from "@/lib/markdown/renderHtml";
import { useLatest } from "@/hooks/useLatest";
import { ImageLightbox } from "@/components/markdown/ImageLightbox";
import { BlockEditOverlay } from "@/components/markdown/BlockEditOverlay";
import { useMarkdownFormValues } from "@/components/markdown/useMarkdownFormValues";
import { useEnableTaskCheckboxes, useTableDecorate, useBlockNumbers } from "@/components/markdown/useMarkdownDecorations";
import { useBlockEditing } from "@/components/markdown/useBlockEditing";
import { useCodeHighlight } from "@/components/markdown/useCodeHighlight";
import { useMermaidRender } from "@/components/markdown/useMermaidRender";
import { useMarkdownClicks } from "@/components/markdown/useMarkdownClicks";
import styles from "./MarkdownRenderer.module.css";

/**
 * Markdown 渲染组件
 * - 使用 marked 解析 + DOMPurify 防 XSS
 * - 代码块带窗口彩点 / 语言页签 / 复制按钮（事件委托）
 * - GFM 提示块（> [!NOTE] 等）渲染为图标 callout 卡片
 * - highlight.js 对代码块做语法高亮（异步加载后生效）
 * - compact 紧凑排版（小字号、隐藏代码块头部）；clamp 裁切到固定高度且不可滚。
 *   两者独立：hover 弹窗两个都要，笔记预览只要 compact（否则正文会被截断）
 * - lineNumbers 行号模式（全屏编辑器预览）：顶层块注入可点击块编号
 *   （md-blknum，点击闪烁高亮整块）+ 代码块按行包裹行号（md-cl）
 *
 * 实现拆分：marked 配置与解析在 lib/markdown/renderHtml.ts；
 * 各副作用按职责抽成 hook（useMarkdownFormValues / useEnableTaskCheckboxes /
 * useBlockEditing / useCodeHighlight / useMermaidRender / useTableDecorate /
 * useBlockNumbers / useMarkdownClicks）。⚠️ 下面 hook 的调用顺序 =
 * 拆分前 effect 的声明顺序，DOM 装饰之间有顺序约束（见表格装饰与块号注入），勿随意调换。
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({
  text,
  compact = false,
  clamp = false,
  className,
  debounceMs = 0,
  lineNumbers = false,
  baseDir = null,
  onToggleTask,
  onEditBlock,
}: {
  text: string;
  /** 紧凑排版：小字号、间距收紧、隐藏代码块头部。**不影响能看到多少内容** */
  compact?: boolean;
  /** 裁切到 120px 且不可滚（hover 弹窗那种「瞄一眼」的场景）。
   *  与 compact 分开：想要小字号不等于愿意被截断——笔记预览就是要读全文的 */
  clamp?: boolean;
  className?: string;
  /** 防抖毫秒数：>0 时延迟渲染，避免大文档每次击键都重解析（默认 0 立即渲染） */
  debounceMs?: number;
  /** 行号模式：块级行号 + 代码块行号（compact 下强制关闭） */
  lineNumbers?: boolean;
  /** 文档所在目录：用来解文档里的相对图片路径（`./assets/x.png`）。
   *  剪贴板内容模式没有目录，传 null；此时相对路径确实无法解，
   *  但**不再静默渲染一个加不出来的 <img>**（那等于一片空白），
   *  而是换成 md-imgmiss 占位，写明原路径，见 imageMissingHtml。 */
  baseDir?: string | null;
  /**
   * 任务列表勾选回调（全屏编辑器预览态）。不传 = 保持只读（卡片 hover、
   * 笔记预览、KB 问答这些没有保存路径的调用点不得传）。
   * 返回 `false` 表示没写进去（定位失败），本组件据此回滚乐观勾选。
   */
  onToggleTask?: (index: number) => boolean | void;
  /**
   * 块级就地编辑回调（全屏编辑器预览态，MarkCopy 思路：双击块 → 浮层改源码 → 写回）。
   * 不传 = 保持只读。参数：块序号（collectTopBlocks 口径）、新源码、打开浮层时的原源码。
   * 返回 `false` = 写回侧 expectRaw 校验不过（期间文档被改过），浮层不关、内容不丢。
   */
  onEditBlock?: (index: number, newRaw: string, expectRaw: string) => boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 点击委托只注册一次，回调经 ref 现取，避免每次渲染重绑
  const toggleRef = useLatest(onToggleTask);
  const interactiveTasks = !!onToggleTask;
  const interactiveBlocks = !!onEditBlock;

  /** 图片放大层：null = 关闭。只存 src/alt —— html 重渲染会整体换掉 img 节点 */
  const [zoomed, setZoomed] = useState<{ src: string; alt: string } | null>(null);

  // 防抖：debounceMs>0 时延迟更新待渲染文本，减少高频解析
  const [debouncedText, setDebouncedText] = useState(text);
  useEffect(() => {
    if (debounceMs <= 0) return;
    const t = setTimeout(() => setDebouncedText(text), debounceMs);
    return () => clearTimeout(t);
  }, [text, debounceMs]);

  const source = debounceMs > 0 ? debouncedText : text;
  const html = useMemo(() => renderMarkdownHtml(source, baseDir), [source, baseDir]);

  /** 行号模式实际生效值：compact（hover 弹窗）下强制关闭 */
  const showLineNumbers = lineNumbers && !compact;

  // ↓↓ 以下 hook 调用顺序 = 拆分前 effect 声明顺序，勿随意调换 ↓↓
  useMarkdownFormValues(containerRef, html);
  useEnableTaskCheckboxes(containerRef, html, interactiveTasks);
  const [editing, setEditing] = useBlockEditing(containerRef, text, html, interactiveBlocks);
  useCodeHighlight(containerRef, html, showLineNumbers);
  useMermaidRender(containerRef, html, clamp);
  useTableDecorate(containerRef, html);
  useBlockNumbers(containerRef, html, showLineNumbers);
  useMarkdownClicks(containerRef, setZoomed, toggleRef);

  return (
    <>
      <div
        ref={containerRef}
        className={`${styles.md} ${compact ? styles.compact : ""} ${clamp ? "md-clamp" : ""} ${showLineNumbers ? "md-ln" : ""} ${interactiveTasks ? styles.taskLive : ""} ${interactiveBlocks ? styles.blkLive : ""} ${className || ""}`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {editing && (
        <BlockEditOverlay
          blockNo={editing.index + 1}
          raw={editing.raw}
          onSave={(newRaw) =>
            onEditBlock ? onEditBlock(editing.index, newRaw, editing.raw) : false
          }
          onClose={() => setEditing(null)}
        />
      )}
      {zoomed && (
        <ImageLightbox
          src={zoomed.src}
          alt={zoomed.alt}
          onClose={() => setZoomed(null)}
        />
      )}
    </>
  );
});
