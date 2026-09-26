/**
 * 单份文档的**视图态**（视图模式 / 分栏 / 大纲 / 专注模式 / 滚动同步 / 光标）。
 *
 * 从 `FullscreenEditor.tsx`（原 1061 行）抽出的三块之一，与
 * `useDocumentFile`（文件态）、`useEditorPrefs`（设置）并列。
 * 拆的理由是规则 7 的体量红线，不是逻辑发生了变化 —— 注释全部原样保留。
 *
 * ❗ `active` 门控（规则 8.2）：多标签下每个标签都活着，非活动标签必须停掉
 * 常驻监听。这里涉及两处：编辑区↔预览的滚动同步监听、以及从隐藏恢复时的
 * 重新测量。暂停判据是「这个标签是不是当前显示的那个」。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { EditorView } from "@codemirror/view";
import { readOutlinePref, writeOutlinePref } from "./MarkdownOutline";
import { useFocusMode } from "./useFocusMode";
import type { FullscreenTypeSpec, ViewMode } from "./types";

/** 滚动同步的回声抑制窗口（ms）。
 *  要大于一帧（回声 scroll 事件在下一帧才到），又要小到用户主动改滚另一侧时不卡手。 */
const SCROLL_SYNC_ECHO_MS = 120;

/** 内容层入场动画时长（ms）。必须与 `FullscreenEditor.module.css` 的
 *  `.contentEnterA` / `.contentEnterB` 保持一致 —— 标记摘除比它晚一点。 */
const CONTENT_ENTER_MS = 150;

interface Opts {
  spec: FullscreenTypeSpec;
  /** 本标签是否为当前活动标签（非活动时暂停常驻监听） */
  active: boolean;
  /** 文件加载中（面板尚未挂载，监听挂不上） */
  loading: boolean;
  viewRef: RefObject<EditorView | null>;
  editorRef: RefObject<HTMLDivElement | null>;
}

export function useDocumentView({ spec, active, loading, viewRef, editorRef }: Opts) {
  const [viewMode, setViewMode] = useState<ViewMode>(spec.defaultMode);

  // Split pane
  const [splitRatio, setSplitRatio] = useState(50);

  // 大纲开关：记住上次状态（localStorage，首用默认展示——用户拍板）。
  // 旧注释「默认收起：短文档开着白占地方」被使用习惯推翻：用户要打开即在。
  const [showOutline, setShowOutline] = useState<boolean>(() => readOutlinePref());
  const toggleOutline = useCallback(() => {
    setShowOutline((v) => {
      writeOutlinePref(!v);
      return !v;
    });
  }, []);

  // 专注模式（P1-3）：chrome 全隐藏 + 居中纸张；Esc 两级取消在键盘 effect 裁决
  const { focusMode, toastVisible, exit: exitFocus, toggle: toggleFocus } = useFocusMode();

  // 预览重试 key：PreviewErrorBoundary 的「重试预览」靠递增它强制重挂载预览组件
  const [previewRetryKey, setPreviewRetryKey] = useState(0);
  const retryPreview = useCallback(() => setPreviewRetryKey((k) => k + 1), []);

  /**
   * 内容层入场动画的**踢号**（#15「视图模式切换」+ 页签切换共用一条动效）。
   *
   * `0` = 不在播；`>0` = 正在播第 N 场。奇偶决定挂 `.contentEnterA` 还是
   * `.contentEnterB` —— 两段 keyframes 逐字节相同，交替只为让 `animation-name`
   * 变化，否则上一场还没结束时连点第二次不会重启（同名 animation 重新挂类不重播）。
   *
   * ❗ 为什么不能直接给 `.editorBody` / `.previewBody` 写死 `animation`：
   * 多标签保活下非活动标签是 `display: none`，而 **CSS 动画在 `display` 恢复时
   * 会重播** —— 于是每次切标签回来，内容区都要重新「淡入 + 上浮」一遍，用户
   * 观感是「切个页签像重新加载了一次」。纯 CSS 分不清「display 恢复」与
   * 「真挂载」，所以改由这里显式驱动，且**播完就摘掉标记**：非活动期间标记
   * 必然为空，恢复显示时无动画可重播（这条比「干脆不触发」更强，也更难写错）。
   * 每个标签各自持有一份，互不干扰。
   *
   * ❗ 触发条件是「`viewMode` 变化」**或**「本标签被激活（false→true）」——
   * 后者就是页签切换。两者都走同一条动效，语义都是「一片新内容进来了」。
   *
   * ❗ 用 `useLayoutEffect` 而不是 `useEffect`：后者在 paint 之后才跑，会先画出
   * 「没有动画」的一帧再补上，表现为一次可见的闪动（首帧除外——初始踢号就非 0）。
   */
  const [paneKick, setPaneKick] = useState(1); // 首帧也播一场，保留原来的入场观感
  const prevModeRef = useRef(viewMode);
  const prevActiveRef = useRef(active);
  useLayoutEffect(() => {
    const modeChanged = prevModeRef.current !== viewMode;
    const becameActive = !prevActiveRef.current && active;
    prevModeRef.current = viewMode;
    prevActiveRef.current = active;
    if (!modeChanged && !becameActive) return;
    setPaneKick((k) => k + 1);
  }, [viewMode, active]);
  useEffect(() => {
    if (paneKick === 0) return;
    // 标记留得比动画略长，别让动画播到一半被摘掉
    const t = window.setTimeout(() => setPaneKick(0), CONTENT_ENTER_MS + 40);
    return () => window.clearTimeout(t);
  }, [paneKick]);

  const previewScrollRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  /** 滚动同步的“谁在驱动”时间窗（防回声，详见 syncScroll） */
  const scrollSyncLock = useRef<{ side: "editor" | "preview"; until: number } | null>(null);

  // 编辑区从隐藏（仅预览）恢复显示时，请求 CodeMirror 重新测量布局，
  // 避免 display:none 期间尺寸为 0 导致恢复后行高/槽宽渲染异常。
  // 多标签：从别的标签切回来走的是同一条路径（本标签期间被 display:none 隐藏）。
  useEffect(() => {
    if (!active) return;
    if (viewMode !== "preview") {
      viewRef.current?.requestMeasure();
    }
    // viewRef 来自 useCodeMirrorEditor，eslint 认不出它是稳定 ref，故显式列入（身份恒定，不会多跑）
  }, [viewMode, viewRef, active]);

  /**
   * 双向滚动同步。两个旧 bug：
   *
   * ❌ 用 requestAnimationFrame 清除“正在同步”标记——拦不住回声。
   * 浏览器的 scroll 事件在**下一帧开始**才派发，而 rAF 回调在**本帧结束前**就跑了；
   * 标记先被清掉，程序化 scrollTop 触发的回声事件会被当成用户滚动反向同步回去。
   * 两次比例换算各取整一点，来回几次就累积漂移——“越滚越对不上”。
   * 改成时间窗：谁先滚谁在窗口内说话，另一侧的回声一律忽略。
   *
   * ❌ 旧实现还在 null 检查**之前**就置了标记：两个 ref 有一个为 null 时直接 return，
   * 标记永远留着，此后所有滚动同步全部失效。现在先拿到元素、再上锁。
   */
  const syncScroll = useCallback((side: "editor" | "preview") => {
    const editorEl = editorRef.current?.querySelector(".cm-scroller");
    const previewEl = previewScrollRef.current;
    if (!editorEl || !previewEl) return;
    const now = Date.now();
    const lock = scrollSyncLock.current;
    // 另一侧正在驱动同步 → 本次是它的回声，丢掉
    if (lock && lock.side !== side && now < lock.until) return;
    scrollSyncLock.current = { side, until: now + SCROLL_SYNC_ECHO_MS };
    const [src, dst] = side === "editor" ? [editorEl, previewEl] : [previewEl, editorEl];
    const ratio = src.scrollTop / (src.scrollHeight - src.clientHeight || 1);
    dst.scrollTop = ratio * (dst.scrollHeight - dst.clientHeight);
    // editorRef 来自 useCodeMirrorEditor，eslint 认不出它是稳定 ref，故显式列入
  }, [editorRef]);

  const handleEditorScroll = useCallback(() => syncScroll("editor"), [syncScroll]);
  const handlePreviewScroll = useCallback(() => syncScroll("preview"), [syncScroll]);

  // Attach scroll listeners（spec.scrollSync 为 true 才挂载）。
  // 依赖数组必须带 loading：从外部文件打开时 loading 初始为 true，渲染函数会提前 return 只出
  // 一个“加载中”占位（editorPane/previewPane 都不渲染），此时两个 ref 都是 null，这里
  // 挂不上任何监听器；loadFile 完成后 loading 才变 false、真正的编辑区/预览区才挂载。
  // 不把 loading 放进依赖数组，这个 effect 就只在第一次（ref 全是 null）跑一次，
  // 之后再也不会重跑，滚动同步从此失效——正是“从外部 md 文件打开”才复现、
  // 从卡片内容打开不复现的原因（后者 initFilePath 为空，loading 从一开始就是 false，
  // 首次渲染就直接是完整 UI，没有这个提前 return 的中间态）。
  useEffect(() => {
    // active：非活动标签的方向键不在这份文档上，滚动同步无意义，且监听本身是常驻开销
    if (!spec.scrollSync || !active) return;
    const editorScroller = editorRef.current?.querySelector(".cm-scroller");
    const previewEl = previewScrollRef.current;
    if (editorScroller) editorScroller.addEventListener("scroll", handleEditorScroll);
    if (previewEl) previewEl.addEventListener("scroll", handlePreviewScroll);
    return () => {
      if (editorScroller) editorScroller.removeEventListener("scroll", handleEditorScroll);
      if (previewEl) previewEl.removeEventListener("scroll", handlePreviewScroll);
    };
    // editorRef 同上：来自 hook，eslint 要求列入（稳定 ref，不影响重跑时机）
  }, [handleEditorScroll, handlePreviewScroll, viewMode, spec.scrollSync, loading, editorRef, active]);

  // ─── Resize drag ────────────────────────────────────
  // 分屏比例的参照系是 .splitWrap（编辑+把手+预览），**不含大纲栏**——
  // 否则大纲打开时 50% 意味着「编辑占整条 main 的一半」，预览被压得明显更窄。
  const splitWrapRef = useRef<HTMLDivElement>(null);
  const handleResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    // Pointer Capture：捕获后即使光标扫过预览 iframe（HTML 沙箱），
    // move/up 仍派发给把手。旧实现 mousemove 挂 window，iframe 吞事件
    // 导致拖动「卡住→突然漂移」。
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 指针已释放等边界：退化为不捕获，拖拽仍可用 */
    }
    isDragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const handleResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging.current || !splitWrapRef.current) return;
    const rect = splitWrapRef.current.getBoundingClientRect();
    // 把手 6px：按「把手中心对准光标」折算，按下瞬间不跳 3px
    const pct = ((e.clientX - rect.left - 3) / (rect.width - 6)) * 100;
    setSplitRatio(Math.min(70, Math.max(30, pct)));
  }, []);

  const handleResizeEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging.current) return;
    isDragging.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 已释放则忽略 */
    }
  }, []);

  return {
    viewMode,
    setViewMode,
    splitRatio,
    splitWrapRef,
    handleResizeStart,
    handleResizeMove,
    handleResizeEnd,
    showOutline,
    toggleOutline,
    focusMode,
    toastVisible,
    exitFocus,
    toggleFocus,
    previewRetryKey,
    retryPreview,
    previewScrollRef,
    /** 内容层入场动画踢号（见上方 paneKick 的说明；0 = 不播，奇偶选 A/B 段） */
    paneKick,
  };
}

/** 视图态 hook 的返回形状（渲染层按接口消费，避免 `ReturnType` 到处推导） */
export type DocumentViewApi = ReturnType<typeof useDocumentView>;
