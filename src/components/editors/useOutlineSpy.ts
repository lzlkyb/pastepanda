/**
 * 大纲滚动跟随（scrollspy）：内容滚到哪，大纲就高亮哪个标题。
 *
 * 为什么是独立 hook 而不是堆进 FullscreenEditor：外壳已 970+ 行（规则 7），
 * 且「监听挂载时机」与「useOutlineJump」是同款按模式分派的结构，抽出来便于单测。
 *
 * 数据流：大纲的标题本就是从源文扫的（scanHeadings，带行号 + slug，与预览
 * heading id 同源），所以「当前节」能直接算，不需要新数据源：
 *   - 编辑/分屏：CodeMirror 视口顶行 lineBlockAtHeight(scrollDOM.scrollTop)
 *     → 该行之上的最近标题。（分屏时无论拖哪侧，比例同步都会带动编辑器滚，
 *     所以统一以编辑器为准，不会两头打架。）
 *   - 仅预览：编辑器 display:none 没有滚动，改查预览 DOM 的 h1~h6（slug 即 id）。
 *
 * ❌ 不要把监听并进 scrollSync 那组：滚动同步只在 spec.scrollSync 时挂，
 * 而大纲跟随是独立功能；且 syncScroll 会丢「回声」滚动，spy 却需要
 * 每一次真实视口变化（回声同样是用户看到的位置）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { EditorView } from "@codemirror/view";
import type { ViewMode } from "./fullscreen/types";
import type { OutlineHeading } from "./fullscreen/MarkdownOutline";

/**
 * 行号 → 当前标题：该行号之上（含同行）最近的标题；在首个标题之前返回 null。
 * 纯函数，单测直接覆盖边界。
 */
export function headingAtOrAbove(headings: OutlineHeading[], line: number): OutlineHeading | null {
  let cur: OutlineHeading | null = null;
  for (const h of headings) {
    if (h.line <= line) cur = h;
    else break;
  }
  return cur;
}

/** 预览视口顶部的判定余量：标题进入视口顶部 80px 内就算「当前节」 */
const PREVIEW_TOP_MARGIN = 80;

/** 预览 DOM 法：视口顶部之上最近的标题的 id（= slug） */
export function activeSlugFromPreview(root: HTMLElement): string | null {
  const nodes = root.querySelectorAll<HTMLElement>("h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]");
  const top = root.scrollTop + PREVIEW_TOP_MARGIN;
  let cur: string | null = null;
  for (const el of nodes) {
    if (el.offsetTop <= top) cur = el.id;
    else break;
  }
  return cur;
}

interface Opts {
  /** false 时不挂监听、不算（非 markdown / 大纲收起 / 专注模式） */
  enabled: boolean;
  viewMode: ViewMode;
  headings: OutlineHeading[];
  /** CodeMirror 实例（算视口顶行） */
  viewRef: RefObject<EditorView | null>;
  /** 编辑器容器（找 .cm-scroller 挂 scroll 监听） */
  editorRef: RefObject<HTMLElement | null>;
  /** 预览滚动容器（仅预览模式用 DOM 法） */
  previewScrollRef: RefObject<HTMLElement | null>;
  /** 从文件打开时面板延迟挂载，监听必须等 loading 翻面后再挂（同 scrollSync 的坑） */
  loading: boolean;
}

export function useOutlineSpy({ enabled, viewMode, headings, viewRef, editorRef, previewScrollRef, loading }: Opts) {
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  // rAF 合并：scroll 事件一帧可能连发多次，计算本身便宜，但 setState 触发的
  // 渲染要省——同一帧只算一次、只提交一次。
  const rafRef = useRef(0);

  const compute = useCallback(() => {
    if (viewMode === "preview") {
      const el = previewScrollRef.current;
      setActiveSlug(el ? activeSlugFromPreview(el) : null);
      return;
    }
    const view = viewRef.current;
    if (!view) return;
    // lineBlockAtHeight 接受文档坐标：scrollDOM.scrollTop 恰是「卷走的文档高度」，
    // 即视口顶行所在位置。拿视口顶行行号，命中其上最近的标题。
    const topLine = view.state.doc.lineAt(view.lineBlockAtHeight(view.scrollDOM.scrollTop).from).number;
    setActiveSlug(headingAtOrAbove(headings, topLine)?.slug ?? null);
  }, [viewMode, headings, viewRef, previewScrollRef]);

  const schedule = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      compute();
    });
  }, [compute]);

  // 挂监听的时机依赖与 scrollSync 相同：loading 翻面后编辑/预览面板才存在。
  useEffect(() => {
    if (!enabled || loading) return;
    const editorScroller = editorRef.current?.querySelector(".cm-scroller");
    const previewEl = previewScrollRef.current;
    if (editorScroller) editorScroller.addEventListener("scroll", schedule);
    if (previewEl) previewEl.addEventListener("scroll", schedule);
    // 面板刚挂好（或模式切换）时先算一次初始位置，不等用户滚动
    compute();
    return () => {
      if (editorScroller) editorScroller.removeEventListener("scroll", schedule);
      if (previewEl) previewEl.removeEventListener("scroll", schedule);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
    // editorRef 为稳定 ref（eslint 要求列入）；compute 随 viewMode/headings 变化重挂，
    // 重挂时正好补算初始位置
  }, [enabled, loading, viewMode, headings, schedule, compute, editorRef, previewScrollRef]);

  return { activeSlug, setActiveSlug };
}
