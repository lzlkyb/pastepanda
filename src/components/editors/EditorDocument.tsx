/**
 * EditorDocument —— 一个标签的「文档视图」容器：按内容类型分派 + 保活。
 *
 * 保活（路线 A）是本次改造的核心取舍：非活动标签**不卸载**，只把外层容器
 * `display: none`。理由 —— 卸载再重建会让编辑器最重要的肌肉记忆（Ctrl+Z 撤销
 * 历史）断掉，滚动位置与折叠态也要手工重记；而 CodeMirror 的 state 常驻一份
 * 的代价远小于「切回来发现全没了」。
 *
 * ❗ `display: none` 能隐藏 `position: fixed` 的后代：display:none 的元素整棵
 * 子树都不生成盒子，与定位方式无关。所以这里不需要（也不该）改 `.overlay`
 * 的定位方式 —— 它是相对视口全屏的，非活动时被本层藏住即可。
 */
import { Suspense, lazy, type ReactNode } from "react";
import type { TabMeta } from "@/lib/editorTabs";
import { CodeDocument } from "./fullscreen/CodeDocument";
import type { EditorTab } from "./fullscreen/useEditorTabs";
import styles from "./FullscreenEditor.module.css";

/** 图文混排全屏（Tiptap）——惰加载：其它类型全屏不应为此多拉一份富文本库 */
const LazyRichFullscreen = lazy(() =>
  import("./fullscreen/RichFullscreen").then((m) => ({ default: m.RichFullscreen }))
);
/** 流程图全屏（React Flow）——惰加载：独立 OS 窗口，绕开 CodeMirror 路径 */
const LazyDiagramFullscreen = lazy(() =>
  import("./DiagramFullscreen").then((m) => ({ default: m.DiagramFullscreen }))
);
/** 文本对比全屏（双栏 diff）——惰加载：独立 OS 窗口，绕开 CodeMirror 单栏路径 */
const LazyDiffFullscreen = lazy(() =>
  import("./DiffEditorFullscreen").then((m) => ({ default: m.DiffEditorFullscreen }))
);

export interface EditorDocumentProps {
  tab: EditorTab;
  /** 本标签是否为当前活动标签（非活动 = 藏起来但活着） */
  active: boolean;
  /** 主题明暗（宿主统一判定，见 useEditorPrefs 顶部注释） */
  darkMode: boolean;
  isFullscreen: boolean;
  onFullscreenToggle: () => void;
  onMinimize: () => void;
  /** 请求关闭本标签（守卫由宿主裁决） */
  onRequestClose: () => void;
  onMeta: (meta: TabMeta) => void;
  registerSave: (fn: (() => Promise<boolean>) | null) => void;
  /** 标签栏（宿主只发给活动标签） */
  tabBar?: ReactNode;
}

export function EditorDocument({
  tab,
  active,
  darkMode,
  isFullscreen,
  onFullscreenToggle,
  onMinimize,
  onRequestClose,
  onMeta,
  registerSave,
  tabBar,
}: EditorDocumentProps) {
  const slots = {
    active,
    darkMode,
    isFullscreen,
    onFullscreenToggle,
    onMinimize,
    onRequestClose,
    /** 壳的 onClose 与 onRequestClose 在宿主模式下是同一个出口：
     *  Shell 的 guardedClose 优先走 onRequestClose（守卫上提），
     *  onClose 只是「壳自管」路径的兜底，两条路都落到宿主的 requestCloseTab。 */
    onClose: onRequestClose,
    onMeta,
    registerSave,
    topExtra: tabBar,
  };
  const ct = tab.contentType;

  return (
    <div className={active ? undefined : styles.tabPaneHidden}>
      {ct === "rich" ? (
        <Suspense fallback={<DocumentLoading />}>
          <LazyRichFullscreen
            sourceId={tab.sourceId}
            initContent={tab.content}
            {...slots}
          />
        </Suspense>
      ) : ct === "diagram" ? (
        <Suspense fallback={<DocumentLoading />}>
          <LazyDiagramFullscreen
            sourceId={tab.sourceId}
            initContent={tab.content}
            {...slots}
          />
        </Suspense>
      ) : ct === "diff" ? (
        <Suspense fallback={<DocumentLoading />}>
          <LazyDiffFullscreen
            sourceId={tab.sourceId}
            initContent={tab.content}
            {...slots}
          />
        </Suspense>
      ) : (
        <CodeDocument
          sourceId={tab.sourceId}
          initContent={tab.content}
          initFilePath={tab.filePath}
          contentType={tab.contentType}
          initLanguage={tab.language}
          active={active}
          darkMode={darkMode}
          isFullscreen={isFullscreen}
          onFullscreenToggle={onFullscreenToggle}
          onMinimize={onMinimize}
          onRequestClose={onRequestClose}
          onMeta={onMeta}
          registerSave={registerSave}
          tabBar={tabBar}
        />
      )}
    </div>
  );
}

/** 惰加载期间的全屏占位（与 CodeDocument 的加载态同款观感） */
function DocumentLoading() {
  return (
    <div className={styles.overlay}>
      <div className={styles.loading}>加载中…</div>
    </div>
  );
}
