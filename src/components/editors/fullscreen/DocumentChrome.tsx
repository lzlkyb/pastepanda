/**
 * 单份文档的渲染层：工具栏 → 标签栏插槽 → 格式栏 → 主体 → 状态栏 → 专注浮层。
 *
 * 从 `FullscreenEditor.tsx`（原 1061 行）抽出的第三块。结构与类名**逐字搬移**——
 * 那几个类名有专门的守卫测试（`src/__tests__/fullscreenShell.test.tsx` 的注释里
 * 记着「类名断言必须带哈希后缀或改用子串匹配」的踩坑），抽取时最容易犯的错
 * 不是逻辑错，而是漏搬某个 class（`styles.X` 指向不存在的 key 只得到 `undefined`，
 * tsc 与 vitest 都发现不了，页面表现为样式凭空消失）。
 *
 * ❗ 标签栏插槽位置：设计稿定的是「工具栏之下、格式栏之上」。所以它由宿主
 * 作为 `tabBar` 节点传入，插在 EditorToolbar 之后。宿主只把它传给**活动标签**
 * ——否则 N 个标签会渲染 N 份标签栏（非活动的虽然被 display:none 藏住，
 * 但切换标签要滚入可见的那份可能正藏在别层里）。
 */
import { useMemo, useRef, type ReactNode } from "react";
import { Suspense } from "react";
import { MarkdownOutline, type OutlineHeading } from "./MarkdownOutline";
import { EditorToolbar } from "./EditorToolbar";
import { EditorStatusBar, type CursorInfo } from "./EditorStatusBar";
import { PaneHeader, PreviewPaneHeader } from "./PaneHeader";
import { FocusChrome } from "./FocusChrome";
import { PreviewErrorBoundary } from "./PreviewErrorBoundary";
import type { DocumentFileApi } from "./useDocumentFile";
import type { DocumentViewApi } from "./useDocumentView";
import type { EditorPrefs } from "./useEditorPrefs";
import type { FullscreenTypeSpec, ShellBridge } from "./types";
import styles from "../FullscreenEditor.module.css";

interface DocumentChromeProps {
  spec: FullscreenTypeSpec;
  file: DocumentFileApi;
  view: DocumentViewApi;
  prefs: EditorPrefs;
  bridge: ShellBridge;
  editorRef: React.RefObject<HTMLDivElement | null>;
  outlineHeadings: OutlineHeading[];
  outlineActiveSlug: string | null;
  onOutlineJump: (h: OutlineHeading) => void;
  /** B4 光标（仅预览时为 null，状态栏整组不渲染） */
  cursor: CursorInfo | null;
  isFullscreen: boolean;
  onFullscreenToggle: () => void;
  onMinimize: () => void;
  /** 关闭当前标签（守卫由宿主裁决） */
  onClose: () => void;
  /** 标签栏插槽（宿主渲染，插在工具栏之下） */
  tabBar?: ReactNode;
}

export function DocumentChrome({
  spec,
  file,
  view,
  prefs,
  bridge,
  editorRef,
  outlineHeadings,
  outlineActiveSlug,
  onOutlineJump,
  cursor,
  isFullscreen,
  onFullscreenToggle,
  onMinimize,
  onClose,
  tabBar,
}: DocumentChromeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { viewMode, setViewMode, splitRatio, focusMode, paneKick } = view;

  /** 内容层入场动画类：0 = 不播；奇偶交替挂 A/B，让连点也能重播（见 paneKick 的说明）。
   *  ❗ 挂在 `.editorBody` / `.previewBody`（面板内的**透明**内容层）上，
   *  而不是面板本身 —— 面板是不透明载体，淡它会把 --app-bg 透上来。 */
  const enterCls =
    paneKick === 0 ? "" : paneKick % 2 === 1 ? styles.contentEnterA : styles.contentEnterB;

  const stats = useMemo(() => {
    const text = file.text;
    const lines = text.split("\n").length;
    // 字数：中日韩按**字**计，拉丁文按**词**计。
    // ❌ 不能只用 \b\w+\b：中文没有词边界，一整段中文会被数成 1 词；
    // 也不能只看字符数：它把标点、空格、Markdown 标记全算进去了。
    const cjk = (text.match(/[一-鿿぀-ヿ가-힯]/g) || []).length;
    const latin = (text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
    const words = cjk + latin;
    // 阅读时长按 300 字/分（中文常用口径）；不足 1 分钟也显示 1，
    // 显示「0 分钟」比不显示更无用。
    const readMin = words === 0 ? 0 : Math.max(1, Math.round(words / 300));
    return { lines, words, readMin };
  }, [file.text]);

  const hasPreview = !!spec.Preview;

  return (
    <>
      {/* Toolbar（deep 拖拽区：按住文件名/图标/空白处可移动窗口，按钮自动豁免） */}
      <EditorToolbar
        icon={spec.icon}
        fileName={file.fileName}
        currentFilePath={file.currentFilePath}
        isDirty={file.isDirty}
        isSaving={file.isSaving}
        dynamicLanguage={!!spec.dynamicLanguage}
        languageName={file.languageName}
        onLanguageChange={file.setLanguageName}
        modes={spec.modes}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        showOutlineButton={spec.key === "markdown"}
        showOutline={view.showOutline}
        onToggleOutline={view.toggleOutline}
        isFullscreen={isFullscreen}
        onFullscreenToggle={onFullscreenToggle}
        onMinimize={onMinimize}
        onReload={() => void file.handleReloadFromDisk()}
        onOpen={() => void file.handleOpen()}
        onSave={() => void file.handleSave()}
        onClose={onClose}
        onFocusMode={view.toggleFocus}
      />

      {/* 标签栏（宿主渲染，仅活动标签收到） */}
      {tabBar}

      {/* Format Bar（类型专属，无则不渲染）。B5：仅预览模式整栏隐藏——
          预览态不可编辑，按钮全无意义，留着就是「点了没反应」的变体。 */}
      {spec.FormatBar && viewMode !== "preview" && (
        <div className={styles.formatBar}>
          <spec.FormatBar bridge={bridge} />
        </div>
      )}

      {/* Main Content */}
      <div className={styles.main} ref={containerRef}>
        {/* 专注模式隐藏大纲侧栏（条件渲染而非 CSS：MarkdownOutline 自带模块类，外层 CSS 钩不到） */}
        {spec.key === "markdown" && view.showOutline && !focusMode && (
          <MarkdownOutline
            headings={outlineHeadings}
            activeSlug={outlineActiveSlug}
            onJump={onOutlineJump}
          />
        )}
        {/* 分屏对（编辑+把手+预览）：splitRatio 的参照系——不含左侧大纲栏，
            保证「各占一半」是真的各占一半（2026-09-21 用户反馈占比不等 + 拖拽漂移） */}
        <div className={styles.splitWrap} ref={view.splitWrapRef}>
          {/* Editor Pane — 始终挂载，仅预览时用 display:none 隐藏而非卸载。
              若条件卸载，CodeMirror 视图会随 DOM 移除而脱离文档，切回分屏时
              新建的空 div 不会被重新填充（初始化 effect 仅依赖 loading），导致编辑区被清空。 */}
          <div
            className={styles.editorPane}
            /* ui-rule-ok: flex/display 必须由 JS 按实时分屏比例与专注态裁决（inline 优先级高于样式表） */
            style={{
              /* 专注模式：居中限宽纸张（inline flex 覆盖分屏比例；退出后原样恢复）。
                 inline style 优先级高于样式表，所以这里必须在 JS 里裁决。 */
              flex: focusMode ? "0 1 760px" : viewMode === "split" ? `0 0 ${splitRatio}%` : "1",
              display: viewMode === "preview" && !focusMode ? "none" : undefined,
            }}
          >
            {/* P0-2 面板身份：用户语言替代「编辑」灰字。
                有预览的类型用「X 源文」与预览面板对仗（csv 显式「CSV 源文」）；
                无预览的类型（纯文本/代码等）只有一个面板，直接显示类型名。 */}
            <PaneHeader
              label={spec.editorPaneLabel ?? (spec.Preview ? `${spec.label} 源文` : spec.label)}
            />
            <div
              className={`${styles.editorBody}${enterCls ? ` ${enterCls}` : ""}`}
              ref={editorRef}
            />
          </div>

          {/* Resize Handle */}
          {viewMode === "split" && hasPreview && (
            <div
              className={styles.resizeHandle}
              onPointerDown={view.handleResizeStart}
              onPointerMove={view.handleResizeMove}
              onPointerUp={view.handleResizeEnd}
              onPointerCancel={view.handleResizeEnd}
            />
          )}

          {/* Preview Pane */}
          {viewMode !== "edit" && hasPreview && spec.Preview && (
            <div
              className={styles.previewPane}
              /* split 模式弹性填充剩余空间（100% − 编辑宽 − 6px 把手）：
                 若与编辑面板同为 0 0 X%，三者总宽超出 .main 被 overflow:hidden 裁剪，
                 贴右边缘的预览滚动条会被裁掉大半 */
              /* ui-rule-ok: flex 值随 viewMode 实时切换，同上必须走 inline */
              style={{ flex: viewMode === "split" ? "1 1 0" : "1" }}
            >
              <PreviewPaneHeader
                label={spec.previewPaneLabel ?? "预览"}
                subLabel={spec.previewSubLabel}
                showLineNumbersToggle={spec.key === "markdown"}
                lineNumbersOn={prefs.previewLineNumbers}
                onToggleLineNumbers={prefs.togglePreviewLineNumbers}
              />
              <div
                className={`${styles.previewBody} ${spec.previewFill ? styles.previewBodyFill : ""}${
                  enterCls ? ` ${enterCls}` : ""
                }`}
                ref={view.previewScrollRef}
              >
                <Suspense fallback={<div className={styles.previewLoading}>预览加载中…</div>}>
                  {/* 守护-1：预览组件渲染期抛错不能白屏 —— 边界兜住给「重试 / 显示源码」 */}
                  <PreviewErrorBoundary
                    onRetry={view.retryPreview}
                    onShowSource={() => setViewMode("edit")}
                  >
                    <spec.Preview
                      key={view.previewRetryKey}
                      text={file.text}
                      bridge={bridge}
                      lineNumbers={prefs.previewLineNumbers}
                      baseDir={file.docDir}
                    />
                  </PreviewErrorBoundary>
                </Suspense>
              </div>
            </div>
          )}
        </div>{/* /splitWrap */}
      </div>

      {/* Status Bar */}
      <EditorStatusBar
        lines={stats.lines}
        words={stats.words}
        readMin={stats.readMin}
        isDirty={file.isDirty}
        isSaving={file.isSaving}
        autoSaveError={file.autoSaveError}
        typeLabel={spec.dynamicLanguage ? (file.languageName ?? "纯文本") : spec.label}
        cursor={viewMode === "preview" ? null : cursor}
        onSaveRetry={() => void file.handleSave()}
      />

      {/* 专注模式浮层 chrome（迷你工具栏/保存钉/toast；chrome 本体由 .focusMode CSS 隐藏） */}
      {focusMode && (
        <FocusChrome
          icon={spec.icon}
          fileName={file.fileName}
          isDirty={file.isDirty}
          isSaving={file.isSaving}
          autoSaveError={file.autoSaveError}
          onSave={() => void file.handleSave()}
          onExit={view.exitFocus}
          toastVisible={view.toastVisible}
        />
      )}
    </>
  );
}
