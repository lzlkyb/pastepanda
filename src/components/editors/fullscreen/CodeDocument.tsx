/**
 * CodeDocument —— CodeMirror 单栏族的**单份文档视图**
 * （markdown / json / html / text / csv / log / code）。
 *
 * 它就是原来的 `FullscreenInner`：把「窗口 + 文档」双重职责里的**文档**那一半
 * 留下来，窗口层（标签栏、窗口级主题/全屏态、多标签关闭守卫）全部上提到
 * `FullscreenEditor`（TabHost）。拆分的动因是规则 7 的体量红线（原文件 1061 行），
 * 逻辑与注释逐块搬移。
 *
 * 与宿主的三条上行通道（都用 ref 中转，避免宿主闭包每渲染换引用导致 effect 重跑）：
 *   - `onRequestClose`：工具栏 ✕ / Esc → 请宿主裁决守卫（脏标签要统一列清单）
 *   - `onMeta`：文件名/脏/保存态/专注模式 → 标签栏渲染依据
 *   - `registerSave`：把「关闭前保存」注册给宿主，供关窗时逐项调用
 *
 * ❗ `active` 门控（规则 8.2）：多标签下每个标签都活着，非活动标签必须停掉
 * 常驻监听 —— 磁盘轮询（useFileWatch）、滚动同步（useDocumentView）、
 * 大纲跟随（useOutlineSpy）、窗口级键盘响应（本文件的 keydown）。
 * 自动保存**不在此列**：切走不等于不用保存，停掉就是把「保活」变「保丢」。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useToast } from "@/components/Toast";
import { useLatest } from "@/hooks/useLatest";
import { SkinScene } from "@/components/SkinScene";
import { useCodeMirrorEditor } from "../useCodeMirrorEditor";
import { useOutlineJump } from "../useOutlineJump";
import { useOutlineSpy } from "../useOutlineSpy";
import { resolveFullscreenType } from "./registry";
import { useEditorPrefs } from "./useEditorPrefs";
import { useDocumentFile } from "./useDocumentFile";
import { useDocumentView } from "./useDocumentView";
import { DocumentChrome } from "./DocumentChrome";
import { scanHeadings, type OutlineHeading } from "./MarkdownOutline";
import { loadLanguageSupport } from "./languages";
import type { CursorInfo } from "./EditorStatusBar";
import type { TabMeta } from "@/lib/editorTabs";
import styles from "../FullscreenEditor.module.css";

export interface CodeDocumentProps {
  sourceId: string | null;
  initContent: string | null;
  initFilePath: string | null;
  contentType: string | null;
  /** 语言提示（自动标签派生），仅 code 类型消费 */
  initLanguage: string | null;
  /** 本标签是否为当前活动标签 */
  active: boolean;
  /** 主题明暗（宿主统一判定后下发，见 useEditorPrefs 顶部注释） */
  darkMode: boolean;
  isFullscreen: boolean;
  onFullscreenToggle: () => void;
  onMinimize: () => void;
  /** 请求关闭本标签（守卫由宿主裁决） */
  onRequestClose: () => void;
  onMeta: (meta: TabMeta) => void;
  /** 注册「关闭前保存」；传 null 注销 */
  registerSave: (fn: (() => Promise<boolean>) | null) => void;
  /** 标签栏插槽（宿主渲染，插在工具栏之下） */
  tabBar?: ReactNode;
}

export function CodeDocument({
  sourceId,
  initContent,
  initFilePath,
  contentType,
  initLanguage,
  active,
  darkMode,
  isFullscreen,
  onFullscreenToggle,
  onMinimize,
  onRequestClose,
  onMeta,
  registerSave,
  tabBar,
}: CodeDocumentProps) {
  const { toast } = useToast();

  // 类型规格：按 contentType 查表（未知/缺省回退 markdown）。本实例生命周期内固定。
  const spec = useMemo(() => resolveFullscreenType(contentType), [contentType]);
  const prefs = useEditorPrefs();

  // 宿主给的三个闭包每次渲染换引用 → 用 useLatest 中转，不放进依赖数组
  const closeRef = useLatest(onRequestClose);
  const metaRef = useLatest(onMeta);
  const registerRef = useLatest(registerSave);

  const file = useDocumentFile({
    sourceId,
    initContent,
    initFilePath,
    initLanguage,
    spec,
    active,
    autoSaveEnabled: prefs.autoSaveEnabled,
    onFatal: () => closeRef.current(),
  });

  // B4 光标定位：仅编辑/分屏有光标；仅预览置 null 让状态栏不渲染该组
  const [cursor, setCursor] = useState<CursorInfo>({ line: 1, col: 1, selLen: 0 });
  /**
   * 保存命令的「现取」口。handleSave / handleSaveAs 来自 useDocumentFile，
   * 而 hook 要在这里就拿到快捷键回调，故用 ref 中转（原因同 useCodeMirrorEditor 内部的 hostRef）。
   */
  const saveCmdsRef = useRef({ save: () => {}, saveAs: () => {} });

  // ─── CodeMirror 内核（装配 + 主题/语言舱 + 全套编辑命令）───
  const { editorRef, viewRef, bridge, jumpToLine, reconfigureLanguage } = useCodeMirrorEditor({
    initialText: file.initialContent,
    ready: !file.loading,
    isDark: darkMode,
    text: file.text,
    language: spec.language,
    dynamicLanguage: spec.dynamicLanguage,
    insertPastedImages: file.handlePastedImages,
    onDocChange: file.handleDocChange,
    onSave: () => saveCmdsRef.current.save(),
    onSaveAs: () => saveCmdsRef.current.saveAs(),
    onCursorChange: setCursor,
  });

  // 每次渲染把最新实现写进 ref，供 CodeMirror 快捷键现取
  // （粗体/斜体已在 hook 内部直接接 insertFormat，不必再经这里转一手）
  saveCmdsRef.current = {
    save: () => void file.handleSave(),
    saveAs: () => void file.handleSaveAs(),
  };

  const view = useDocumentView({ spec, active, loading: file.loading, viewRef, editorRef });

  // ─── 大纲（markdown 专属）─────────────────────────────
  /**
   * 大纲点击分派：编辑→CM；预览→DOM#slug；分屏→两侧都跳。
   * 策略在 useOutlineJump（规则 #7，本文件已超 300 行）。
   * 点选即置当前节（与 scrollspy 共用同一个 state）：跳转引发的滚动随后被
   * spy 接管覆盖，落点一致，不会出现「高亮卡在点过的旧项」。
   */
  const hasPreviewSpec = !!spec.Preview;
  const handleOutlineJumpBase = useOutlineJump({
    viewMode: view.viewMode,
    jumpToLine,
    previewScrollRef: view.previewScrollRef,
    hasPreview: hasPreviewSpec,
    onJumpFail: (h) => toast(`预览中未找到标题「${h.text}」`, "error"),
  });

  // markdown 标题表：大纲与 scrollspy（useOutlineSpy）共用一份，避免重复扫描
  const isMarkdown = spec.key === "markdown";
  const outlineHeadings = useMemo(
    () => (isMarkdown ? scanHeadings(file.text) : []),
    [isMarkdown, file.text],
  );

  // 滚动跟随（scrollspy）：内容滚动 → 大纲高亮当前节 + 列表自动滚到可见。
  // 大纲收起 / 专注模式 / **本标签不在前台**时不必算（enabled=false 卸载监听）。
  const { activeSlug: outlineActiveSlug, setActiveSlug: setOutlineActive } = useOutlineSpy({
    enabled: isMarkdown && view.showOutline && !view.focusMode && active,
    viewMode: view.viewMode,
    headings: outlineHeadings,
    viewRef,
    editorRef,
    previewScrollRef: view.previewScrollRef,
    loading: file.loading,
  });

  // 点选即置当前节（与 spy 共用同一个 state，滚动会被 spy 覆盖，不会卡旧项）
  const handleOutlineJump = useCallback(
    (h: OutlineHeading) => {
      setOutlineActive(h.slug);
      handleOutlineJumpBase(h);
    },
    [handleOutlineJumpBase, setOutlineActive],
  );

  // ─── code 类型：动态语言模式加载 ─────────────────────
  // 放在这里（而不是 useDocumentFile）的原因见那边留下的说明：本 effect 要用
  // reconfigureLanguage（useCodeMirrorEditor 的产物），而那个 hook 依赖本 hook 的
  // text/loading，放进 useDocumentFile 会成环。
  useEffect(() => {
    if (!spec.dynamicLanguage || file.loading) return;
    if (!file.languageName) {
      reconfigureLanguage(null);
      return;
    }
    let cancelled = false;
    loadLanguageSupport(file.languageName)
      .then((support) => {
        if (cancelled) return;
        reconfigureLanguage(support ?? null);
      })
      .catch(() => { /* 加载失败保持纯文本模式 */ });
    return () => { cancelled = true; };
  }, [file.languageName, file.loading, spec.dynamicLanguage, reconfigureLanguage]);

  // ─── 键盘快捷键 ─────────────────────────────────────
  const { toggleFocus, exitFocus, focusMode } = view;
  useEffect(() => {
    // 非活动标签不响应窗口级快捷键 —— 否则按一次 Esc，12 个标签都会各自弹守卫
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      // 专注模式开关（稿子 P1-3：⋯ 菜单与快捷键双入口）
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        toggleFocus();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // 两级取消：专注态的第一次 Esc 只回普通模式，绝不直接动到关闭守卫
        if (focusMode) {
          exitFocus();
          return;
        }
        onRequestClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active, toggleFocus, exitFocus, focusMode, onRequestClose]);

  // ─── 上行：元信息 / 关闭前保存注册 ───────────────────
  useEffect(() => {
    metaRef.current({
      fileName: file.fileName,
      icon: spec.icon,
      isDirty: file.isDirty,
      isSaving: file.isSaving,
      tabError: file.autoSaveError,
      // CodeMirror 族的**每一种**都有保存路径：卡片回写 DB、文件写盘、
      // 未命名则另存为。所以这里恒真 —— 与 diff 全屏（无落盘目标）相反。
      canSave: true,
      focusMode: view.focusMode,
    });
  }, [
    file.fileName,
    spec.icon,
    file.isDirty,
    file.isSaving,
    file.autoSaveError,
    view.focusMode,
    // useLatest 返回的 ref 身份恒定，列进来只为满足 exhaustive-deps
    // （eslint 只把 `useRef` 直接结果当已知 ref，自定义 hook 不识）
    metaRef,
  ]);

  // 注册「关闭前保存」。宿主拿到的始终是这个**稳定包装**，它在调用时才去取
  // 当前渲染对应的实现 —— 所以本 effect 只需注册一次，不必随每次按键重注册。
  // （不能直接把 `file.saveForClose` 放进依赖数组：它每次文本变化都换引用，
  //   而 `file` 本身每次渲染都是新对象，列 `file` 会导致每个按键都解绑重绑。）
  const saveForCloseRef = useLatest(file.saveForClose);
  useEffect(() => {
    const register = registerRef.current;
    register(() => saveForCloseRef.current());
    return () => register(null);
  }, [registerRef, saveForCloseRef]);

  // ─── Render ─────────────────────────────────────────
  if (file.loading) {
    return (
      <div className={styles.overlay}>
        <div className={styles.loading}>加载中…</div>
      </div>
    );
  }

  return (
    <div
      className={`${styles.overlay} ${view.focusMode ? styles.focusMode : ""}`}
      data-theme-mode={darkMode ? "dark" : "light"}
    >
      {/* 皮肤场景层：fixed z-0，衬于工具栏/编辑区（z-1）之后，
          主题场景从透明 header（--header-bg-start: transparent）透出 */}
      <SkinScene />
      <DocumentChrome
        spec={spec}
        file={file}
        view={view}
        prefs={prefs}
        bridge={bridge}
        editorRef={editorRef}
        outlineHeadings={outlineHeadings}
        outlineActiveSlug={outlineActiveSlug}
        onOutlineJump={handleOutlineJump}
        cursor={cursor}
        isFullscreen={isFullscreen}
        onFullscreenToggle={onFullscreenToggle}
        onMinimize={onMinimize}
        onClose={onRequestClose}
        tabBar={tabBar}
      />
    </div>
  );
}
